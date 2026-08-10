/**
 * REQ-0447 / spec §3.4 — `mojioko burn <video> <subtitle> -o <out.mp4>`.
 *
 * Reuses `startBurnin` (ffmpeg + libass `subtitles=`, never drawtext). `.mojioko`
 * input keeps per-cue style; SRT input is seeded with the app default subtitle
 * style (font inherited, spec §11). Resolution scaling (`--resolution`/`--preset`,
 * REQ-0447) and the vertical overflow guard (`--overflow`, REQ-0456) are applied
 * here. REQ-0460 folded the resolution scale into the single burn encode (via
 * `request.scaleTo`) — no more lossy `h264_mf` pre-pass — and added the
 * `--crf`/`--bitrate`/`--quality` overrides and `--position`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { startBurnin } from '../../services/ffmpeg-burnin'
import { probeVideo } from '../../services/ffprobe'
import { loadSettings } from '../../services/settings-store'
import { parseProjectFile } from '../../../shared/project-file'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import { ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { canUseKeywordEmphasisInTier } from '../../../shared/emphasis'
import { isPackagedAsMsix, getCurrentProcessContext } from '../../lib/msix'
import { layoutForBurn, type OverflowMode } from '../../services/headless-layout'
import type { BurninStartRequest, EncoderSetting, AudioMode, OutputContainer } from '../../../shared/ipc-contracts'
import type { EncodeQuality, H264Encoder, SubtitleEntry, VideoInfo } from '../../../shared/types'
import type { FontId } from '../../../shared/fonts'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitProgress, emitSuccess, type CliContext } from '../output'
import { detectFormat, entriesFromSegments } from '../subtitle-io'
import { resolveDefaultSubtitleStyle } from '../subtitle-style'
import { findStylePreset, applyStylePreset } from '../style-preset-cli'
import { assertWritable } from '../overwrite'
import { resolveTarget, contentScaleFactor, scaleEntries } from '../scale-video'
import { parseBitrateKbps } from '../../../shared/encode-quality'

const VERTICAL_POSITIONS = new Set<'top' | 'center' | 'bottom'>(['top', 'center', 'bottom'])

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

  // REQ-0460 — explicit encode-quality overrides.  These are OVERRIDES only;
  // with none supplied the encoder's constant-quality default is used (identical
  // to the GUI).  `--bitrate` (VBR target) takes precedence over `--crf` /
  // `--quality` inside `buildEncoderArgs`.
  const crf = optInt(args.opts, 'crf')
  const bitrateKbps = parseBitrateKbps(optString(args.opts, 'bitrate'))
  const qualityVal = optInt(args.opts, 'quality')
  const quality: EncodeQuality | undefined =
    crf !== undefined || bitrateKbps !== undefined || qualityVal !== undefined
      ? {
          ...(crf !== undefined ? { crf } : {}),
          ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
          ...(qualityVal !== undefined ? { quality: qualityVal } : {}),
        }
      : undefined

  // REQ-0460 — `--position top|center|bottom` was advertised (help + MCP schema)
  // but silently dropped: the burn always used the app-default vertical position
  // and the returned subtitleStyle reflected settings, not the argument.  Read
  // and validate it here; it is applied to every cue below (before layout, so
  // the overflow guard anchors from the requested edge).
  const positionFlag = optString(args.opts, 'position')
  if (positionFlag && !VERTICAL_POSITIONS.has(positionFlag as 'top' | 'center' | 'bottom')) {
    throw new CliError('USAGE', `unknown --position: ${positionFlag}`, 'top|center|bottom')
  }
  const verticalPositionOverride = positionFlag
    ? (positionFlag as 'top' | 'center' | 'bottom')
    : undefined

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

  // REQ-0460 — resolution scaling is now folded into the SINGLE burn encode via
  // `request.scaleTo` (see startBurnin), replacing the previous separate
  // `scaleVideoTo` pre-pass.  That old pass re-encoded the source with a bare
  // `h264_mf` (no rate control) BEFORE the burn, collapsing the bitrate to ~2/3
  // even when the target resolution equalled the source.  Now the pixel-space
  // cue fields are still scaled by the content factor, but the video itself is
  // scaled+padded inside the same cq-quality ffmpeg run as the subtitles.
  let renderVideo: VideoInfo = video
  let scaleTo: { w: number; h: number } | undefined
  let resized = false
  if (tgt.target) {
    const f = contentScaleFactor(video.widthPx, video.heightPx, tgt.target.w, tgt.target.h)
    entries = scaleEntries(entries, f)
    scaleTo = { w: tgt.target.w, h: tgt.target.h }
    renderVideo = { ...video, widthPx: tgt.target.w, heightPx: tgt.target.h }
    resized = true
  }

  // REQ-0460 — apply the vertical-position override to every cue BEFORE layout so
  // the overflow guard anchors from the requested edge.  For `.mojioko` input
  // this deliberately overrides the per-cue positions (an explicit flag wins).
  if (verticalPositionOverride) {
    entries = entries.map((e) => ({
      ...e,
      verticalPosition: verticalPositionOverride,
      // Clear any absolute Y so alignment-based placement (the anchor) governs.
      posY: undefined,
    }))
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

  // REQ-0457 A2 / REQ-0460 — the resolved subtitle style applied.  Patch the
  // reported vertical position with the `--position` override so the returned
  // value reflects what is actually burned (previously it always echoed the
  // settings default, e.g. "center", regardless of the argument).
  const subtitleStyle = resolveDefaultSubtitleStyle(settings)
  if (verticalPositionOverride) {
    subtitleStyle.position = { ...subtitleStyle.position, vertical: verticalPositionOverride }
  }

  // REQ-0457 Phase E — dry-run: report the overflow judgement without encoding.
  if (dryRun) {
    return emitSuccess(ctx, 'burn', {
      dryRun: true,
      wouldEncode: false,
      resolution: { width: renderVideo.widthPx, height: renderVideo.heightPx },
      resized,
      overflow: layout.overflow,
      cueCount: entries.filter((e) => !e.isDeleted).length,
      subtitleStyle,
      stylePreset: appliedStylePreset,
      // REQ-0460 — echo the quality override that WOULD be applied (if any).
      quality: quality ?? null,
    })
  }

  const request: BurninStartRequest = {
    // REQ-0460 — single-pass scaling: the ORIGINAL source is the input; the
    // scale+pad happens inside startBurnin's filter graph (no lossy pre-encode).
    inputPath: videoPath,
    outputPath: out,
    entries,
    video: renderVideo,
    burnin: {
      horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
      // REQ-0460 — reflect the --position override on the project default too.
      verticalPosition: verticalPositionOverride ?? BURNIN_DEFAULTS.verticalPosition,
      verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx,
    },
    encoderSetting: (encoderFlag as EncoderSetting) || settings.encoder || 'auto',
    audioMode: (audioFlag as AudioMode) || settings.audioMode || 'simple',
    subtitleBackground: BURNIN_DEFAULTS.subtitleBackground,
    outputContainer,
    fontId,
    cuts,
    marginLrPx: marginX,
    ...(scaleTo ? { scaleTo } : {}),
    ...(quality ? { quality } : {}),
  }

  const controller = new AbortController()
  // REQ-0457 B6 — an MCP cancel_job aborts ffmpeg through ctx.signal.
  if (ctx.signal) ctx.signal.addEventListener('abort', () => controller.abort(), { once: true })
  let failedError: string | null = null
  let sizeMB = 0
  // REQ-0460 — capture the measured bitrate + concrete encoder so the result
  // lets an agent verify quality (previously only sizeMB was returned).
  let videoBitrateKbps: number | null = null
  let resolvedEncoder: H264Encoder | null = null
  try {
    await startBurnin(
      request,
      (ev) => {
        if (ev.event === 'progress') emitProgress(ctx, { event: 'progress', percent: ev.percent })
        else if (ev.event === 'completed') {
          sizeMB = ev.sizeMB
          videoBitrateKbps = ev.videoBitrateKbps ?? null
          resolvedEncoder = ev.resolvedEncoder ?? null
        } else if (ev.event === 'failed') failedError = ev.error
      },
      controller.signal,
    )
  } catch (e) {
    throw new CliError('BURN_FAILED', e instanceof Error ? e.message : String(e), 'ffmpeg の入力/コーデック/出力先を確認してください。')
  }
  if (failedError) {
    throw new CliError('BURN_FAILED', failedError, 'ffmpeg の入力/コーデック/出力先を確認してください。')
  }

  return emitSuccess(ctx, 'burn', {
    outputPath: out,
    resolution: { width: renderVideo.widthPx, height: renderVideo.heightPx },
    resized,
    // `encoder` = the requested setting (e.g. 'auto'); `resolvedEncoder` = what
    // ffmpeg actually used (REQ-0460).
    encoder: request.encoderSetting,
    resolvedEncoder,
    audio: request.audioMode,
    sizeMB,
    // REQ-0460 — measured output video bitrate (kbps) + the quality override used.
    videoBitrateKbps,
    quality: quality ?? null,
    overflow: layout.overflow,
    // REQ-0457 A2 — the resolved subtitle style applied (paired with `status`).
    // For `.mojioko` input, per-cue styles from the file are preserved; this is
    // the app default style (what SRT-seeded cues and un-overridden fields use).
    subtitleStyle,
    // REQ-0457 D12 — the style preset applied to all cues, if any.
    stylePreset: appliedStylePreset,
  })
}
