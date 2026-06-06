import type { SubtitleEntry } from '../../shared/types'
import { origToEdited, type CutList } from '../../shared/cuts'

/**
 * Collect every non-deleted entry's startSec and endSec, translate them
 * to the EDITED axis (so they match what the user sees), dedupe identical
 * timestamps, and sort ascending.
 *
 * Used by the playhead nav buttons (REQ-077 #4) so that
 *   - stacked block edges where one entry ends exactly when the next
 *     begins count as a single jump target (no two-press wobble at the
 *     same Edited coordinate)
 *   - blocks fully contained in a cut contribute no boundary (their
 *     origToEdited collapse already coincides with whichever cut point
 *     is in the set anyway)
 *
 * Pure function — no React / DOM dependencies — so it can be unit-tested
 * directly and reused from any caller that needs the same boundary set.
 */
export function buildBoundarySet(
  entries: readonly SubtitleEntry[],
  cuts: CutList,
): number[] {
  const seen = new Set<number>()
  for (const e of entries) {
    if (e.isDeleted) continue
    seen.add(origToEdited(e.startSec, cuts))
    seen.add(origToEdited(e.endSec, cuts))
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * Largest boundary strictly less than `t`, or null when none exists.
 * Strict comparison so a playhead sitting exactly on a boundary jumps
 * to the one before, not to itself (the user pressed "prev" because
 * they want to move).
 *
 * `boundaries` must be sorted ascending (= buildBoundarySet output).
 */
export function findPrevBoundary(
  t: number,
  boundaries: readonly number[],
): number | null {
  let lo = 0
  let hi = boundaries.length - 1
  let best: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (boundaries[mid] < t) {
      best = boundaries[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * Smallest boundary strictly greater than `t`, or null when none exists.
 * Same strict-comparison rationale as findPrevBoundary.
 */
export function findNextBoundary(
  t: number,
  boundaries: readonly number[],
): number | null {
  let lo = 0
  let hi = boundaries.length - 1
  let best: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (boundaries[mid] > t) {
      best = boundaries[mid]
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return best
}
