/**
 * REQ-0457 C10 — `mojioko convert <in> -o <out>` (`.mojioko` ↔ `.srt`, no
 * re-transcription).
 *
 * `.mojioko → .srt` drops styling (SRT carries none) but keeps text + timing.
 * `.srt → .mojioko` seeds the app default style; pass `--video <path>` so the
 * project references the real dimensions (else a synthetic 1920×1080 canvas is
 * used, enough to burn but not a true source reference).
 */
import { existsSync, writeFileSync } from 'node:fs'
import { probeVideo } from '../../services/ffprobe'
import { loadSettings } from '../../services/settings-store'
import { formatSrtTime } from '../../../shared/srt-time'
import { APP_VERSION } from '../../../shared/app-info'
import type { FontId } from '../../../shared/fonts'
import type { VideoInfo } from '../../../shared/types'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext } from '../output'
import { assertWritable } from '../overwrite'
import { detectFormat, entriesFromSegments, writeMojiokoFile } from '../subtitle-io'
import { readCues, type ReadCue } from './read-subtitle'

function cuesToSrt(cues: ReadCue[]): string {
  return '﻿' + cues
    .filter((c) => c.text.trim() !== '')
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.text.replace(/\\N/g, '\n')}`)
    .join('\n\n') + '\n'
}

const SYNTHETIC_VIDEO: VideoInfo = {
  path: '', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 0, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}

export async function runConvertCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', '入力字幕が必要です。', 'mojioko convert <in> -o <out>')
  if (!existsSync(input)) throw new CliError('INPUT_NOT_FOUND', `入力が見つかりません: ${input}`, 'パスを確認してください。')
  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out>）が必要です。')
  assertWritable(out, args.opts) // REQ-0457 D13

  const outFmt = detectFormat(out, optString(args.opts, 'to'))
  if (!outFmt) throw new CliError('UNSUPPORTED_FORMAT', `出力フォーマット不明: ${out}`, '.mojioko / .srt、または --to mojioko|srt。')

  const { format: inFmt, cues } = readCues(input, optString(args.opts, 'from'))

  try {
    if (outFmt === 'srt') {
      writeFileSync(out, cuesToSrt(cues), 'utf-8')
    } else {
      // → .mojioko: seed the app default style, referencing --video if given.
      const settings = await loadSettings()
      let video = SYNTHETIC_VIDEO
      const videoPath = optString(args.opts, 'video')
      if (videoPath && existsSync(videoPath)) {
        try { video = await probeVideo(videoPath) } catch { /* fall back to synthetic */ }
      }
      const fontId = (settings.activeFontId ?? 'noto-sans-jp-semibold') as FontId
      const entries = entriesFromSegments(
        cues.map((c) => ({ startSec: c.startSec, endSec: c.endSec, text: c.text })),
        settings.transcriptionDefaults,
        video,
        fontId,
        settings.fadeDurationSec ?? 0,
      )
      writeMojiokoFile({
        outPath: out, appVersion: APP_VERSION, video, trackIndex: 1,
        entries, defaults: settings.transcriptionDefaults, whisperModel: null, device: 'cpu',
      })
    }
  } catch (e) {
    throw new CliError('OUTPUT_WRITE_FAILED', `出力を書き込めません: ${out}`, '出力先の権限・空き容量・パスを確認してください。', { error: e instanceof Error ? e.message : String(e) })
  }

  return emitSuccess(ctx, 'convert', { inputPath: input, outputPath: out, from: inFmt, to: outFmt, cueCount: cues.length })
}
