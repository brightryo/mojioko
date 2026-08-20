import type { SubtitleEntry } from '../../shared/types'
import { isCueBeyondVideoEnd } from '../../shared/cue-duration'

/**
 * Per-entry warning flags consumed by the Step 2 table.  Any `true` flag here
 * disqualifies the row from the Ready tab and is shown as a coloured badge in
 * the state column.
 *
 * `overflow` is sourced from the precomputed overflow map (which already
 * applies libassScale + font metrics), not recomputed here — keeping width
 * calculation in its dedicated module.
 */
export interface EntryWarnings {
  /** end ≤ start, or both unset (= 0). */
  timeInvalid: boolean
  /** start or end exceeds the video's total duration. */
  overDuration: boolean
  /** start time is earlier than the previous non-deleted row's end. */
  overlap: boolean
  /** Text is empty after stripping ASS \N line breaks and surrounding whitespace. */
  emptyText: boolean
  /** Font size is non-positive. */
  invalidSize: boolean
  /** Text width exceeds the available video width (libass-equivalent). */
  overflow: boolean
  /**
   * REQ-0456 — the cue's stacked line height exceeds the video height (the
   * vertical analogue of `overflow`).  Sourced from a precomputed vertical map
   * in Step 2, matching the headless `--overflow` guard.
   */
  verticalOverflow: boolean
}

/**
 * Compute every warning flag for one subtitle entry.
 *
 * @param entry              The entry under inspection.
 * @param prevActiveEndSec   `endSec` of the most recent non-deleted entry
 *                           preceding this one (null for the first row /
 *                           when no preceding active row exists).
 * @param videoDurationSec   Total duration of the loaded video.  Pass
 *                           `Infinity` when no video is loaded; the duration
 *                           checks then never fire.
 * @param isOverflow         Result from the overflow calculator
 *                           (`overflowMap.has(entry.id)` in Step 2).
 * @param isVerticalOverflow REQ-0456 — the cue's stacked height exceeds the
 *                           video height (`verticalOverflowMap.has(entry.id)`).
 *                           Defaults to `false` for callers that do not measure
 *                           it (e.g. the burn-in drawer summary).
 */
export function computeEntryWarnings(
  entry: SubtitleEntry,
  prevActiveEndSec: number | null,
  videoDurationSec: number,
  isOverflow: boolean,
  isVerticalOverflow = false
): EntryWarnings {
  const timeInvalid =
    entry.endSec <= entry.startSec ||
    (entry.startSec === 0 && entry.endSec === 0)

  /*
   * REQ-0528 §2-4 — KEPT after the §2 clamp, and deliberately so.
   *
   * The question the REQ asks is whether clamping makes this unreachable, i.e.
   * whether it becomes an advertised warning with nothing behind it.  It does
   * not: the clamp governs what the GUI newly WRITES, while this flag describes
   * what a project can CONTAIN, and those are not the same set.  It still fires
   * for:
   *
   *   1. Projects relinked to a shorter video.  `project-open-controller`'s
   *      identity-mismatch dialog explicitly offers this and shows the two
   *      durations side by side, so a user can knowingly attach a 7 s video to
   *      a project cut against a 20 s one.
   *   2. Projects saved before REQ-0528, which are not rewritten on open
   *      (§2-5 — silently truncating someone's existing work is destructive,
   *      so it is not done).
   *   3. `.mojioko` files produced by the CLI / MCP, which perform no duration
   *      validation on cue times at all.
   *
   * In every one of those the cue is excluded from THIS app's burn by
   * `isBurninTarget` below, so without this badge the cue would simply be
   * missing from the output video with nothing on screen explaining why.  That
   * is the failure it exists to prevent, and the clamp does not remove it.
   *
   * ★ REQ-0529 correction to the sentence above: "excluded from the burn" is
   * true of the GUI ONLY.  `isBurninTarget` is applied in `burnin-drawer.tsx`
   * before the IPC request is built, so the main process never receives such a
   * cue from the GUI — but the CLI/MCP load cues straight out of the `.mojioko`
   * and apply no equivalent gate, so headlessly the cue IS handed to libass and
   * its in-video portion IS drawn (measured on real pixels, RES-0529 §1-2).
   * Case 3 above therefore describes a file the GUI opens, not what the CLI
   * does with it.  The divergence is reported in RES-0529, not papered over.
   *
   * REQ-0529 §1-1 — the predicate itself moved to `shared/cue-duration.ts` so
   * the headless `CUE_BEYOND_VIDEO_END` warning asks the identical question.
   * Rewriting it there would have been the drift this codebase keeps paying
   * for; this badge and that warning are now one test.
   */
  const overDuration = isCueBeyondVideoEnd(entry, videoDurationSec)

  const overlap =
    prevActiveEndSec !== null && entry.startSec < prevActiveEndSec

  // Strip ASS hard line breaks (\N) before trimming so a row containing only
  // line-break markers is still treated as empty.
  const trimmed = entry.text.replace(/\\N/g, '').trim()
  const emptyText = trimmed === ''

  const invalidSize = entry.fontSizePx <= 0

  return {
    timeInvalid,
    overDuration,
    overlap,
    emptyText,
    invalidSize,
    overflow: isOverflow,
    verticalOverflow: isVerticalOverflow
  }
}

