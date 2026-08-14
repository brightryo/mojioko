/**
 * REQ-0457 C9 — `mojioko edit_subtitle <in> -o <out> --index N --text "..."`.
 *
 * Replace ONE cue's text by its (non-deleted) index, closing the "read →
 * correct a misrecognition → re-burn" loop with `read_subtitle` (C8).  For a
 * `.mojioko` input the full project (per-cue styles) is preserved and only the
 * cue's `text` changes; stale `words` are dropped so karaoke falls back to the
 * equal split instead of sweeping wrong timings.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseProjectFile, serializeProjectFile } from '../../../shared/project-file'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import { formatSrtTime } from '../../../shared/srt-time'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext, type CliWarning } from '../output'
import { assertWritable } from '../overwrite'
import { detectFormat } from '../subtitle-io'

export async function runEditSubtitleCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', '入力字幕が必要です。', 'mojioko edit_subtitle <in> -o <out> --index N --text "..."')
  if (!existsSync(input)) throw new CliError('INPUT_NOT_FOUND', `入力が見つかりません: ${input}`, 'パスを確認してください。')
  const out = optString(args.opts, 'out') ?? input
  // REQ-0457 D13 — only guard a DIFFERENT output path (in-place edit is the norm).
  if (out !== input) assertWritable(out, args.opts)

  const indexStr = optString(args.opts, 'index')
  const index = Number.parseInt(indexStr ?? '', 10)
  if (!Number.isInteger(index) || index < 0) throw new CliError('USAGE', '--index（0始まり）が必要です。', '対象 cue の番号は read_subtitle で確認。')
  const newText = optString(args.opts, 'text')
  if (newText === undefined) throw new CliError('USAGE', '--text "新しいテキスト" が必要です。')

  const inFmt = detectFormat(input, optString(args.opts, 'from'))
  if (!inFmt) throw new CliError('UNSUPPORTED_FORMAT', `字幕フォーマット不明: ${input}`, '.mojioko / .srt を指定してください。')
  const outFmt = detectFormat(out, optString(args.opts, 'to')) ?? inFmt

  const raw = readFileSync(input, 'utf-8')

  // REQ-0500 §3-3 — replacing the text DISCARDS the cue's per-word timings, so
  // karaoke silently degrades from real speech timing to an even split.  The
  // behaviour is deliberate (stale timings swept against new text look worse),
  // but it used to happen with no signal at all — and `read_subtitle` advertises
  // `hasWords: true` right before, so an agent fixing one typo had every reason
  // to think nothing else changed.  Warn instead of surprising the caller.
  const warnings: CliWarning[] = []

  try {
    if (inFmt === 'mojioko') {
      const parsed = parseProjectFile(raw)
      if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
      const project = parsed.project
      // Map the non-deleted index to the real array position.
      const visible = project.editing.subtitles.map((e, i) => ({ e, i })).filter((x) => !x.e.isDeleted)
      if (index >= visible.length) throw new CliError('USAGE', `--index ${index} は範囲外（cue 数 ${visible.length}）。`, 'read_subtitle で番号を確認。')
      const pos = visible[index].i
      const entry = project.editing.subtitles[pos]
      // Drop stale word timings so karaoke re-derives (equal split) instead of
      // sweeping the OLD word timings against the NEW text.
      const hadWords = Array.isArray(entry.words) && entry.words.length > 0
      if (hadWords) {
        warnings.push({
          code: 'WORD_TIMINGS_DISCARDED',
          message: 'テキスト差し替えにより、この cue の単語タイミングを破棄しました（カラオケは均等割りになります）。',
          detail: {
            index,
            wordCount: entry.words?.length ?? 0,
            reason: '古い単語タイミングを新しいテキストに当てると発話とズレるため。',
            remedy: '実発話タイミングが必要な場合は、この cue を再度文字起こししてください。',
          },
        })
      }
      project.editing.subtitles[pos] = { ...entry, text: newText, words: undefined, isEdited: true }

      if (outFmt === 'mojioko') {
        writeFileSync(out, serializeProjectFile(project), 'utf-8')
      } else {
        writeFileSync(out, cuesToSrt(project.editing.subtitles.filter((e) => !e.isDeleted).map((e) => ({ startSec: e.startSec, endSec: e.endSec, text: e.text }))), 'utf-8')
      }
    } else {
      const { cues, errors } = parseSrt(raw)
      if (errors.length > 0) throw new CliError('UNSUPPORTED_FORMAT', `SRT の解析に失敗: ${errors[0]}`, 'SRT の書式を確認してください。')
      if (index >= cues.length) throw new CliError('USAGE', `--index ${index} は範囲外（cue 数 ${cues.length}）。`)
      cues[index] = { ...cues[index], text: newText }
      if (outFmt === 'srt') {
        writeFileSync(out, cuesToSrt(cues.map((c) => ({ startSec: c.startSec, endSec: c.endSec, text: c.text }))), 'utf-8')
      } else {
        throw new CliError('USAGE', 'SRT → .mojioko の編集出力は未対応。convert を使ってください。', 'mojioko convert <srt> -o <mojioko>')
      }
    }
  } catch (e) {
    if (e instanceof CliError) throw e
    throw new CliError('OUTPUT_WRITE_FAILED', `出力を書き込めません: ${out}`, '出力先の権限・パスを確認してください。', { error: e instanceof Error ? e.message : String(e) })
  }

  return emitSuccess(
    ctx,
    'edit_subtitle',
    {
      inputPath: input,
      outputPath: out,
      format: outFmt,
      editedIndex: index,
      newText,
      // Explicit rather than inferable from `warnings[]` alone, so a caller can
      // branch on it without string-matching a warning code.
      wordTimingsDiscarded: warnings.some((w) => w.code === 'WORD_TIMINGS_DISCARDED'),
    },
    warnings,
  )
}

function cuesToSrt(cues: { startSec: number; endSec: number; text: string }[]): string {
  return '﻿' + cues
    .filter((c) => c.text.trim() !== '')
    .map((c, i) => `${i + 1}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.text.replace(/\\N/g, '\n')}`)
    .join('\n\n') + '\n'
}
