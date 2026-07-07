import { describe, it, expect } from 'vitest'
import {
  findActiveEntryId,
  findActiveEntryIds,
  computeFixedStackOffsets,
} from '../../src/renderer/lib/active-entry'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

function entry(id: string, startSec: number, endSec: number): SubtitleEntry {
  const base = {
    startSec,
    endSec,
    text: id,
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    ...makeEntryLayoutDefaults(),
  }
  return { id, ...base, isDeleted: false, isEdited: false, original: { ...base } }
}

describe('findActiveEntryId — [start, end) boundary semantics', () => {
  const entries = [entry('a', 1, 3), entry('b', 5, 8), entry('c', 10, 12)]

  it('returns null before the first entry', () => {
    expect(findActiveEntryId(entries, 0)).toBeNull()
    expect(findActiveEntryId(entries, 0.999)).toBeNull()
  })

  it('returns the entry id when timeSec is inside (startSec, endSec)', () => {
    expect(findActiveEntryId(entries, 2)).toBe('a')
    expect(findActiveEntryId(entries, 6.5)).toBe('b')
    expect(findActiveEntryId(entries, 11)).toBe('c')
  })

  it('start boundary is INCLUSIVE — timeSec === startSec matches', () => {
    expect(findActiveEntryId(entries, 1)).toBe('a')
    expect(findActiveEntryId(entries, 5)).toBe('b')
    expect(findActiveEntryId(entries, 10)).toBe('c')
  })

  /**
   * REQ-080 #1 anchor: end boundary is EXCLUSIVE — timeSec === endSec
   * yields null (or the next entry, if one starts there).  This is the
   * fix that keeps the last subtitle from staying painted on top of the
   * final frame when the video parks at duration.
   */
  it('end boundary is EXCLUSIVE — timeSec === endSec is past the entry', () => {
    expect(findActiveEntryId(entries, 3)).toBeNull()       // gap after a
    expect(findActiveEntryId(entries, 8)).toBeNull()       // gap after b
    expect(findActiveEntryId(entries, 12)).toBeNull()      // past c (= EOF case)
  })

  it('contact: entry-end === next-entry-start picks the NEXT entry', () => {
    // Contiguous Whisper segments often boundary-touch.  The exclusive
    // end + inclusive start convention means the boundary moment belongs
    // to the LATER entry — no flicker, no double-paint.
    const contiguous = [entry('a', 0, 5), entry('b', 5, 10)]
    expect(findActiveEntryId(contiguous, 5)).toBe('b')
  })

  it('returns null in gaps between entries', () => {
    expect(findActiveEntryId(entries, 4)).toBeNull()
    expect(findActiveEntryId(entries, 9)).toBeNull()
  })

  it('returns null past the last entry (EOF / video parked at duration)', () => {
    expect(findActiveEntryId(entries, 12)).toBeNull()      // exact end of c
    expect(findActiveEntryId(entries, 12.5)).toBeNull()    // beyond c
    expect(findActiveEntryId(entries, 100)).toBeNull()
  })

  it('returns null for empty entries list', () => {
    expect(findActiveEntryId([], 5)).toBeNull()
  })
})

/**
 * REQ-20260613-004: multi-active lookup used by the preview overlay to
 * render simultaneous captions as a vertical stack matching libass's
 * collision-avoidance order on burn-in.
 *
 * Range semantics are identical to `findActiveEntryId` (= [start, end));
 * the contract additionally guarantees that the returned ids carry the
 * SAME relative order as the input array, so the caller's stable-sorted
 * sortedActiveEntries flows through to the ASS Dialogue order without
 * an extra resort step.
 */
