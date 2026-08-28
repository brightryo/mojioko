/**
 * REQ-0457 C8 — `mojioko read_subtitle <subtitle>`.
 *
 * Return a cue list (index / start / end / text) from a `.mojioko` or `.srt`
 * so an agent can review the transcription, quote it, or find the cue to fix
 * (paired with `edit_subtitle`, C9).
 *
 * REQ-0500 §1 — `--with-style` additionally returns each cue's RESOLVED style.
 * Before this, an agent could not see a single style field: `.mojioko` input was
 * fully parsed and then projected down to four scalars, so the only way to
 * "check" a style was to render a frame and look at it. That made every headless
 * style change a blind overwrite — including over per-cue work a user had done
 * by hand in the GUI, with no way to notice.
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseProjectFile } from '../../../shared/project-file'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import { loadSettings } from '../../services/settings-store'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext, type CliWarning } from '../output'
import { detectFormat } from '../subtitle-io'
import { summarizeSubtitleStyle, type SubtitleStyleSummary } from '../subtitle-style'
import type { EmphasisSpan } from '../../../shared/emphasis'
import type { WordSpan } from '../../../shared/types'

export interface ReadCue {
  index: number
  startSec: number
  endSec: number
  text: string
  hasWords?: boolean
  /**
   * REQ-0500 §1-3 — stable identifiers.
   *
   * `index` is the position among NON-DELETED cues and is recomputed on every
   * read, so a delete performed between an agent's read and its `edit_subtitle`
   * silently retargets the edit. `cueNumber` (the user-visible 字幕ID) and the
   * UUID `id` are stable; both are returned so a caller can detect that drift.
   * Addressing BY them is a separate change — see the spec's Open Question.
   */
  id?: string
  cueNumber?: number
  /** Present only with `--with-style` on `.mojioko` input. */
  style?: SubtitleStyleSummary
  /**
   * REQ-0554 §1-2 — the emphasised character ranges, so what `edit_cues` can
   * write can also be read. Rides with `--with-style` (small, and needed in
   * order to write the style back).
   */
  emphasisSpans?: EmphasisSpan[]
  /**
   * REQ-0554 §1-2 — per-word karaoke timings, behind `--with-words` because a
   * cue can carry hundreds and most callers never need them.
   */
  words?: WordSpan[]
}

export interface ReadCuesResult {
  format: 'mojioko' | 'srt'
  cues: ReadCue[]
  /**
   * True when at least two cues resolve to different styles.
   *
   * REQ-0500 §1-4 — this is the field that tells a caller WHICH view to trust.
   * `burn`/`status` report `subtitleStyle`, a summary of ONE representative cue;
   * that is accurate only when every cue shares a style. When `styleVaries` is
   * true, the representative summary is actively misleading and a broadcast
   * override (`--font-size`, `--style`, …) will flatten real variation.
   * `undefined` when `--with-style` was not requested.
   */
  styleVaries?: boolean
}

/** Parse a subtitle file into a normalized cue list (shared with edit/convert). */
export function readCues(
  subPath: string,
  formatOverride?: string,
  style?: { autoLineBreak: boolean },
  opts?: { withWords?: boolean },
): ReadCuesResult {
  const fmt = detectFormat(subPath, formatOverride)
  if (!fmt) throw new CliError('UNSUPPORTED_FORMAT', `字幕フォーマット不明: ${subPath}`, '.mojioko / .srt を指定してください。')
  const raw = readFileSync(subPath, 'utf-8')
  if (fmt === 'mojioko') {
    const parsed = parseProjectFile(raw)
    if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
    const cues = parsed.project.editing.subtitles
      .filter((e) => !e.isDeleted)
      .map((e, i): ReadCue => ({
        index: i,
        startSec: e.startSec,
        endSec: e.endSec,
        text: e.text,
        hasWords: Array.isArray(e.words) && e.words.length > 0,
        id: e.id,
        cueNumber: e.cueNumber,
        ...(style ? { style: summarizeSubtitleStyle(e, style.autoLineBreak) } : {}),
        /*
         * REQ-0554 §1-2 — read/write symmetry: `edit_cues` can WRITE
         * `emphasisSpans`, so `read_subtitle` must be able to show them.
         * Without this an agent cannot see which words are currently
         * emphasised, and therefore cannot patch them without guessing.
         *
         * Carried with `--with-style` rather than behind its own flag because
         * it is small and it is exactly what you need in order to write the
         * style back. `words` is the opposite — potentially hundreds of
         * entries per cue — so it has its own flag below.
         */
        ...(style ? { emphasisSpans: e.emphasisSpans ?? [] } : {}),
        ...(opts?.withWords ? { words: e.words ?? [] } : {}),
      }))
    const result: ReadCuesResult = { format: 'mojioko', cues }
    if (style) {
      const first = cues[0]?.style
      result.styleVaries = cues.some((c) => JSON.stringify(c.style) !== JSON.stringify(first))
    }
    return result
  }
  const { cues, errors } = parseSrt(raw)
  if (errors.length > 0) throw new CliError('UNSUPPORTED_FORMAT', `SRT の解析に失敗: ${errors[0]}`, 'SRT の書式を確認してください。')
  // SRT carries no style at all — the cues get the app default only at burn
  // time. Reporting the default here would imply the FILE holds it, so the
  // field is omitted and the caller is told why (see the warning below).
  return { format: 'srt', cues: cues.map((c, i) => ({ index: i, startSec: c.startSec, endSec: c.endSec, text: c.text })) }
}

export async function runReadSubtitleCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) throw new CliError('USAGE', '字幕ファイルが必要です。', 'mojioko read_subtitle <subtitle>')
  if (!existsSync(input)) throw new CliError('INPUT_NOT_FOUND', `字幕が見つかりません: ${input}`, 'パスを確認してください。')

  const withStyle = args.opts['with-style'] === true
  const withWords = args.opts['with-words'] === true
  // Settings are only needed for `autoLineBreak`, which is a project-level flag
  // rather than a cue field; skip the read entirely when style was not asked for.
  const styleOpts = withStyle ? { autoLineBreak: (await loadSettings()).autoLineBreak ?? true } : undefined

  const { format, cues, styleVaries } = readCues(input, optString(args.opts, 'format'), styleOpts, { withWords })

  const warnings: CliWarning[] = []
  if (withStyle && format === 'srt') {
    warnings.push({
      code: 'STYLE_UNAVAILABLE',
      message: 'SRT はスタイルを保持しないため --with-style は無視されました。',
      detail: { remedy: 'スタイルつきで読むには .mojioko を指定してください（mojioko convert で変換できます）。' },
    })
  }

  return emitSuccess(
    ctx,
    'read_subtitle',
    {
      path: input,
      format,
      cueCount: cues.length,
      ...(styleVaries !== undefined ? { styleVaries } : {}),
      cues,
    },
    warnings,
  )
}
