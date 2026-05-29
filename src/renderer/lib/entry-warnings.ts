import type { SubtitleEntry } from '../../shared/types'

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
 */
export function computeEntryWarnings(
  entry: SubtitleEntry,
  prevActiveEndSec: number | null,
  videoDurationSec: number,
  isOverflow: boolean
): EntryWarnings {
  const timeInvalid =
    entry.endSec <= entry.startSec ||
    (entry.startSec === 0 && entry.endSec === 0)

  const overDuration =
    entry.startSec > videoDurationSec ||
    entry.endSec > videoDurationSec

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
    overflow: isOverflow
  }
}

/**
 * True when the "Warnings" tab should count the row.
 *
 * Note: `emptyText` is classified as an ERROR rather than a warning — it
 * unconditionally excludes the row from every output (TXT, SRT, burn-in,
 * Ready tab) — and is therefore deliberately excluded from this predicate
 * so a text-empty row is NOT counted in the Warnings tab.  The "テキスト未入力"
 * badge is still rendered separately by the table for visual cues.
 */
export function hasAnyWarning(w: EntryWarnings): boolean {
  return (
    w.timeInvalid ||
    w.overDuration ||
    w.overlap ||
    w.invalidSize ||
    w.overflow
  )
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
