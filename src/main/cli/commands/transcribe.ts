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
import { TRANSCRIPTION_DEFAULTS, ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { autoLineBreakTranscribedEntries } from '../../services/headless-layout'
import { APP_VERSION } from '../../../shared/app-info'
import type { TranscriptionStartRequest } from '../../../shared/ipc-contracts'
import type { VideoInfo, WhisperModelId } from '../../../shared/types'
import { optBool, optString, type ParsedArgs } from '../args'
import {
  CliError,
  emitProgress,
  emitSuccess,
  type CliContext,
  type CliWarning,
} from '../output'
import { detectFormat, entriesFromSegments, writeMojiokoFile, writeSrtFile, type SegmentLike } from '../subtitle-io'

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

  const track = Number.parseInt(optString(args.opts, 'track') || String(settings.defaultAudioTrackIndex ?? 1), 10)
  const advanced = { ...TRANSCRIPTION_DEFAULTS, ...settings.transcriptionAdvanced }
  const lang = optString(args.opts, 'lang')
  if (lang) advanced.language = lang
  const vad = optBool(args.opts, 'vad')
  if (vad !== undefined) advanced.vadFilter = vad
  const beam = optString(args.opts, 'beam-size')
  if (beam) advanced.beamSize = Number.parseInt(beam, 10)

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

  const warnings: CliWarning[] = []
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
