/**
 * REQ-0554 (design: RES-0552) — `mojioko edit_cues <in> -o <out> --edits <json>`.
 *
 * Patch any number of cues in one call: text, timing, delete flag, per-cue
 * style, and the emphasis spans that were previously unreachable from anywhere
 * but the GUI (`EMPHASIS_NO_SPANS`).
 *
 * ## Why one bulk tool rather than a tool per field
 *
 * RES-0552 §2-1: an agent asked to emphasise a keyword in fifty cues would need
 * fifty round-trips with per-field tools, and the MCP tool list — which rides
 * in every request's context — would grow past thirty entries. One patch tool
 * whose shape mirrors `read_subtitle --with_style` keeps both costs flat.
 *
 * ## What this file is, and is not
 *
 * I/O and reporting. The MEANING of a patch lives in `shared/cue-edit.ts` so
 * the CLI and MCP cannot drift; this reads the file, calls it, decides what to
 * warn about, and writes.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { parseProjectFile, serializeProjectFile } from '../../../shared/project-file'
import {
  WIDTH_AFFECTING_PATHS,
  applyCueEdit,
  collectCueEditWarnings,
  needsLineBreakRecheck,
  resolveSelection,
  validateCueEdits,
  type CueEdit,
} from '../../../shared/cue-edit'
import { resolveTier } from '../../lib/tier'
import { canUseKeywordEmphasisInTier } from '../../../shared/emphasis'
import { wrapCueText } from '../../../shared/cue-wrap'
import { getLineBreakMetrics } from '../../services/font-metrics-node'
import { ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext, type CliWarning } from '../output'
import { assertWritable } from '../overwrite'
import { detectFormat } from '../subtitle-io'
import type { SubtitleEntry } from '../../../shared/types'

/**
 * Width assumed when the project has no recorded resolution (an SRT-converted
 * `.mojioko` may have no `source`). 1920 matches `headless-layout`'s own
 * fallback, and the assumption is REPORTED rather than silent.
 */
const DEFAULT_WRAP_WIDTH_PX = 1920

/**
 * Append a warning unless its code is already present.
 *
 * Same rule the per-cue warnings follow: fifty cues with one problem is one
 * fact, not fifty lines for an agent to read (REQ-0554).
 */
function pushOnce(warnings: CliWarning[], notice: CliWarning): void {
  if (warnings.some((w) => w.code === notice.code)) return
  warnings.push(notice)
}

/** What happened to one selected cue. */
interface CueOutcome {
  id: string
  index: number
  changed: string[]
}

