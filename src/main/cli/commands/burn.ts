/**
 * REQ-0447 / spec §3.4 — `mojioko burn <video> <subtitle> -o <out.mp4>`.
 *
 * Reuses `startBurnin` (ffmpeg + libass `subtitles=`, never drawtext). `.mojioko`
 * input keeps per-cue style; SRT input is seeded with the app default subtitle
 * style (font inherited, spec §11). Resolution scaling / `--preset` / overflow
 * handling are layered in a follow-up (see §9 notes); this renders at the
 * source resolution.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { startBurnin } from '../../services/ffmpeg-burnin'
import { probeVideo } from '../../services/ffprobe'
import { loadSettings } from '../../services/settings-store'
import { getBinPath } from '../../lib/paths'
import { parseProjectFile } from '../../../shared/project-file'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import { ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { canUseKeywordEmphasisInTier } from '../../../shared/emphasis'
import { isPackagedAsMsix, getCurrentProcessContext } from '../../lib/msix'
import { layoutForBurn, type OverflowMode } from '../../services/headless-layout'
import type { BurninStartRequest, EncoderSetting, AudioMode, OutputContainer } from '../../../shared/ipc-contracts'
import type { SubtitleEntry, VideoInfo } from '../../../shared/types'
import type { FontId } from '../../../shared/fonts'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitProgress, emitSuccess, type CliContext } from '../output'
import { detectFormat, entriesFromSegments } from '../subtitle-io'
import { resolveDefaultSubtitleStyle } from '../subtitle-style'
import { findStylePreset, applyStylePreset } from '../style-preset-cli'
import { assertWritable } from '../overwrite'
import { resolveTarget, contentScaleFactor, scaleEntries, scaleVideoTo } from '../scale-video'

const OVERFLOW_MODES = new Set<OverflowMode>(['warn', 'shrink', 'error'])

/** Read an integer CLI option (first non-empty of `keys`), or undefined. */
function optInt(opts: ParsedArgs['opts'], ...keys: string[]): number | undefined {
  const s = optString(opts, ...keys)
  if (s === undefined || s === '') return undefined
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

const ENCODERS = new Set(['auto', 'h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf'])
const AUDIO_MODES = new Set(['preserve', 'simple', 'none'])

export async function runBurnCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const videoPath = args.positionals[0]
  const subPath = args.positionals[1]
  if (!videoPath || !subPath) {
    throw new CliError('USAGE', 'video と subtitle が必要です。', 'mojioko burn <video> <subtitle> -o <out.mp4>')
  }
  if (!existsSync(videoPath)) throw new CliError('INPUT_NOT_FOUND', `動画が見つかりません: ${videoPath}`, '動画パスを確認してください。')
  if (!existsSync(subPath)) throw new CliError('INPUT_NOT_FOUND', `字幕が見つかりません: ${subPath}`, '字幕パスを確認してください。')
  // REQ-0457 Phase E — dry-run writes no file, so -o is optional there.
  const dryRun = args.opts['dry-run'] === true
  const out = optString(args.opts, 'out') ?? ''
  if (!out && !dryRun) throw new CliError('USAGE', '出力パス（-o <out.mp4>）が必要です。')
  if (out && !dryRun) assertWritable(out, args.opts) // REQ-0457 D13

  const subFmt = detectFormat(subPath, optString(args.opts, 'format'))
  if (!subFmt) throw new CliError('UNSUPPORTED_FORMAT', `字幕フォーマット不明: ${subPath}`, '.mojioko / .srt を指定してください。')

  const settings = await loadSettings()

  let video: VideoInfo
  try {
    video = await probeVideo(videoPath)
  } catch (e) {
    throw new CliError('UNSUPPORTED_FORMAT', `動画を読み取れません: ${videoPath}`, 'サポートされた動画ですか？', { error: e instanceof Error ? e.message : String(e) })
  }

  const fontId = (settings.activeFontId ?? 'noto-sans-jp-semibold') as FontId
  let entries: SubtitleEntry[]
  let cuts: BurninStartRequest['cuts'] = []

  if (subFmt === 'mojioko') {
    const parsed = parseProjectFile(readFileSync(subPath, 'utf-8'))
    if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
    entries = parsed.project.editing.subtitles
    cuts = parsed.project.editing.cuts ?? []
  } else {
    const { cues, errors } = parseSrt(readFileSync(subPath, 'utf-8'))
    if (errors.length > 0) throw new CliError('UNSUPPORTED_FORMAT', `SRT の解析に失敗: ${errors[0]}`, 'SRT の書式を確認してください。')
    entries = entriesFromSegments(
      cues.map((c) => ({ startSec: c.startSec, endSec: c.endSec, text: c.text })),
      settings.transcriptionDefaults,
      video,
      fontId,
      settings.fadeDurationSec ?? 0,
    )
  }

  // REQ-0457 D12 — apply a user-saved style preset to every cue ("author in the
  // GUI, mass-produce from the CLI").  Uses SOURCE video dims (entries are in
  // source-pixel space; resolution scaling happens after).
  const stylePresetName = optString(args.opts, 'style')
  let appliedStylePreset: string | null = null
  if (stylePresetName) {
    const preset = findStylePreset(settings.stylePresets ?? [], stylePresetName)
    if (!preset) {
      const names = (settings.stylePresets ?? []).map((p) => p.name).join(', ') || '(なし)'
      throw new CliError('USAGE', `スタイルプリセット "${stylePresetName}" が見つかりません。`, `利用可能: ${names}（GUI で保存）。`)
    }
    entries = applyStylePreset(entries, preset, { videoWidthPx: video.widthPx, videoHeightPx: video.heightPx })
    appliedStylePreset = preset.name
  }

  const encoderFlag = optString(args.opts, 'encoder')
  if (encoderFlag && !ENCODERS.has(encoderFlag)) {
    throw new CliError('USAGE', `unknown --encoder: ${encoderFlag}`, `auto|h264_nvenc|h264_amf|h264_qsv|h264_mf`)
  }
  const audioFlag = optString(args.opts, 'audio')
  if (audioFlag && !AUDIO_MODES.has(audioFlag)) {
    throw new CliError('USAGE', `unknown --audio: ${audioFlag}`, `preserve|simple|none`)
  }
  const containerFlag = optString(args.opts, 'container')
  const outputContainer: OutputContainer = containerFlag === 'same' ? 'sameAsInput' : 'mp4'

  // REQ-0456 — headless auto line-break margin + vertical overflow guard flags.
  const marginX = optInt(args.opts, 'margin-x') ?? ASS_MARGIN_LR_PX
  const marginY = optInt(args.opts, 'margin-y', 'margin-v') ?? ASS_MARGIN_LR_PX
  const overflowFlag = (optString(args.opts, 'overflow') || 'warn') as OverflowMode
  if (!OVERFLOW_MODES.has(overflowFlag)) {
    throw new CliError('USAGE', `unknown --overflow: ${overflowFlag}`, 'warn|shrink|error')
  }

  // --resolution WxH / --preset: pre-scale the canvas + scale cue pixel fields.
  const tgt = resolveTarget(optString(args.opts, 'resolution'), optString(args.opts, 'preset'))
  if (!tgt.ok) throw new CliError('USAGE', tgt.message, 'mojioko burn ... --preset shorts | --resolution 1080x1920')

  let inputPath = videoPath
  let renderVideo: VideoInfo = video
  let scaledTemp: string | null = null
  let resized = false
  if (tgt.target) {
    const f = contentScaleFactor(video.widthPx, video.heightPx, tgt.target.w, tgt.target.h)
    entries = scaleEntries(entries, f)
    // Dry-run needs the target dims for the layout math but must NOT spend an
    // encode pre-scaling the video.
    if (!dryRun) {
      try {
        scaledTemp = await scaleVideoTo(getBinPath('ffmpeg'), videoPath, tgt.target.w, tgt.target.h)
      } catch (e) {
        throw new CliError('BURN_FAILED', `解像度スケーリングに失敗: ${e instanceof Error ? e.message : String(e)}`, 'ffmpeg の入力/コーデックを確認してください。')
      }
      inputPath = scaledTemp
    }
    renderVideo = { ...video, path: scaledTemp ?? videoPath, widthPx: tgt.target.w, heightPx: tgt.target.h }
    resized = true
  }

  // REQ-0456 §1/§2 — apply auto line-break at the OUTPUT resolution (so text
  // never runs off the frame, matching the GUI) then the vertical overflow
  // guard.  Emphasis tier + margins mirror what the ASS writer will render.
  const isMsix = isPackagedAsMsix(getCurrentProcessContext())
  const layout = layoutForBurn({
    entries,
    video: renderVideo,
    marginX,
    marginY,
    overflowMode: overflowFlag,
    emphasisTierAllowed: canUseKeywordEmphasisInTier(isMsix),
  })
  entries = layout.entries
  if (overflowFlag === 'error' && layout.overflow.overflowCueCount > 0) {
    throw new CliError(
      'SUBTITLE_OVERFLOW',
      `縦にはみ出す字幕が ${layout.overflow.overflowCueCount} 件あります（--overflow error）。`,
      '--overflow shrink で自動縮小するか、--margin-y を小さく／フォントサイズを下げてください。',
      { overflowCueCount: layout.overflow.overflowCueCount, marginY },
    )
  }

  // REQ-0457 Phase E — dry-run: report the overflow judgement without encoding.
  if (dryRun) {
    if (scaledTemp) { try { rmSync(scaledTemp, { force: true }) } catch { /* none in dry-run */ } }
    return emitSuccess(ctx, 'burn', {
      dryRun: true,
      wouldEncode: false,
      resolution: { width: renderVideo.widthPx, height: renderVideo.heightPx },
      resized,
      overflow: layout.overflow,
      cueCount: entries.filter((e) => !e.isDeleted).length,
      subtitleStyle: resolveDefaultSubtitleStyle(settings),
      stylePreset: appliedStylePreset,
    })
  }

  const request: BurninStartRequest = {
    inputPath,
    outputPath: out,
    entries,
    video: renderVideo,
    burnin: {
      horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
      verticalPosition: BURNIN_DEFAULTS.verticalPosition,
      verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx,
    },
    encoderSetting: (encoderFlag as EncoderSetting) || settings.encoder || 'auto',
    audioMode: (audioFlag as AudioMode) || settings.audioMode || 'simple',
    subtitleBackground: BURNIN_DEFAULTS.subtitleBackground,
    outputContainer,
    fontId,
    cuts,
    marginLrPx: marginX,
  }

  const controller = new AbortController()
  // REQ-0457 B6 — an MCP cancel_job aborts ffmpeg through ctx.signal.
  if (ctx.signal) ctx.signal.addEventListener('abort', () => controller.abort(), { once: true })
  let failedError: string | null = null
  let sizeMB = 0
  try {
    await startBurnin(
      request,
      (ev) => {
        if (ev.event === 'progress') emitProgress(ctx, { event: 'progress', percent: ev.percent })
        else if (ev.event === 'completed') sizeMB = ev.sizeMB
        else if (ev.event === 'failed') failedError = ev.error
      },
      controller.signal,
    )
  } catch (e) {
    throw new CliError('BURN_FAILED', e instanceof Error ? e.message : String(e), 'ffmpeg の入力/コーデック/出力先を確認してください。')
  } finally {
    if (scaledTemp) {
      try {
        rmSync(scaledTemp, { force: true })
      } catch {
        // best-effort temp cleanup
      }
    }
  }
  if (failedError) {
    throw new CliError('BURN_FAILED', failedError, 'ffmpeg の入力/コーデック/出力先を確認してください。')
  }

  return emitSuccess(ctx, 'burn', {
    outputPath: out,
    resolution: { width: renderVideo.widthPx, height: renderVideo.heightPx },
    resized,
    encoder: request.encoderSetting,
    audio: request.audioMode,
    sizeMB,
    overflow: layout.overflow,
    // REQ-0457 A2 — the resolved subtitle style applied (paired with `status`).
    // For `.mojioko` input, per-cue styles from the file are preserved; this is
    // the app default style (what SRT-seeded cues and un-overridden fields use).
    subtitleStyle: resolveDefaultSubtitleStyle(settings),
    // REQ-0457 D12 — the style preset applied to all cues, if any.
    stylePreset: appliedStylePreset,
  })
}
