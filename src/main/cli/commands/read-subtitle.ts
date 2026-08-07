/**
 * REQ-0457 C8 — `mojioko read_subtitle <subtitle>`.
 *
 * Return a cue list (index / start / end / text) from a `.mojioko` or `.srt`
 * so an agent can review the transcription, quote it, or find the cue to fix
 * (paired with `edit_subtitle`, C9).
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseProjectFile } from '../../../shared/project-file'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext } from '../output'
import { detectFormat } from '../subtitle-io'

export interface ReadCue {
  index: number
  startSec: number
  endSec: number
  text: string
  hasWords?: boolean
}

/** Parse a subtitle file into a normalized cue list (shared with edit/convert). */
export function readCues(subPath: string, formatOverride?: string): { format: 'mojioko' | 'srt'; cues: ReadCue[] } {
  const fmt = detectFormat(subPath, formatOverride)
  if (!fmt) throw new CliError('UNSUPPORTED_FORMAT', `字幕フォーマット不明: ${subPath}`, '.mojioko / .srt を指定してください。')
  const raw = readFileSync(subPath, 'utf-8')
  if (fmt === 'mojioko') {
    const parsed = parseProjectFile(raw)
    if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
    const cues = parsed.project.editing.subtitles
      .filter((e) => !e.isDeleted)
      .map((e, i) => ({ index: i, startSec: e.startSec, endSec: e.endSec, text: e.text, hasWords: Array.isArray(e.words) && e.words.length > 0 }))
    return { format: 'mojioko', cues }
  }
  const { cues, errors } = parseSrt(raw)
  if (errors.length > 0) throw new CliError('UNSUPPORTED_FORMAT', `SRT の解析に失敗: ${errors[0]}`, 'SRT の書式を確認してください。')
  return { format: 'srt', cues: cues.map((c, i) => ({ index: i, startSec: c.startSec, endSec: c.endSec, text: c.text })) }
}

export async function runReadSubtitleCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', '字幕ファイルが必要です。', 'mojioko read_subtitle <subtitle>')
  if (!existsSync(input)) throw new CliError('INPUT_NOT_FOUND', `字幕が見つかりません: ${input}`, 'パスを確認してください。')

  const { format, cues } = readCues(input, optString(args.opts, 'format'))
  return emitSuccess(ctx, 'read_subtitle', { path: input, format, cueCount: cues.length, cues })
}
