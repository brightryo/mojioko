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

/**
 * REQ-20260613-004: return EVERY entry active at `timeSec`, preserving the
 * input order.  Used by the preview overlay to render simultaneous captions
 * as a vertical stack so the preview matches the libass burn-in (which
 * auto-stacks overlapping Dialogue events on export).
 *
 * Range semantics match `findActiveEntryId`: **[startSec, endSec) — END
 * EXCLUSIVE**.  Entries MUST be sorted by `startSec` ascending; the early-
 * break on `e.startSec > timeSec` then makes the scan O(K) where K is the
 * number of entries whose `startSec` is ≤ timeSec, not O(N).
 *
 * Stack-order contract: the returned ids carry the SAME relative order as
 * the input array.  Callers (`video-preview-panel.tsx`) feed in
 * `sortedActiveEntries` whose stable sort by startSec preserves the
 * original entries-array order for same-startSec rows — that order in turn
 * matches the ASS Dialogue order in `ass-generator.ts:113-114`
 * (`entries.filter(!isDeleted)` is also order-preserving), so libass's
 * "first Dialogue at edge, later Dialogues push away from edge" stacking
 * aligns one-for-one with the preview.  Returning a sorted-by-id list
 * would break that alignment for duplicates inserted out of id order.
 *
 * Pure function — no React / DOM dependencies — so unit tests cover the
 * boundary and ordering conditions without having to mount a panel.
 */
export function findActiveEntryIds(
  entries: readonly SubtitleEntry[],
  timeSec: number,
): string[] {
  const ids: string[] = []
  for (const e of entries) {
    if (e.startSec > timeSec) break
    if (timeSec >= e.startSec && timeSec < e.endSec) {
      ids.push(e.id)
    }
  }
  return ids
}
