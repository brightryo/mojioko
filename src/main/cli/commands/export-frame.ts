/**
 * REQ-0457 A4 — `mojioko export_frame <video> <subtitle> -o <out.png> --time <sec>`.
 *
 * Renders ONE frame (video + burned subtitle at `timeSec`) so an agent can
 * VISUALLY verify the burn without spending minutes encoding a whole video.
 * Reuses the burn-in ass-generator + REQ-0375/0381 two-pass frame exporter, so
 * karaoke phase / animation are pixel-accurate at the playhead.  Entries are
 * auto line-broken at the video width first (REQ-0456) so the still matches
 * what a default burn would render.
 */
import { existsSync, readFileSync } from 'node:fs'
import { exportFrame } from '../../services/frame-exporter'
import { probeVideo } from '../../services/ffprobe'
import { loadSettings } from '../../services/settings-store'
import { parseProjectFile } from '../../../shared/project-file'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { KARAOKE_STYLE_DEFAULT } from '../../../shared/karaoke-style'
import { ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { canUseKeywordEmphasisInTier } from '../../../shared/emphasis'
import { isPackagedAsMsix, getCurrentProcessContext } from '../../lib/msix'
import { autoLineBreakEntries } from '../../services/headless-layout'
import type { ExportFrameRequest } from '../../../shared/ipc-contracts'
import type { SubtitleEntry, VideoInfo } from '../../../shared/types'
import type { FontId } from '../../../shared/fonts'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext } from '../output'
import { assertWritable } from '../overwrite'
import { detectFormat, entriesFromSegments } from '../subtitle-io'

export async function runExportFrameCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const videoPath = args.positionals[0]
  const subPath = args.positionals[1]
  if (!videoPath || !subPath) {
    throw new CliError('USAGE', 'video と subtitle が必要です。', 'mojioko export_frame <video> <subtitle> -o <out.png> --time <sec>')
  }
  if (!existsSync(videoPath)) throw new CliError('INPUT_NOT_FOUND', `動画が見つかりません: ${videoPath}`, '動画パスを確認してください。')
  if (!existsSync(subPath)) throw new CliError('INPUT_NOT_FOUND', `字幕が見つかりません: ${subPath}`, '字幕パスを確認してください。')

  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out.png|.jpg>）が必要です。')
  assertWritable(out, args.opts) // REQ-0457 D13

  const timeStr = optString(args.opts, 'time', 'at')
  const timeSec = Number.parseFloat(timeStr ?? '')
  if (!Number.isFinite(timeSec) || timeSec < 0) {
    throw new CliError('USAGE', '時刻（--time <秒>）が必要です。', 'mojioko export_frame ... --time 1.5')
  }

  const subFmt = detectFormat(subPath, optString(args.opts, 'format'))
  if (!subFmt) throw new CliError('UNSUPPORTED_FORMAT', `字幕フォーマット不明: ${subPath}`, '.mojioko / .srt を指定してください。')

  const lower = out.toLowerCase()
  const format: 'png' | 'jpg' = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpg' : 'png'

  const settings = await loadSettings()

  let video: VideoInfo
  try {
    video = await probeVideo(videoPath)
  } catch (e) {
    throw new CliError('UNSUPPORTED_FORMAT', `動画を読み取れません: ${videoPath}`, 'サポートされた動画ですか？', { error: e instanceof Error ? e.message : String(e) })
  }

  const fontId = (settings.activeFontId ?? 'noto-sans-jp-semibold') as FontId
  let entries: SubtitleEntry[]
  if (subFmt === 'mojioko') {
    const parsed = parseProjectFile(readFileSync(subPath, 'utf-8'))
    if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
    entries = parsed.project.editing.subtitles
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

  // Match a default burn: wrap at the video width so the still is not clipped.
  const isMsix = isPackagedAsMsix(getCurrentProcessContext())
  entries = autoLineBreakEntries(entries, {
    videoWidthPx: video.widthPx,
    videoHeightPx: video.heightPx,
    marginLrPx: ASS_MARGIN_LR_PX,
    marginYPx: ASS_MARGIN_LR_PX,
    emphasisTierAllowed: canUseKeywordEmphasisInTier(isMsix),
  })

  const cueVisible = entries.some((e) => !e.isDeleted && e.startSec <= timeSec && timeSec < e.endSec && e.text.trim() !== '')

  const req: ExportFrameRequest = {
    inputPath: videoPath,
    outputPath: out,
    timeSec,
    video,
    format,
    includeSubtitles: true,
    entries,
    subtitleBackground: BURNIN_DEFAULTS.subtitleBackground,
    fontId,
    karaokeStyle: KARAOKE_STYLE_DEFAULT,
  }

  let result
  try {
    result = await exportFrame(req)
  } catch (e) {
    throw new CliError('BURN_FAILED', `フレーム出力に失敗: ${e instanceof Error ? e.message : String(e)}`, 'ffmpeg の入力/コーデック/出力先を確認してください。')
  }

  return emitSuccess(ctx, 'export_frame', {
    outputPath: result.outputPath,
    sizeBytes: result.sizeBytes,
    timeSec,
    format,
    resolution: { width: video.widthPx, height: video.heightPx },
    cueVisible,
  })
}
