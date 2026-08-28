/**
 * REQ-0447 / spec §3.2 — `mojioko transcribe <input> -o <out>`.
 *
 * Drives the existing `transcribe()` sidecar service headlessly, accumulates
 * its `segment` events, seeds cues with the app default style, and writes a
 * `.mojioko` project (or SRT).  Device is the app's current accelerator; the
 * actual device is reported from the sidecar's `deviceInfo` event.
 */
import { existsSync } from 'node:fs'
import { transcribe, cancelTranscription } from '../../services/transcription-sidecar'
import { probeVideo } from '../../services/ffprobe'
import { checkModelInstalled } from '../../services/check-model-installed'
import { loadSettings } from '../../services/settings-store'
import { getBinPath, getModelsDir } from '../../lib/paths'
import { pickTranscriptionTrack } from '../../../shared/track-pick'
import { TRANSCRIPTION_DEFAULTS, ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { autoLineBreakTranscribedEntries } from '../../services/headless-layout'
import { APP_VERSION } from '../../../shared/app-info'
import type { TranscriptionStartRequest } from '../../../shared/ipc-contracts'
import type { VideoInfo, WhisperModelId } from '../../../shared/types'
import { optBool, optString, type ParsedArgs } from '../args'
import { assertWritable } from '../overwrite'
import {
  CliError,
  emitProgress,
  emitSuccess,
  type CliContext,
  type CliWarning,
} from '../output'
import { detectFormat, entriesFromSegments, writeMojiokoFile, writeSrtFile, type SegmentLike } from '../subtitle-io'

/**
 * REQ-0499 §2-1 — numeric option readers for the VAD tuning flags.
 *
 * Local rather than shared: `optInt` already lives in `placement.ts` for the
 * layout flags, and these three are the only float/positive-int options in the
 * CLI.  A malformed value returns `undefined` so the caller falls back to the
 * settings value rather than silently sending `NaN` to the sidecar.
 */
function optFloat(opts: ParsedArgs['opts'], key: string): number | undefined {
  const s = optString(opts, key)
  if (s === undefined || s === '') return undefined
  const n = Number.parseFloat(s)
  return Number.isFinite(n) ? n : undefined
}

function optPositiveInt(opts: ParsedArgs['opts'], key: string): number | undefined {
  const s = optString(opts, key)
  if (s === undefined || s === '') return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export async function runTranscribeCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0]
  if (!input) {
    throw new CliError('USAGE', 'input file が必要です。', 'mojioko transcribe <input> -o <out>')
  }
  if (!existsSync(input)) {
    throw new CliError('INPUT_NOT_FOUND', `入力ファイルが見つかりません: ${input}`, '入力パスを確認してください。')
  }
  const out = optString(args.opts, 'out')
  if (!out) {
    throw new CliError('USAGE', '出力パス（-o <out>）が必要です。', 'mojioko transcribe <input> -o out.mojioko')
  }
  assertWritable(out, args.opts) // REQ-0457 D13
  const format = detectFormat(out, optString(args.opts, 'format'))
  if (!format) {
    throw new CliError(
      'UNSUPPORTED_FORMAT',
      `出力フォーマットを判定できません: ${out}`,
      '.mojioko / .srt のいずれか、または --format mojioko|srt を指定してください。',
    )
  }

  const settings = await loadSettings()
  const model = (optString(args.opts, 'model') || settings.activeModelId || BURNIN_DEFAULTS.whisperModel) as WhisperModelId
  const modelsDir = getModelsDir()
  if (!checkModelInstalled(model, modelsDir).installed) {
    throw new CliError(
      'MODEL_NOT_FOUND',
      `Whisper モデル "${model}" が導入されていません。`,
      `mojioko tools download whisper --model ${model}（またはアプリで DL）。状態は \`mojioko tools\` で確認。`,
      { model },
    )
  }

  let video: VideoInfo
  try {
    video = await probeVideo(input)
  } catch (e) {
    throw new CliError('UNSUPPORTED_FORMAT', `メディアを読み取れません: ${input}`, 'サポートされた動画/音声ですか？', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  // ★ REQ-0517 §1 — resolve the audio track AGAINST THE FILE.
  //
  // This used to be `parseInt(--track || settings.defaultAudioTrackIndex ?? 1)`
  // with no reference to `video` at all.  A user who set their default to
  // Track 2 in Settings — a legitimate, supported choice — then got `-map
  // 0:a:1` on every single-track video, and ffmpeg's failure
  // (`Failed to set value '0:a:1' for option 'map'`) never mentions the track.
  // The GUI had been rounding all along (`pickTranscriptionTrack`); only the
  // headless paths had not.
  //
  // No extra probing: `probeVideo(input)` ran a few lines above and
  // `video.audioTracks` is exactly what the ladder needs, so the ffprobe count
  // for a transcribe is unchanged at one.
  //
  // The two cases are deliberately NOT treated alike:
  //
  //   - `--track N` is an explicit instruction.  If N is not in the file we
  //     REFUSE (`USAGE`) rather than quietly substituting another track —
  //     returning something other than what was asked for is the family
  //     REQ-0499 onward has been removing, and here it would mean
  //     transcribing the wrong language.
  //   - the SETTING is a preference, not an instruction, so it rounds through
  //     the shared ladder and says so in a warning.
  const trackOpt = optString(args.opts, 'track')
  const trackFallback: CliWarning[] = []
  let track: number
  if (trackOpt) {
    const asked = Number.parseInt(trackOpt, 10)
    if (!Number.isFinite(asked) || asked < 1) {
      throw new CliError('USAGE', `--track は 1 以上の整数: ${trackOpt}`, '例: --track 1')
    }
    if (!video.audioTracks.some((t) => t.index === asked)) {
      const have = video.audioTracks.map((t) => t.index).join(', ') || 'なし'
      throw new CliError(
        'USAGE',
        `--track ${asked} はこのファイルに存在しません（音声トラック: ${have}）。`,
        video.audioTracks.length > 0
          ? `--track ${video.audioTracks[0].index} など、存在する番号を指定してください。`
          : 'このファイルには音声トラックがありません。',
        { requested: asked, available: video.audioTracks.map((t) => t.index) },
      )
    }
    track = asked
  } else {
    const preferred = settings.defaultAudioTrackIndex ?? 1
    // The GUI's own ladder, not a second copy of it (REQ-0517 §1-1).
    const picked = pickTranscriptionTrack(video.audioTracks, preferred)
    if (picked.trackIndex === null) {
      throw new CliError(
        'UNSUPPORTED_FORMAT',
        `音声トラックがありません: ${input}`,
        '音声を含む動画/音声ファイルを指定してください。',
        { availableTracks: video.audioTracks.map((t) => t.index) },
      )
    }
    track = picked.trackIndex
    if (picked.fallbackUsed) {
      // REQ-0517 §1-4 — never round silently.  The caller has to be able to
      // tell "I set 2 and got 2" from "I set 2 and this file only has 1".
      trackFallback.push({
        code: 'AUDIO_TRACK_FALLBACK',
        message:
          `既定の音声トラックは ${preferred} ですが、このファイルには存在しないため ` +
          `トラック ${track} を使いました。`,
        detail: {
          preferred,
          used: track,
          available: video.audioTracks.map((t) => t.index),
          reason: '設定「デフォルト音声トラック」の番号が入力ファイルに無い場合、トラック 1 に落とします（GUI と同じ規則）。',
          remedy: `意図した音声が別なら --track で明示してください（このファイルの音声トラック: ${video.audioTracks.map((t) => t.index).join(', ')}）。`,
        },
      })
    }
  }
  const advanced = { ...TRANSCRIPTION_DEFAULTS, ...settings.transcriptionAdvanced }
  const lang = optString(args.opts, 'lang')
  if (lang) advanced.language = lang
  const vad = optBool(args.opts, 'vad')
  if (vad !== undefined) advanced.vadFilter = vad
  const beam = optString(args.opts, 'beam-size')
  if (beam) advanced.beamSize = Number.parseInt(beam, 10)
  // REQ-0499 §2-1 — these three were advertised in help AND wired all the way
  // down to the sidecar payload (`transcribe-payload.ts`), but the argv read was
  // missing, so they always took the settings value.  Same "advertised but
  // unread" family as REQ-0461's style flags.
  const vadThreshold = optFloat(args.opts, 'vad-threshold')
  if (vadThreshold !== undefined) {
    if (vadThreshold < 0 || vadThreshold > 1) {
      throw new CliError('USAGE', `--vad-threshold は 0..1 の数値: ${vadThreshold}`, '例: --vad-threshold 0.5')
    }
    advanced.vadThreshold = vadThreshold
  }
  const minSpeechMs = optPositiveInt(args.opts, 'min-speech-ms')
  if (minSpeechMs !== undefined) advanced.minSpeechDurationMs = minSpeechMs
  const minSilenceMs = optPositiveInt(args.opts, 'min-silence-ms')
  if (minSilenceMs !== undefined) advanced.minSilenceDurationMs = minSilenceMs

  const request: TranscriptionStartRequest = {
    videoPath: input,
    trackIndex: track,
    modelId: model,
    modelsDir,
    ffmpegPath: getBinPath('ffmpeg'),
    advanced,
    // Style subset the request carries (sidecar ignores it; shape required by
    // TranscriptionStartRequest). Cues are seeded from the full defaults below.
    defaults: {
      fontSizePx: settings.transcriptionDefaults.fontSizePx,
      textColorHex: settings.transcriptionDefaults.textColorHex,
      outlineColorHex: settings.transcriptionDefaults.outlineColorHex,
      outlineThicknessPx: settings.transcriptionDefaults.outlineThicknessPx,
      fadeDurationSec: settings.fadeDurationSec ?? 0,
    },
  }

  const requestedDevice = optString(args.opts, 'device')
  const strict = args.opts.strict === true

  const segments: SegmentLike[] = []
  let deviceUsed: 'cpu' | 'gpu' = settings.activeAccelerator === 'gpu' ? 'gpu' : 'cpu'
  let fellBack = false
  let detectedLanguage: string | null = null

  // REQ-0457 B6 — an MCP cancel_job stops the sidecar mid-transcribe.
  if (ctx.signal) ctx.signal.addEventListener('abort', () => { void cancelTranscription() }, { once: true })

  try {
    await transcribe(request, (ev) => {
      switch (ev.event) {
        case 'started':
          // REQ-0457 A3 — the language faster-whisper detected (if reported).
          if (typeof ev.language === 'string' && ev.language) detectedLanguage = ev.language
          break
        case 'segment':
          segments.push(ev.segment)
          break
        case 'deviceInfo':
          deviceUsed = ev.device === 'cuda' ? 'gpu' : 'cpu'
          fellBack = ev.fellBack
          break
        case 'progress':
          emitProgress(ctx, { event: 'progress', percent: ev.percent })
          break
        case 'phase':
          emitProgress(ctx, { event: 'phase', phase: ev.phase })
          break
        default:
          break
      }
    })
  } catch (e) {
    throw new CliError('TRANSCRIBE_FAILED', e instanceof Error ? e.message : String(e), '入力・モデル・実行環境（Python 依存）を確認してください。')
  }

  // --device gpu --strict: fail if we did not actually get a GPU.
  if (strict && requestedDevice === 'gpu' && deviceUsed !== 'gpu') {
    throw new CliError(
      'GPU_INIT_FAILED',
      'GPU が要求されましたが CUDA を初期化できませんでした（--strict）。',
      'GPU ツール（CUDA）を DL するか、--device cpu で実行してください。',
    )
  }

  const fontId = settings.activeFontId ?? 'noto-sans-jp-semibold'
  const rawEntries = entriesFromSegments(segments, settings.transcriptionDefaults, video, fontId, settings.fadeDurationSec ?? 0)

  // REQ-0456 §1 — auto line-break at the SOURCE video width, exactly as the GUI
  // does on transcription (`step1.tsx`), so the written `.mojioko` carries the
  // same `\N` the preview would show.  `--auto-break false|off|0|no` opts out.
  const autoBreakOff = ['false', 'off', '0', 'no'].includes((optString(args.opts, 'auto-break') || '').toLowerCase())
  const entries = autoBreakOff
    ? rawEntries
    : autoLineBreakTranscribedEntries(rawEntries, {
        videoWidthPx: video.widthPx,
        videoHeightPx: video.heightPx,
        marginLrPx: ASS_MARGIN_LR_PX,
        marginYPx: ASS_MARGIN_LR_PX,
        emphasisTierAllowed: false,
      })

  try {
    if (format === 'mojioko') {
      writeMojiokoFile({
        outPath: out,
        appVersion: APP_VERSION,
        video,
        trackIndex: track,
        entries,
        defaults: settings.transcriptionDefaults,
        whisperModel: model,
        device: deviceUsed,
      })
    } else {
      writeSrtFile(out, entries)
    }
  } catch (e) {
    throw new CliError('OUTPUT_WRITE_FAILED', `出力を書き込めません: ${out}`, '出力先の権限・空き容量・パスを確認してください。', {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  const warnings: CliWarning[] = [...trackFallback]
  if (fellBack) {
    warnings.push({ code: 'GPU_INIT_FAILED', message: 'CUDA 利用不可のため CPU にフォールバックしました。', detail: { fellBackTo: 'cpu' } })
  }

  // REQ-0457 A3 — did any cue get per-word timestamps? (the karaoke precondition)
  const hasWordTimestamps = entries.some((e) => Array.isArray(e.words) && e.words.length > 0)
  // Detected language: prefer the sidecar's detection; else, when a specific
  // language was forced (not `auto`), that IS the language; else unknown.
  const resolvedDetected = detectedLanguage ?? (advanced.language && advanced.language !== 'auto' ? advanced.language : null)

  return emitSuccess(
    ctx,
    'transcribe',
    {
      outputPath: out,
      format,
      cueCount: entries.length,
      durationSec: video.durationSec,
      requestedLanguage: advanced.language,
      // REQ-0457 A3 — actual result signals (not just the requested echo).
      detectedLanguage: resolvedDetected,
      hasWordTimestamps,
      device: deviceUsed,
      model,
    },
    warnings,
  )
}
