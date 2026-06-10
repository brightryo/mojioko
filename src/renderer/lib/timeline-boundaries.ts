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
 * Distance (seconds) within which a boundary is treated as the playhead's
 * "current" position rather than as a navigable target.  Without this slack
 * a video-element seek that landed at 64.6299 (1 ms shy of a 64.63 boundary
 * because of HTML5 video keyframe-snap drift) would let `findNextBoundary`
 * return 64.63 itself — a sub-millisecond seek the user perceives as
 * "nothing happened."  The "next" press from such a position must skip
 * over the boundary the playhead is effectively on and reach the next
 * one (e.g. the far end of the long block the user is inside).
 *
 * 1 ms matches the float-equality convention used by timeline-layout's
 * TIME_EPS_SEC, is comfortably below Whisper's centisecond output
 * precision (10 ms), and is far below human-perceptible playback motion.
 */
export const NAV_EPS_SEC = 1e-3

/**
 * Largest boundary at least `NAV_EPS_SEC` before `t`, or null when none
 * exists.  Treats boundaries within ±NAV_EPS_SEC of `t` as "we're already
 * on this boundary" so the user pressing "prev" skips over it and reaches
 * the genuinely-previous one (= the boundary before the long block they
 * are inside).
 *
 * `boundaries` must be sorted ascending (= buildBoundarySet output).
 */
export function findPrevBoundary(
  t: number,
  boundaries: readonly number[],
): number | null {
  const threshold = t - NAV_EPS_SEC
  let lo = 0
  let hi = boundaries.length - 1
  let best: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (boundaries[mid] < threshold) {
      best = boundaries[mid]
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

/**
 * Smallest boundary at least `NAV_EPS_SEC` after `t`, or null when none
 * exists.  Same epsilon-tolerance rationale as findPrevBoundary: a
 * playhead sitting on a boundary (or 0.x ms away from one due to HTML5
 * video seek drift) must jump to the NEXT boundary, not back to the one
 * it is effectively already on.
 */
export function findNextBoundary(
  t: number,
  boundaries: readonly number[],
): number | null {
  const threshold = t + NAV_EPS_SEC
  let lo = 0
  let hi = boundaries.length - 1
  let best: number | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (boundaries[mid] > threshold) {
      best = boundaries[mid]
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return best
}
