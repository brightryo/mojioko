/**
 * REQ-0447 / spec §3.4 — `mojioko burn <video> <subtitle> -o <out.mp4>`.
 *
 * Reuses `startBurnin` (ffmpeg + libass `subtitles=`, never drawtext). `.mojioko`
 * input keeps per-cue style; SRT input is seeded with the app default subtitle
 * style (font inherited, spec §11). Resolution scaling / `--preset` / overflow
 * handling are layered in a follow-up (see §9 notes); this renders at the
 * source resolution.
 */
import { existsSync, readFileSync } from 'node:fs'
import { startBurnin } from '../../services/ffmpeg-burnin'
import { probeVideo } from '../../services/ffprobe'
import { loadSettings } from '../../services/settings-store'
import { parseProjectFile } from '../../../shared/project-file'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import type { BurninStartRequest, EncoderSetting, AudioMode, OutputContainer } from '../../../shared/ipc-contracts'
import type { SubtitleEntry, VideoInfo } from '../../../shared/types'
import type { FontId } from '../../../shared/fonts'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitProgress, emitSuccess, type CliContext } from '../output'
import { detectFormat, entriesFromSegments } from '../subtitle-io'

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
  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out.mp4>）が必要です。')

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

  const request: BurninStartRequest = {
    inputPath: videoPath,
    outputPath: out,
    entries,
    video,
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
  }

  const controller = new AbortController()
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
  }
  if (failedError) {
    throw new CliError('BURN_FAILED', failedError, 'ffmpeg の入力/コーデック/出力先を確認してください。')
  }

  return emitSuccess(ctx, 'burn', {
    outputPath: out,
    resolution: { width: video.widthPx, height: video.heightPx },
    resized: false,
    encoder: request.encoderSetting,
    audio: request.audioMode,
    sizeMB,
    overflow: { mode: 'warn', overflowCueCount: 0 },
  })
}