export async function runEditCuesCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const input = args.positionals[0] ?? optString(args.opts, 'input')
  if (!input) {
    throw new CliError('USAGE', '入力字幕が必要です。', 'mojioko edit_cues <in.mojioko> -o <out> --edits \'[...]\'')
  }
  if (!existsSync(input)) {
    throw new CliError('INPUT_NOT_FOUND', `入力が見つかりません: ${input}`, 'パスを確認してください。')
  }
  const out = optString(args.opts, 'out') ?? input
  if (out !== input) assertWritable(out, args.opts)

  /*
   * `.mojioko` only. A style patch has nowhere to land in an SRT — the format
   * carries no styling — and silently dropping the style half of a patch is
   * exactly the "no-op that lies" the contract forbids.
   */
  const inFmt = detectFormat(input, optString(args.opts, 'from'))
  if (inFmt !== 'mojioko') {
    throw new CliError('UNSUPPORTED_FORMAT', 'edit_cues は .mojioko のみ対応です。',
      'SRT にはスタイルが無いため、まず convert で .mojioko にしてください。')
  }

  // Inline JSON or a file. MCP passes the inline form (the tool runs the command
  // function in-process, so there is no command-line length limit); a human with
  // a large patch uses --edits-file.
  const editsFile = optString(args.opts, 'edits-file')
  const editsInline = optString(args.opts, 'edits')
  if (editsFile && editsInline !== undefined) {
    // Rejected rather than resolved by precedence: a rule about which one wins
    // is a rule someone has to know, and getting it wrong would silently apply
    // the patch the caller did not mean.
    throw new CliError('USAGE', '--edits と --edits-file は同時に指定できません。',
      'どちらか一方にしてください。')
  }
  if (!editsFile && editsInline === undefined) {
    throw new CliError('USAGE', '--edits <json> か --edits-file <path> が必要です。',
      '--edits \'[{"select":{"index":0},"text":"..."}]\'')
  }
  let rawEdits: unknown
  try {
    rawEdits = JSON.parse(editsFile ? readFileSync(editsFile, 'utf-8') : (editsInline as string))
  } catch (e) {
    throw new CliError('USAGE', 'edits の JSON を解析できません。', 'JSON 配列を渡してください。',
      { error: e instanceof Error ? e.message : String(e) })
  }

  const onError = optString(args.opts, 'on-error') ?? 'reject_all'
  if (onError !== 'reject_all' && onError !== 'apply_valid') {
    throw new CliError('USAGE', '--on-error は reject_all / apply_valid です。')
  }

  const { edits, problems } = validateCueEdits(rawEdits)

  const parsed = parseProjectFile(readFileSync(input, 'utf-8'))
  if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
  const project = parsed.project
  const entries = project.editing.subtitles

  // Resolve every selector before applying anything: an unresolvable id is a
  // problem of the same kind as a malformed field, and under `reject_all` it
  // must stop the whole call rather than half of it.
  const resolved: { edit: CueEdit; positions: number[] }[] = []
  edits.forEach((edit, editIndex) => {
    const { positions, missing } = resolveSelection(entries, edit.select)
    if (missing.length > 0) {
      problems.push({
        editIndex,
        message: `select が解決できません: ${missing.join(', ')}`,
        remedy: 'read_subtitle で id / index を確認してください。',
      })
      return
    }
    resolved.push({ edit, positions })
  })

  if (problems.length > 0 && onError === 'reject_all') {
    /*
     * ★ Nothing is written. RES-0552 §3-4: a subtitle file is one document, and
     * a half-applied patch leaves the agent unable to tell which state it is in
     * without re-reading. Retrying is cheap; guessing is not.
     */
    throw new CliError(
      'USAGE',
      `${problems.length} 件の不正な編集があるため、何も書き込みませんでした。`,
      '修正して再実行するか、有効な分だけ適用するには --on-error apply_valid を指定してください。',
      { problems, appliedCount: 0 },
    )
  }

  const warnings: CliWarning[] = []
  const outcomes: CueOutcome[] = []
  const isPaid = resolveTier().isPaid
  let applied = 0
  let unchanged = 0

  /*
   * REQ-0556 §2 — the wrap runs HERE rather than inside `applyCueEdit`, because
   * it is the one part of a patch that is not a pure function of the cue: it
   * needs the output width and the font's real metrics. Keeping `applyCueEdit`
   * pure is what lets the whole patch semantics be unit-tested without fonts.
   */
  const videoWidthPx = project.source?.resolution?.width ?? DEFAULT_WRAP_WIDTH_PX
  if (project.source?.resolution?.width === undefined && resolved.some((r) => r.edit.wrap)) {
    warnings.push({
      code: 'WRAP_ASSUMED_WIDTH',
      message: `この字幕には動画の解像度が記録されていないため、幅 ${DEFAULT_WRAP_WIDTH_PX}px と仮定して折り返しました。`,
      detail: { assumedWidthPx: DEFAULT_WRAP_WIDTH_PX,
        reason: 'SRT から変換した .mojioko には source が無いことがあります。',
        remedy: '実際の幅で折り返すには convert --video で動画を指定してください。' },
    })
  }

  for (const { edit, positions } of resolved) {
    for (const pos of positions) {
      const before = entries[pos]
      const { entry, changed } = applyCueEdit(before, edit)
      let final = entry
      if (edit.wrap) {
        // Applied to the ALREADY-PATCHED cue, so a patch that changes the font
        // size and re-wraps in one call measures at the new size.
        const wrapped = wrapCueText(final, edit.wrap, {
          videoWidthPx,
          marginLrPx: ASS_MARGIN_LR_PX,
          metrics: getLineBreakMetrics(final.fontId),
          // The same predicate the burn uses, so the wrap measures the glyph
          // sizes that will actually be rendered.
          emphasisTierAllowed: canUseKeywordEmphasisInTier(!isPaid),
        })
        if (wrapped !== final.text) {
          final = { ...final, text: wrapped, isEdited: true }
          changed.push('wrap')
        }
      }
      entries[pos] = final
      if (changed.length > 0) applied++
      else unchanged++
      outcomes.push({ id: final.id, index: visibleIndexOf(entries, pos), changed })
      collectCueEditWarnings(before, final, changed, isPaid, warnings)

      /*
       * ★ REQ-0563 — point at the next move, not just the last one.
       *
       * Emitted HERE rather than inside `collectCueEditWarnings` because the
       * condition includes "the caller did not already re-wrap", and `wrap` is
       * a property of the EDIT, which that function never sees. The judgement
       * itself is `needsLineBreakRecheck` in `shared/cue-edit.ts`, so it stays
       * testable without files or fonts.
       */
      if (needsLineBreakRecheck(changed, final, Boolean(edit.wrap))) {
        pushOnce(warnings, {
          code: 'LINE_BREAKS_MAY_BE_STALE',
          message: 'この cue には手動の改行（\\N）が入っていますが、今回の変更で文字の幅が変わった可能性があります（改行位置は自動では再計算されません）。',
          detail: {
            cueId: final.id,
            changed: changed.filter((c) => WIDTH_AFFECTING_PATHS.includes(c)),
            reason: '改行位置は保存時の幅で計算されたままなので、拡大やテキスト変更のあとは語の途中で折れることがあります。',
            remedy: '幅が変わった場合は wrap:"pack"（敷き詰め・既存の改行を捨てて詰め直す）または wrap:"overflow"（はみ出した行だけ折り直す）を同じ edit_cues で指定すると、改行を再計算できます。',
          },
        })
      }
    }
  }

  try {
    writeFileSync(out, serializeProjectFile(project), 'utf-8')
  } catch (e) {
    throw new CliError('OUTPUT_WRITE_FAILED', `出力を書き込めません: ${out}`,
      '出力先の権限・パスを確認してください。', { error: e instanceof Error ? e.message : String(e) })
  }

  return emitSuccess(ctx, 'edit_cues', {
    inputPath: input,
    outputPath: out,
    applied,
    unchanged,
    // Present only under apply_valid — under reject_all the call threw.
    ...(problems.length > 0 ? { failed: problems.length, problems } : {}),
    cues: outcomes,
  }, warnings)
}

/** `read_subtitle`'s index for a cue at array position `pos`. */
function visibleIndexOf(entries: readonly SubtitleEntry[], pos: number): number {
  let n = 0
  for (let i = 0; i < pos; i++) if (!entries[i].isDeleted) n++
  return entries[pos].isDeleted ? -1 : n
}