describe('findActiveEntryIds — multi-active lookup', () => {
  it('returns an empty array when no entry covers timeSec', () => {
    expect(findActiveEntryIds([], 5)).toEqual([])
    expect(findActiveEntryIds([entry('a', 1, 3)], 4)).toEqual([])
    expect(findActiveEntryIds([entry('a', 1, 3), entry('b', 5, 8)], 4)).toEqual([])
  })

  it('returns a single id when only one entry covers timeSec (= legacy case)', () => {
    const entries = [entry('a', 1, 3), entry('b', 5, 8), entry('c', 10, 12)]
    expect(findActiveEntryIds(entries, 2)).toEqual(['a'])
    expect(findActiveEntryIds(entries, 6.5)).toEqual(['b'])
  })

  it('returns every id when multiple entries share the same span', () => {
    // Three identical-span entries: the duplicate-row case from
    // RES-20260613-003 §Q1.  All three are active at the same time.
    const entries = [entry('test1', 5, 10), entry('test2', 5, 10), entry('test3', 5, 10)]
    expect(findActiveEntryIds(entries, 7)).toEqual(['test1', 'test2', 'test3'])
  })

  it('preserves input order — first entry in array is first in result', () => {
    // Stack-order contract: the caller (= video-preview-panel) feeds in a
    // stably-sorted array whose order matches the ASS Dialogue order on
    // burn-in (`ass-generator.ts:113-114` is also order-preserving).
    // Reversing the input must reverse the output.
    const a = entry('a', 5, 10)
    const b = entry('b', 5, 10)
    const c = entry('c', 5, 10)
    expect(findActiveEntryIds([a, b, c], 7)).toEqual(['a', 'b', 'c'])
    expect(findActiveEntryIds([c, b, a], 7)).toEqual(['c', 'b', 'a'])
  })

  it('mixes overlapping and non-overlapping entries correctly', () => {
    // a covers [1,3]; b and c both cover [2,5]; d covers [10,12].
    // At time 2.5, expect a, b, c (in input order); d is excluded.
    const entries = [
      entry('a', 1, 3),
      entry('b', 2, 5),
      entry('c', 2, 5),
      entry('d', 10, 12),
    ]
    expect(findActiveEntryIds(entries, 2.5)).toEqual(['a', 'b', 'c'])
  })

  it('end boundary is EXCLUSIVE for every covered entry', () => {
    // Three identical-span entries: at exact endSec the entire stack
    // disappears together — no half-staircase of leftover captions.
    const entries = [entry('a', 5, 10), entry('b', 5, 10), entry('c', 5, 10)]
    expect(findActiveEntryIds(entries, 10)).toEqual([])
  })

  it('start boundary is INCLUSIVE for every covered entry', () => {
    const entries = [entry('a', 5, 10), entry('b', 5, 10), entry('c', 5, 10)]
    expect(findActiveEntryIds(entries, 5)).toEqual(['a', 'b', 'c'])
  })

  it('early-break on sorted input does not skip same-start later entries', () => {
    // Regression guard: the production caller passes entries sorted by
    // startSec ascending.  The `e.startSec > timeSec` early-break must
    // never fire for entries whose startSec === timeSec, otherwise
    // duplicates at exactly the playhead would be silently dropped.
    const entries = [entry('a', 0, 5), entry('b', 5, 10), entry('c', 5, 10)]
    expect(findActiveEntryIds(entries, 5)).toEqual(['b', 'c'])
  })
})

/**
 * REQ-20260613-006: libass-faithful `fix_collisions` replication.  Each
 * entry's vertical stack offset is decided ONCE at its startSec moment
 * (looking at priors already placed AND still active at that moment)
 * and frozen for the rest of the entry's lifetime.  Later entries that
 * arrive after another entry has ended drop into the freed gap.  These
 * tests pin the algorithm against the empirical libass behaviour
 * confirmed in VERIFY-20260613-001.
 *
 * Height function is injected so the tests can use constant heights
 * (= 10 px each unless otherwise noted) and reason about pixel offsets
 * without dragging in component metrics.
 */