/**
 * REQ-121 — classification of the six `EntryWarnings` flags into
 * "errors" (= ffmpeg + libass physically cannot render the row, so the
 * export must stop) and "warnings" (= the row still ships, the user may
 * leave it).  Split as confirmed by the owner in RES-20260601-120 §3.1:
 *
 *   errors   = timeInvalid (start ≥ end), overDuration (times outside
 *              the video duration), invalidSize (fontSizePx ≤ 0)
 *   warnings = emptyText (skipped from outputs but does not block burn-in),
 *              overlap (libass renders simultaneous captions),
 *              overflow (libass clips wide text)
 *
 * Both predicates are pure boolean ORs over the type's flags; together
 * they cover all six fields without overlap.
 */
export function isError(w: EntryWarnings): boolean {
  return w.timeInvalid || w.overDuration || w.invalidSize
}

export function isWarning(w: EntryWarnings): boolean {
  return w.emptyText || w.overlap || w.overflow || w.verticalOverflow
}

/**
 * Alias for {@link isError}.  Kept as a separate name so callers that
 * read like "do any rows have errors?" stay grep-friendly even though
 * the implementation is the per-row predicate.
 */
export function hasAnyError(w: EntryWarnings): boolean {
  return isError(w)
}

/**
 * REQ-121 — true when the row should appear in the "Issues" tab
 * (= the renamed "Warnings" tab; carries BOTH errors and warnings so
 * the user has a single place to look for things to fix).  See
 * {@link isError} and {@link isWarning} for the split.
 *
 * History: before REQ-121 this returned errors AND warnings as a single
 * mixed "warnings" group, and `emptyText` was deliberately excluded
 * because the codebase treated empty text as an export-blocker.
 * REQ-121 promoted `emptyText` to a warning (it is silently dropped
 * from outputs but does not block them) and added the matching
 * `errorCount` gate on the Step 3 transition (see `step2.tsx`).
 */
export function hasAnyWarning(w: EntryWarnings): boolean {
  return isWarning(w)
}

/**
 * True when the row is included in the Ready / Output count and exported
 * to text-based outputs (TXT, SRT).
 *
 * Rationale: warnings (overlap, time invalid, over-duration, invalid size,
 * overflow) still produce valid text content, and the user may want them
 * exported so they can fix the issue in an external editor.  Only the two
 * "error" conditions — empty text and soft-deleted — drop the row.
 */
export function isOutputTarget(entry: SubtitleEntry, w: EntryWarnings): boolean {
  return !entry.isDeleted && !w.emptyText
}

/**
 * True when the row is included in the ffmpeg + ASS burn-in.
 *
 * Stricter than {@link isOutputTarget}: in addition to dropping deleted and
 * empty rows, also drops rows that the ASS renderer cannot physically
 * process — invalid time ordering (`endSec ≤ startSec`), times beyond the
 * video's duration, or a non-positive font size.  Overlap and overflow are
 * fine: libass renders simultaneous captions and tolerates overflowing
 * text widths.
 */
export function isBurninTarget(entry: SubtitleEntry, w: EntryWarnings): boolean {
  return (
    isOutputTarget(entry, w) &&
    !w.timeInvalid &&
    !w.overDuration &&
    !w.invalidSize
  )
}
