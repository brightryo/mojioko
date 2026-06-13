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

/**
 * REQ-20260613-006: precompute each entry's vertical stack offset by
 * faithfully replicating libass's `fix_collisions` semantics — positions
 * are decided ONCE per entry at its startSec moment, then frozen for the
 * rest of the entry's lifetime.  Later entries that arrive after another
 * entry has ended fill the freed gap; entries already on screen never
 * move when a neighbour ends.
 *
 * This is the fix for the REQ-004 regression where the preview re-packed
 * stacks every frame and visibly shifted survivors downward when an
 * earlier caption disappeared (= the discrepancy reported in
 * VERIFY-20260613-001 and analysed in RES-20260613-005).
 *
 * Algorithm (RES-20260613-005 §Q3 confirmed by VERIFY-20260613-001):
 *
 *   1. Iterate entries in their CALLER-PROVIDED order.  The caller
 *      (`video-preview-panel.tsx`) feeds the stable-sorted
 *      `sortedActiveEntries`, so this order is (startSec ascending,
 *      original entries-array order tiebreak) — identical to the ASS
 *      Dialogue order on burn-in.
 *   2. For each entry `e`, look at every entry already iterated whose
 *      lifetime covers `e.startSec` (= `prior.startSec <= e.startSec
 *      < prior.endSec`).  Note the `<=` on startSec: same-instant
 *      siblings count as "already placed" because they were processed
 *      first in the iteration (same as libass's script-order tiebreak).
 *   3. Sort those priors by their already-assigned offset ascending.
 *      Walk them from lowest to highest; if a gap >= e's height opens
 *      up before a prior, place e in that gap; otherwise climb above
 *      the prior and continue.  This is the greedy "fill the lowest
 *      large-enough gap" behaviour the SSA spec documents for
 *      Collisions: Normal ("filling in gaps in other subtitles if one
 *      large enough is available").
 *   4. Record e's offset in `positions`.  Subsequent iterations see
 *      this offset as a fixed prior — exactly mirroring libass's
 *      `priv->height > 0 → fixed event` branch in `fix_collisions`.
 *
 * Output offsets are pixel distances from the burn-in edge (`MarginV`).
 * For bottom-aligned subtitles the caller adds the offset to the
 * SubtitleOverlay's `bottom`; for top-aligned, to the `top`.  The
 * algorithm itself is alignment-agnostic.
 *
 * Pure function — height calculation is injected via `heightOf` so the
 * lib stays free of component imports and unit tests can pass simple
 * constants (see tests/unit/active-entry.test.ts).
 *
 * Complexity: O(N²) in the worst case (each entry walks every prior).
 * Caller memoises on entries / scale changes only, so the cost is
 * paid once per entries mutation (~rare during playback), not per
 * playhead tick.
 */
export function computeFixedStackOffsets(
  sortedEntries: readonly SubtitleEntry[],
  heightOf: (entry: SubtitleEntry) => number,
): Map<string, number> {
  const positions = new Map<string, number>()
  const heights = new Map<string, number>()
  for (let i = 0; i < sortedEntries.length; i++) {
    const e = sortedEntries[i]
    const heightE = heightOf(e)
    heights.set(e.id, heightE)
    // Collect already-placed priors whose lifetime covers e.startSec.
    // Using `prior.startSec <= e.startSec` (not strict <) is critical for
    // same-instant siblings (e.g. duplicates from REQ-20260613-001) so
    // the first one processed acts as a "fixed event" for the next.
    const activePriors: { offset: number; height: number }[] = []
    for (let j = 0; j < i; j++) {
      const p = sortedEntries[j]
      if (p.startSec <= e.startSec && p.endSec > e.startSec) {
        activePriors.push({
          offset: positions.get(p.id) ?? 0,
          height: heights.get(p.id) ?? 0,
        })
      }
    }
    activePriors.sort((a, b) => a.offset - b.offset)
    // Greedy gap-fill scan.  `offset` tracks the lowest position e could
    // occupy without colliding with any prior we've seen so far.  When a
    // prior's offset is >= offset + heightE there's a gap big enough for
    // e to drop into; otherwise climb above that prior and continue.
    let offset = 0
    for (const p of activePriors) {
      if (p.offset >= offset + heightE) break
      offset = Math.max(offset, p.offset + p.height)
    }
    positions.set(e.id, offset)
  }
  return positions
}
