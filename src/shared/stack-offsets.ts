import type { SubtitleEntry } from './types'

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
 * **Input contract: `sortedEntries` MUST be ascending by `startSec`** (ties in
 * caller order = ASS Dialogue order).  Every call site sorts (ass-generator's
 * reference path), which is what the parameter name has always documented.
 *
 * Complexity: **O(N × C)** where C = the number of cues visible at once (the
 * "same-instant" concurrency), via a sliding window over the active priors
 * (REQ-0465 §1).  Because `startSec` is non-decreasing, a prior whose `endSec`
 * has passed the current `startSec` can never overlap a LATER entry, so it is
 * evicted once and never revisited — replacing the previous O(N²) rescan of
 * every earlier entry.  For sequential subtitles (C≈1) this is linear; the
 * output is **bit-identical** to the old rescan (pinned by
 * `tests/unit/stack-offsets-equivalence-req-0465.test.ts`, which compares this
 * against a naive reference on thousands of random sorted inputs), which is the
 * absolute condition for a function shared with the burn path.
 */
export function computeFixedStackOffsets(
  sortedEntries: readonly SubtitleEntry[],
  heightOf: (entry: SubtitleEntry) => number,
): Map<string, number> {
  const positions = new Map<string, number>()

  const groupKey = (e: SubtitleEntry): string =>
    `${e.horizontalPosition}_${e.verticalPosition}`

  const isPinned = (e: SubtitleEntry): boolean =>
    e.posX !== undefined && e.posY !== undefined

  // Sliding window of still-active priors (non-pinned entries already placed
  // whose `endSec` has not yet passed the current `startSec`).  Each carries its
  // FROZEN base (= verticalMarginPx-or-0 + its own offset) and height, so a
  // later entry reads them without a Map lookup or recomputation.  Because the
  // input is startSec-ascending, eviction (`endSec <= startSec`) is monotonic.
  const active: { endSec: number; keyE: string; base: number; height: number }[] = []

  for (let i = 0; i < sortedEntries.length; i++) {
    const e = sortedEntries[i]

    // Evict priors that have ended at-or-before this entry's start (end is
    // EXCLUSIVE, matching findActiveEntryId).  In-place compaction — no
    // per-entry allocation.  A prior removed here can never overlap a later
    // entry (its start is ≥ this one's), so it is gone for good.
    {
      let w = 0
      for (let r = 0; r < active.length; r++) {
        if (active[r].endSec > e.startSec) active[w++] = active[r]
      }
      active.length = w
    }

    // Pinned entries (\pos) render at their own coordinates — exclude them from
    // the stack entirely (no offset, not a prior for later entries).
    if (isPinned(e)) continue

    const heightE = heightOf(e)
    // REQ-0140 — center-aligned rows anchor at the viewport middle and ignore
    // verticalMarginPx (mirrors libass `\an4/5/6`).  Treat their base as 0 so a
    // `centre` group stacks around the middle.  top/bottom keep base = MarginV.
    const marginVe = e.verticalPosition === 'center' ? 0 : e.verticalMarginPx
    const keyE = groupKey(e)

    // Same-group active priors, sorted by base ascending — identical set and
    // order to the old full-rescan (which also filtered by group and time
    // overlap, then sorted by base).  `active` already encodes the time-overlap
    // (start ≤ e.start via input order, end > e.start via eviction above).
    const activePriors: { base: number; height: number }[] = []
    for (const p of active) {
      if (p.keyE === keyE) activePriors.push({ base: p.base, height: p.height })
    }
    activePriors.sort((a, b) => a.base - b.base)

    // Greedy gap-fill — `effectiveBase` tracks the lowest position e can occupy
    // without colliding with any prior we've seen so far.  Start at e's own
    // MarginV; for each prior in ascending order, either drop into the gap above
    // (if a prior's base ≥ our top edge) or climb above the prior and continue.
    let effectiveBase = marginVe
    for (const p of activePriors) {
      if (p.base >= effectiveBase + heightE) break
      effectiveBase = Math.max(effectiveBase, p.base + p.height)
    }

    // Returned value is RELATIVE to entry.verticalMarginPx.  For the single-row
    // case the result is 0 regardless of MarginV (v1.0/v1.1 contract).
    positions.set(e.id, effectiveBase - marginVe)

    // Register e as a prior for later overlapping entries.  Its base is
    // `effectiveBase` (= marginVe + the offset just stored), matching exactly
    // what the old code recomputed as `priorMargin + priorOffset`.
    active.push({ endSec: e.endSec, keyE, base: effectiveBase, height: heightE })
  }
  return positions
}