describe('computeFixedStackOffsets — libass fix_collisions replication', () => {
  const h = () => 10  // every entry is 10 px tall by default

  it('empty input → empty map', () => {
    expect(computeFixedStackOffsets([], h).size).toBe(0)
  })

  it('single entry → offset 0', () => {
    const result = computeFixedStackOffsets([entry('a', 0, 5)], h)
    expect(result.get('a')).toBe(0)
  })

  it('same-time triplet stacks in input order (= ASS Dialogue order)', () => {
    // The REQ-20260613-001 duplicate case: three identical-span entries.
    // The first goes to the burnin edge (offset 0); subsequent entries
    // stack on top in their array order — matches libass's script-order
    // tiebreak for events that share a startSec.
    const entries = [entry('a', 0, 10), entry('b', 0, 10), entry('c', 0, 10)]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(10)
    expect(result.get('c')).toBe(20)
  })

  /**
   * VERIFY-20260613-001 §検証1 — the canonical partial-overlap case:
   *   A: 2-4, B: 3-6, C: 4-8
   *
   * Critical assertions:
   *   - B's offset stays at h_a (= the position it was assigned at t=3,
   *     when A was its only active prior) for the entire 3-6 window,
   *     INCLUDING after A ends at t=4.  Survivors must not shift.
   *   - C arrives at t=4, when A has just ended (end-EXCLUSIVE).  C
   *     finds offset 0 free (the slot A vacated) and slots into it —
   *     `filling in 'gaps' in other subtitles if one large enough is
   *     available` per the SSA spec.
   */
  it('partial overlap (A:2-4, B:3-6, C:4-8): B stays put, C fills the gap A left', () => {
    const entries = [entry('a', 2, 4), entry('b', 3, 6), entry('c', 4, 8)]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(10)
    expect(result.get('c')).toBe(0)  // C drops into A's freed slot
  })

  it('gap-fill respects height — a too-tall newcomer climbs above instead of dropping in', () => {
    // A (h=20) at offset 0 ends.  B (h=10, lifetime spans across A and C)
    // is at offset 20.  C (h=30) arrives after A ends.  The vacated slot
    // is 20 px tall, but C is 30 px — too big to fit, so C climbs above B.
    // Matches SSA spec: "if one large enough is available".
    const heightOf = (e: { id: string }): number =>
      e.id === 'a' ? 20 : e.id === 'b' ? 10 : 30  // c is 30
    const entries = [entry('a', 0, 3), entry('b', 0, 8), entry('c', 4, 8)]
    const result = computeFixedStackOffsets(entries, heightOf)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(20)  // pushed above A's 20 px
    expect(result.get('c')).toBe(30)  // gap of 20 is too small for h=30 → climb above B
  })

  it('gap-fill takes the slot when newcomer fits exactly', () => {
    // Same shape as above but C is small enough to fit the freed gap.
    const heightOf = (e: { id: string }): number =>
      e.id === 'a' ? 20 : e.id === 'b' ? 10 : 15  // c is 15
    const entries = [entry('a', 0, 3), entry('b', 0, 8), entry('c', 4, 8)]
    const result = computeFixedStackOffsets(entries, heightOf)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(20)
    expect(result.get('c')).toBe(0)  // fits in the freed 20-px gap
  })

  it('non-overlapping entries all sit at offset 0', () => {
    // Sequential, no overlap → every entry claims the burnin edge for
    // its own lifetime; the "fixed" state of an earlier entry does not
    // outlive the entry itself.
    const entries = [entry('a', 0, 1), entry('b', 2, 3), entry('c', 4, 5)]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(0)
    expect(result.get('c')).toBe(0)
  })

  it('end boundary is EXCLUSIVE — entry ending at t is NOT a prior for an entry starting at t', () => {
    // A ends at exactly 4.  C starts at exactly 4.  Per [start, end) the
    // two never co-exist, so C must not collide with A's position — C
    // anchors at offset 0 even with B (which spans across the boundary)
    // already occupying offset 10.
    const entries = [entry('a', 0, 4), entry('b', 0, 8), entry('c', 4, 8)]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(10)
    expect(result.get('c')).toBe(0)
  })

  it('start boundary is INCLUSIVE — same-instant siblings count as priors', () => {
    // A and B both start at 0.  When B is processed (second in the
    // array), A is treated as an already-placed prior (script-order
    // tiebreak), so B stacks on top.  Using strict `<` on startSec
    // would silently miss this case and put B at offset 0 on top of A.
    const entries = [entry('a', 0, 5), entry('b', 0, 5)]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(10)
  })

  it('alignment-agnostic: caller decides whether offset is from top or bottom edge', () => {
    // Same input as the duplicate-triplet test.  Offsets are
    // produced as pixel distances from "whichever edge the burnin
    // alignment anchors to" — they're symmetric for top vs bottom.
    // This test exists to lock the contract: the lib never reads or
    // assumes a vertical direction.
    const entries = [entry('a', 0, 10), entry('b', 0, 10), entry('c', 0, 10)]
    const result = computeFixedStackOffsets(entries, h)
    expect([result.get('a'), result.get('b'), result.get('c')]).toEqual([0, 10, 20])
  })

  it('survivor offset is unchanged whether a later sibling exists or not', () => {
    // Run the algorithm with just A + B (B stacks on A), then with
    // A + B + C (C arrives after A ends).  B's offset must be
    // identical in both runs — survivors do not shift to make room
    // for newcomers, only newcomers find their own slot.
    const ab = computeFixedStackOffsets(
      [entry('a', 2, 4), entry('b', 3, 6)],
      h,
    )
    const abc = computeFixedStackOffsets(
      [entry('a', 2, 4), entry('b', 3, 6), entry('c', 4, 8)],
      h,
    )
    expect(abc.get('b')).toBe(ab.get('b'))
    expect(abc.get('a')).toBe(ab.get('a'))
  })
})

