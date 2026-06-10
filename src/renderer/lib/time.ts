import { origToEdited, type CutList } from '../../shared/cuts'
import type { SubtitleEntry } from '../../shared/types'

/** Format seconds to "HH:MM:SS.cc" (centiseconds, 2 digits). */
export function formatTimecode(sec: number): string {
  const totalCs = Math.round(sec * 100)
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const s = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const m = totalMin % 60
  const h = Math.floor(totalMin / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** Format seconds to "HH:MM:SS" (no centiseconds, for display). */
export function formatDuration(sec: number): string {
  const s = Math.floor(sec) % 60
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Parse "HH:MM:SS.cc" → seconds. Returns NaN if invalid. */
export function parseTimecode(tc: string): number {
  const match = tc.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/)
  if (!match) return NaN
  const [, h, m, s, cs] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs) / 100
}

/** Format seconds as rough human-readable estimate ("~2 min", "~45 sec"). */
export function formatEstimatedTime(sec: number): string {
  if (sec < 60) return `~${Math.round(sec)} sec`
  return `~${Math.round(sec / 60)} min`
}

/**
 * REQ-115 — format an Original-axis time as a timecode on the EDITED axis.
 *
 * `originalSec` is the value stored on a `SubtitleEntry` (= Original axis,
 * data-non-destructive contract).  `cuts` is the current cut list; if empty,
 * `origToEdited` is the identity and this collapses to `formatTimecode`
 * (= bit-identical to the no-trim path).
 *
 * Used by every UI surface where the user reads a subtitle time: the
 * subtitle-table TimeInput, the timeline-block-inspector start/end row,
 * the timeline-view block-internal timecode, the TimeEditorDialog
 * snap-target labels.  The unification matches the SRT/TXT export
 * (REQ-103 §D, already Edited axis) and the video preview / ruler
 * (already Edited axis) so the user sees the same number everywhere.
 */
export function formatEditedTimecode(originalSec: number, cuts: CutList): string {
  return formatTimecode(origToEdited(originalSec, cuts))
}

/**
 * REQ-115 — visible-on-the-Edited-axis duration of a subtitle entry.
 *
 * Returns `origToEdited(entry.endSec) - origToEdited(entry.startSec)`.
 * For an entry untouched by cuts this is identical to
 * `entry.endSec - entry.startSec`.  For partial-cut entries (head clamp,
 * tail clamp, middle cut) the result equals the entry's `visibleSec`
 * (= `applyCutsToEntry(entry, cuts)?.visibleSec`) — both functions
 * derive from the same coordinate transforms.
 *
 * Used by the timeline-block-inspector duration line so the number the
 * user reads matches what the burnin video would show.  Floored at 0
 * because `origToEdited` is monotonic — start ≤ end on Original implies
 * start ≤ end on Edited — but the guard protects against degenerate
 * entries (startSec > endSec) that could otherwise show a negative
 * duration.
 */
export function editedDurationOfEntry(entry: SubtitleEntry, cuts: CutList): number {
  return Math.max(
    0,
    origToEdited(entry.endSec, cuts) - origToEdited(entry.startSec, cuts),
  )
}
