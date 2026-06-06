import type { SubtitleEntry } from '../../shared/types'

/**
 * Binary-search the sorted, non-deleted `entries` array for the entry
 * active at `timeSec`.  Returns the entry's id, or null when no entry
 * covers the timestamp.
 *
 * Range semantics: **[startSec, endSec) — END EXCLUSIVE**.  The subtitle
 * is considered active from its startSec (inclusive) up to but not
 * including its endSec.  This matches standard subtitle player behaviour
 * and ASS / SRT semantics, and — critically — keeps the preview overlay
 * consistent with playback when the video parks exactly at duration
 * (REQ-079 #1).  With end-INCLUSIVE matching, stopping at `currentTime
 * === lastEntry.endSec` would keep the last subtitle painted on top of
 * the final frame; the exclusive boundary makes it disappear.
 *
 * Entries MUST be sorted by startSec ascending (the panels do this in a
 * memoised step on every entries mutation).
 *
 * Pure function — no React / DOM dependencies — so unit tests cover
 * the boundary conditions without having to mount a panel.
 */
export function findActiveEntryId(
  entries: readonly SubtitleEntry[],
  timeSec: number,
): string | null {
  let lo = 0
  let hi = entries.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const e = entries[mid]
    if (timeSec < e.startSec) {
      hi = mid - 1
    } else if (timeSec >= e.endSec) {
      lo = mid + 1
    } else {
      return e.id
    }
  }
  return null
}
