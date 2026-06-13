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
 * REQ-20260613-006 + REQ-20260613-016 Phase 3 — libass-faithful
 * `fix_collisions` replication, extended for the v1.2.2 per-row data
 * model.
 *
 * Positions are decided ONCE per entry at its startSec moment (looking at
 * priors already placed AND still active at that moment) and frozen for
 * the rest of the entry's lifetime.  Later entries that arrive after
 * another entry has ended drop into the freed gap; entries already on
 * screen never move when a neighbour ends.
 *
 * **Per-row extensions** (REQ-20260613-016 Phase 3):
 *
 *   1. **Group by alignment key** (`${horizontalPosition}_${verticalPosition}`).
 *      libass only collides events that share an alignment — a
 *      bottom-center event and a top-center event do NOT interact.
 *      This implementation honours the same partition: an entry's
 *      "priors" are only same-group entries.
 *   2. **Per-row MarginV as the base position.**  Each entry's
 *      effective base position = `entry.verticalMarginPx` (interpreted
 *      as distance from the edge the alignment anchors against — top
 *      for 7/8/9, bottom for 1/2/3).  Two entries in the same group
 *      with different MarginV values do NOT collide unless their
 *      occupied vertical bands actually intersect — matching libass's
 *      per-event MarginV behaviour.
 *   3. **Pinned entries (`\pos`, REQ-20260613-016 / 機能B)** are
 *      excluded from the stack altogether — they neither act as
 *      priors nor receive an offset.  An entry is treated as pinned
 *      when both `posX` and `posY` are defined.  Phase 6 wires up the
 *      drag UI; Phase 3 codifies the exclusion now so the algorithm
 *      stays consistent through the whole feature work.
 *
 * Algorithm:
 *
 *   For each entry `e` in caller-provided order:
 *     - skip if pinned (both posX and posY defined)
 *     - find priors `p` such that:
 *         * groupKey(p) === groupKey(e)
 *         * p is not pinned
 *         * p.startSec <= e.startSec < p.endSec  (overlap; <= on start
 *           captures same-instant siblings)
 *     - each prior contributes a (effectiveBase, height) interval:
 *         effectiveBase_p = p.verticalMarginPx + positions[p.id]
 *     - sort priors by effectiveBase ascending; walk them looking for
 *       a gap of size `heightE` below the lowest unblocked position.
 *       Start the walk at `e.verticalMarginPx` (= e's own preferred
 *       base) — if a prior sits below that, our effective position
 *       climbs above the prior; if there's a gap big enough, we drop
 *       into it.
 *     - record the **relative** offset = (final effectiveBase) - e.verticalMarginPx
 *       in `positions`.  Returning the relative offset (not the
 *       absolute base) preserves backward compatibility with the
 *       v1.0/v1.1 tests where every entry shared the same MarginV
 *       (the relative offset for the 1st same-group entry is 0
 *       regardless of MarginV).
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

  const groupKey = (e: SubtitleEntry): string =>
    `${e.horizontalPosition}_${e.verticalPosition}`

  const isPinned = (e: SubtitleEntry): boolean =>
    e.posX !== undefined && e.posY !== undefined

  for (let i = 0; i < sortedEntries.length; i++) {
    const e = sortedEntries[i]
    // Pinned entries (\pos) render at their own coordinates — exclude
    // them from the stack entirely (no offset, not a prior for later
    // entries).  Phase 6 wires the drag UI; the exclusion is encoded
    // here so the algorithm is consistent through the whole feature.
    if (isPinned(e)) continue

    const heightE = heightOf(e)
    const marginVe = e.verticalMarginPx
    const keyE = groupKey(e)
    heights.set(e.id, heightE)

    // Collect already-placed priors that:
    //   - share alignment group with e (libass collides per group only)
    //   - are not themselves pinned (pinned entries don't block stack)
    //   - overlap e.startSec in time (start INCLUSIVE / end EXCLUSIVE,
    //     same as findActiveEntryId boundary semantics)
    const activePriors: { base: number; height: number }[] = []
    for (let j = 0; j < i; j++) {
      const p = sortedEntries[j]
      if (isPinned(p)) continue
      if (groupKey(p) !== keyE) continue
      if (p.startSec <= e.startSec && p.endSec > e.startSec) {
        const priorOffset = positions.get(p.id) ?? 0
        const priorBase = p.verticalMarginPx + priorOffset
        activePriors.push({
          base: priorBase,
          height: heights.get(p.id) ?? 0,
        })
      }
    }
    activePriors.sort((a, b) => a.base - b.base)

    // Greedy gap-fill — `effectiveBase` tracks the lowest position e
    // can occupy without colliding with any prior we've seen so far.
    // Start at e's own MarginV; for each prior in ascending order,
    // either drop into the gap above (if a prior's base ≥ our top
    // edge) or climb above the prior and continue.
    let effectiveBase = marginVe
    for (const p of activePriors) {
      if (p.base >= effectiveBase + heightE) break
      effectiveBase = Math.max(effectiveBase, p.base + p.height)
    }

    // Returned value is RELATIVE to entry.verticalMarginPx.  For the
    // single-row case the result is 0 regardless of MarginV, matching
    // the v1.0/v1.1 contract used by the existing tests.
    positions.set(e.id, effectiveBase - marginVe)
  }
  return positions
}
