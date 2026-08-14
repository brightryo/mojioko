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
import type { BurninStartRequest, EncoderSetting, AudioMode, OutputContainer } from '../../../shared/ipc-contracts'
import type { EncodeQuality, H264Encoder, SubtitleEntry, VideoInfo } from '../../../shared/types'
import type { FontId } from '../../../shared/fonts'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitDebug, emitProgress, emitSuccess, type CliContext } from '../output'
import { detectFormat, entriesFromSegments } from '../subtitle-io'
import { assertWritable } from '../overwrite'
import { parseBitrateKbps } from '../../../shared/encode-quality'
// REQ-0468 — the placement/layout pipeline (style preset + overrides + position +
// margins + overflow + resolution scaling + auto line-break) is now a shared
// resolver used by BOTH burn and export_frame, so a still previews the burn and
// neither drifts.  `optInt` is re-exported from there.
import { resolvePlacementAndLayout, optInt } from '../placement'

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

  // REQ-0468 — the whole placement/layout pipeline (style preset + per-cue style
  // overrides + `--position` + margins + `--overflow` + `--resolution`/`--preset`
  // scaling + auto line-break) is resolved by the shared helper `export_frame`
  // also calls, so a still previews exactly what this burn renders.  Only the
  // encode-side flags (encoder/audio/container/quality, above) are burn-specific.
  const placement = resolvePlacementAndLayout(args.opts, video, settings, fontId, entries)
  entries = placement.entries
  const { renderVideo, scaleTo, resized, marginX, marginY, overflow, appliedStylePreset, verticalPositionOverride, subtitleStyle } = placement
  // REQ-0499 §2-5 — `--verbose` had no call site anywhere in src, so it could
  // never print anything.  The resolved placement is the single most useful
  // thing to see when a burn does not look like the caller expected.
  emitDebug(
    ctx,
    `[debug] placement: render=${renderVideo.widthPx}x${renderVideo.heightPx} resized=${resized} marginX=${marginX} marginY=${marginY} ` +
      `overflow=${placement.overflowMode}/${overflow.overflowCueCount} preset=${appliedStylePreset ?? 'none'} cues=${entries.filter((e) => !e.isDeleted).length}`,
  )

  if (placement.overflowMode === 'error' && overflow.overflowCueCount > 0) {
    throw new CliError(
      'SUBTITLE_OVERFLOW',
      `縦にはみ出す字幕が ${overflow.overflowCueCount} 件あります（--overflow error）。`,
      '--overflow shrink で自動縮小するか、--margin-y を小さく／フォントサイズを下げてください。',
      { overflowCueCount: overflow.overflowCueCount, marginY },
    )
  }

  // REQ-0457 Phase E — dry-run: report the overflow judgement without encoding.
  if (dryRun) {
    return emitSuccess(ctx, 'burn', {
      dryRun: true,
      wouldEncode: false,
      resolution: { width: renderVideo.widthPx, height: renderVideo.heightPx },
      resized,
      overflow,
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
    overflow,
    // REQ-0457 A2 — the resolved subtitle style applied (paired with `status`).
    // For `.mojioko` input, per-cue styles from the file are preserved; this is
    // the app default style (what SRT-seeded cues and un-overridden fields use).
    subtitleStyle,
    // REQ-0457 D12 — the style preset applied to all cues, if any.
    stylePreset: appliedStylePreset,
  })
}