/**
 * REQ-20260613-016 Phase 3 — per-row layout extensions to the stack
 * algorithm.  The legacy contract (all rows same alignment, same MarginV)
 * is covered by the suite above.  These tests pin the per-row extensions:
 *   - alignment groups partition the collision graph
 *   - each entry's own MarginV is the base position within its group
 *   - pinned entries (\pos) are excluded entirely
 */
describe('computeFixedStackOffsets — per-row alignment groups (Phase 3)', () => {
  const h = () => 10

  function entryWithLayout(
    id: string,
    startSec: number,
    endSec: number,
    layout: {
      horizontalPosition?: 'left' | 'center' | 'right'
      verticalPosition?: 'top' | 'bottom'
      verticalMarginPx?: number
      posX?: number
      posY?: number
    } = {},
  ): SubtitleEntry {
    const base = entry(id, startSec, endSec)
    return {
      ...base,
      horizontalPosition: layout.horizontalPosition ?? base.horizontalPosition,
      verticalPosition: layout.verticalPosition ?? base.verticalPosition,
      verticalMarginPx: layout.verticalMarginPx ?? base.verticalMarginPx,
      posX: layout.posX,
      posY: layout.posY,
    }
  }

  it('entries in different alignment groups do NOT collide', () => {
    // a is bottom-center; b is top-center.  They share the same time
    // window but live on opposite edges — no interaction, both at
    // offset 0 (= their own MarginV).
    const entries = [
      entryWithLayout('a', 0, 10, { verticalPosition: 'bottom' }),
      entryWithLayout('b', 0, 10, { verticalPosition: 'top' }),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(0)
  })

  it('three entries split across three alignment groups all sit at offset 0', () => {
    // Each entry has a unique (horizontal, vertical) combo so no two
    // share a collision group.  Every entry claims its own anchor.
    const entries = [
      entryWithLayout('a', 0, 10, { horizontalPosition: 'left',   verticalPosition: 'bottom' }),
      entryWithLayout('b', 0, 10, { horizontalPosition: 'center', verticalPosition: 'top' }),
      entryWithLayout('c', 0, 10, { horizontalPosition: 'right',  verticalPosition: 'bottom' }),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(0)
    expect(result.get('c')).toBe(0)
  })

  it('mixed groups — only same-group siblings stack', () => {
    // Two bottom-center entries (a, c) and one top-center (b) sharing
    // the same time window.  c stacks on a; b is alone in its group.
    const entries = [
      entryWithLayout('a', 0, 10, { verticalPosition: 'bottom' }),
      entryWithLayout('b', 0, 10, { verticalPosition: 'top' }),
      entryWithLayout('c', 0, 10, { verticalPosition: 'bottom' }),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(0)
    expect(result.get('c')).toBe(10) // stacked on a
  })

  it('horizontal split also partitions: bottom-left vs bottom-right do not collide', () => {
    // libass's alignment grouping is by the FULL alignment value (1–9),
    // so even rows that share the vertical edge but differ in horizontal
    // position do not stack on each other.
    const entries = [
      entryWithLayout('a', 0, 10, { horizontalPosition: 'left',  verticalPosition: 'bottom' }),
      entryWithLayout('b', 0, 10, { horizontalPosition: 'right', verticalPosition: 'bottom' }),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(0)
  })
})

describe('computeFixedStackOffsets — per-row MarginV (Phase 3)', () => {
  const h = () => 10

  function entryWithMargin(
    id: string,
    startSec: number,
    endSec: number,
    verticalMarginPx: number,
  ): SubtitleEntry {
    const base = entry(id, startSec, endSec)
    return { ...base, verticalMarginPx }
  }

  it('two same-group entries with widely-different MarginV do NOT collide', () => {
    // a sits at MarginV=40 (top edge of its band = 50).
    // b sits at MarginV=200 (top edge = 210).
    // Bands don't overlap → both at relative offset 0.
    const entries = [
      entryWithMargin('a', 0, 10, 40),
      entryWithMargin('b', 0, 10, 200),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(0)
  })

  it('two same-group entries with close MarginV DO collide and stack', () => {
    // a at MarginV=40 occupies band [40, 50].
    // b at MarginV=45 would occupy [45, 55] — collides.
    // b climbs above a → effective base 50 → relative offset = 50-45 = 5.
    const entries = [
      entryWithMargin('a', 0, 10, 40),
      entryWithMargin('b', 0, 10, 45),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(5)
  })

  it('three entries with progressive MarginV — only adjacent ones collide', () => {
    // a: MarginV=40 → band [40,50]
    // b: MarginV=45 → would be [45,55], climbs above a → base 50, offset 5
    // c: MarginV=200 → band [200,210], no collision, offset 0
    const entries = [
      entryWithMargin('a', 0, 10, 40),
      entryWithMargin('b', 0, 10, 45),
      entryWithMargin('c', 0, 10, 200),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(5)
    expect(result.get('c')).toBe(0)
  })

  it('relative offset for sole same-group entry is 0 regardless of MarginV', () => {
    // Regression guard: the returned value is NOT absolute pixels.  An
    // entry alone in its group sits at its own MarginV (relative = 0),
    // not at 0 (which would mean "at the edge").
    const result = computeFixedStackOffsets([entryWithMargin('a', 0, 10, 200)], h)
    expect(result.get('a')).toBe(0)
  })
})

describe('computeFixedStackOffsets — pinned entries excluded (Phase 3 / 機能B forward-decl)', () => {
  const h = () => 10

  function pinnedEntry(
    id: string,
    startSec: number,
    endSec: number,
    posX: number,
    posY: number,
  ): SubtitleEntry {
    const base = entry(id, startSec, endSec)
    return { ...base, posX, posY }
  }

  it('pinned entry does not appear in the result map', () => {
    const entries = [pinnedEntry('p', 0, 10, 100, 200)]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.has('p')).toBe(false)
  })

  it('pinned entries do not act as priors for unpinned siblings', () => {
    // a is pinned at (100, 200).  b shares the time window, same alignment
    // group as it would be by default.  a is invisible to the collision
    // graph, so b sits at offset 0 (= its own MarginV).
    const entries = [
      pinnedEntry('a', 0, 10, 100, 200),
      entry('b', 0, 10),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.has('a')).toBe(false)
    expect(result.get('b')).toBe(0)
  })

  it('only posX (no posY) is NOT pinned — entry stacks normally', () => {
    // The "pinned" state requires BOTH posX and posY (paired override of
    // \pos).  Only one defined → semantically incomplete → entry stays
    // in the stack.
    const base = entry('a', 0, 10)
    const halfPin: SubtitleEntry = { ...base, posX: 100, posY: undefined }
    const result = computeFixedStackOffsets([halfPin], h)
    expect(result.has('a')).toBe(true)
    expect(result.get('a')).toBe(0)
  })

  it('pinned + unpinned mix: pinned skipped, unpinned stack with each other', () => {
    // a: unpinned bottom-center
    // p: pinned (excluded entirely)
    // b: unpinned bottom-center, overlapping a
    // → a at 0, b at 10 (stacks on a), p missing
    const entries = [
      entry('a', 0, 10),
      pinnedEntry('p', 0, 10, 50, 50),
      entry('b', 0, 10),
    ]
    const result = computeFixedStackOffsets(entries, h)
    expect(result.get('a')).toBe(0)
    expect(result.has('p')).toBe(false)
    expect(result.get('b')).toBe(10)
  })
})

/**
 * REQ-0140 — center-aligned rows form their own alignment group and
 * anchor at the vertical middle (libass `\an4/5/6`).  Verify:
 *   - center rows do NOT collide with top/bottom rows (separate groups)
 *   - center rows use `0` as the stacking base regardless of their
 *     `verticalMarginPx` value (margin is ignored for center per REQ §3.2)
 *   - two same-time center rows stack cleanly like the top/bottom cases
 */
describe('computeFixedStackOffsets — REQ-0140 center alignment group', () => {
  const h = () => 10

  function entryCenter(id: string, startSec: number, endSec: number, marginVPx = 40): SubtitleEntry {
    const base = {
      startSec,
      endSec,
      text: id,
      fontSizePx: 64,
      textColorHex: '#ffffff',
      outlineColorHex: '#000000',
      outlineThicknessPx: 2,
      fadeDurationSec: 0,
      ...makeEntryLayoutDefaults(),
      verticalPosition: 'center' as const,
      verticalMarginPx: marginVPx,
    }
    return { id, ...base, isDeleted: false, isEdited: false, original: { ...base } }
  }

  it('a single center row → offset 0 (base treated as 0, margin ignored)', () => {
    const result = computeFixedStackOffsets([entryCenter('a', 0, 10)], h)
    expect(result.get('a')).toBe(0)
  })

  it('two same-time center rows stack in input order (10 → 10 delta)', () => {
    const result = computeFixedStackOffsets(
      [entryCenter('a', 0, 10), entryCenter('b', 0, 10)],
      h,
    )
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(10)
  })

  it('center row DOES NOT collide with a bottom row at the same time (separate groups)', () => {
    // bottom-aligned default row `a`; center-aligned row `b`.
    // Even though they overlap in time, libass puts them in different
    // alignment groups so both get offset 0.
    const result = computeFixedStackOffsets(
      [entry('a', 0, 10), entryCenter('b', 0, 10)],
      h,
    )
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(0)
  })

  it('center row ignores verticalMarginPx when computing its base', () => {
    // Even with a big margin (100), the center row starts at base 0.
    // The follow-up row stacks at 10 (= previous height) regardless of
    // the huge margin value on either row.
    const result = computeFixedStackOffsets(
      [entryCenter('a', 0, 10, 100), entryCenter('b', 0, 10, 250)],
      h,
    )
    expect(result.get('a')).toBe(0)
    expect(result.get('b')).toBe(10)
  })

  it('center row is independent from an overlapping top row', () => {
    // top-aligned prior `t` at margin 40; center-aligned `c` overlapping.
    // Different alignment groups → both are offset 0.
    const topEntry = (() => {
      const base = {
        startSec: 0,
        endSec: 10,
        text: 't',
        fontSizePx: 64,
        textColorHex: '#ffffff',
        outlineColorHex: '#000000',
        outlineThicknessPx: 2,
        fadeDurationSec: 0,
        ...makeEntryLayoutDefaults(),
        verticalPosition: 'top' as const,
      }
      return { id: 't', ...base, isDeleted: false, isEdited: false, original: { ...base } }
    })()
    const result = computeFixedStackOffsets([topEntry, entryCenter('c', 0, 10)], h)
    expect(result.get('t')).toBe(0)
    expect(result.get('c')).toBe(0)
  })
})
