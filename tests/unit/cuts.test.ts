import { describe, it, expect } from 'vitest'
import {
  origToEdited,
  editedToOrig,
  editedDuration,
  applyCutsToEntry,
  sanitizeCuts,
  buildKeptSegments,
  type Cut,
} from '../../src/shared/cuts'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-074 Phase 1a — coordinate / clamp algorithm verification.
 *
 * Trace 1 and Trace 2 below are the same examples worked out in the design
 * document `dev-docs/design/trimming-phase0.md` §3.2 / §2.1 (Phase 0.5).
 * If any of these assertions ever flips, either the algorithm or the doc
 * is wrong — fix one of them deliberately.
 */

function makeEntry(startSec: number, endSec: number, id = 'e'): SubtitleEntry {
  const base = {
    startSec,
    endSec,
    text: 'hi',
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeEnabled: false,
  }
  return {
    id,
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base },
  }
}

function cut(startSec: number, endSec: number, id?: string): Cut {
  return { startSec, endSec, id: id ?? `c-${startSec}-${endSec}` }
}

// ---------------------------------------------------------------------------
// Trace 1 — e = {5, 20}, c0 = {3, 7} head, c1 = {12, 14} middle
// Edited block expected: 3.0 → 14.0 (11 sec).  Middle cut collapses to 8.0.
// ---------------------------------------------------------------------------

describe('Phase 0.5 trace 1: e={5,20}, c0={3,7}, c1={12,14}', () => {
  const cuts: Cut[] = [cut(3, 7, 'c0'), cut(12, 14, 'c1')]
  const e = makeEntry(5, 20)

  it('origToEdited(7) === 3.0 — head-clamp landing point', () => {
    expect(origToEdited(7, cuts)).toBeCloseTo(3.0, 10)
  })

  it('origToEdited(20) === 14.0 — Edited block tail', () => {
    expect(origToEdited(20, cuts)).toBeCloseTo(14.0, 10)
  })

  it('origToEdited(12) === origToEdited(14) === 8.0 — middle cut collapses to a point', () => {
    expect(origToEdited(12, cuts)).toBeCloseTo(8.0, 10)
    expect(origToEdited(14, cuts)).toBeCloseTo(8.0, 10)
  })

  it('editedToOrig(3) === 7 round-trips', () => {
    expect(editedToOrig(3, cuts)).toBeCloseTo(7.0, 10)
  })

  it('editedToOrig(14) === 20 round-trips', () => {
    expect(editedToOrig(14, cuts)).toBeCloseTo(20.0, 10)
  })

  it('applyCutsToEntry: sClamped=7, enClamped=20, middleCuts=[{12,14}]', () => {
    const r = applyCutsToEntry(e, cuts)
    expect(r).not.toBeNull()
    expect(r!.startSec).toBeCloseTo(7.0, 10)
    expect(r!.endSec).toBeCloseTo(20.0, 10)
    expect(r!.middleCuts).toEqual([{ startSec: 12, endSec: 14 }])
  })

  it('Edited block duration matches visibleSec — 11.0 sec', () => {
    const r = applyCutsToEntry(e, cuts)!
    const editedDur = origToEdited(r.endSec, cuts) - origToEdited(r.startSec, cuts)
    expect(editedDur).toBeCloseTo(11.0, 10)
  })
})

// ---------------------------------------------------------------------------
// Trace 2 — e = {5, 30}, c0 = {3, 7} head, c1 = {15, 17} middle, c2 = {28, 35} tail
// Edited block expected: 3.0 → 22.0 (19 sec).
// CRITICAL: origToEdited(28) must NOT include c2's length in `removed`.
// ---------------------------------------------------------------------------

describe('Phase 0.5 trace 2: e={5,30}, c0={3,7}, c1={15,17}, c2={28,35}', () => {
  const cuts: Cut[] = [cut(3, 7, 'c0'), cut(15, 17, 'c1'), cut(28, 35, 'c2')]
  const e = makeEntry(5, 30)

  it('origToEdited(7) === 3.0 — Edited block head', () => {
    expect(origToEdited(7, cuts)).toBeCloseTo(3.0, 10)
  })

  it('origToEdited(28) === 22.0 — tail clamp; `removed` excludes c2 itself', () => {
    // Anchors the §2.1 invariant: `if (tOrig <= c.startSec) break` MUST
    // exclude the tail-clamp cut from the `removed` accumulator.
    // Wrong result would be 28 - 8 = 20.  Correct is 28 - 6 = 22.
    expect(origToEdited(28, cuts)).toBeCloseTo(22.0, 10)
  })

  it('origToEdited(15) === origToEdited(17) === 11.0 — middle cut collapses', () => {
    expect(origToEdited(15, cuts)).toBeCloseTo(11.0, 10)
    expect(origToEdited(17, cuts)).toBeCloseTo(11.0, 10)
  })

  it('applyCutsToEntry: sClamped=7, enClamped=28, middleCuts=[{15,17}]', () => {
    const r = applyCutsToEntry(e, cuts)
    expect(r).not.toBeNull()
    expect(r!.startSec).toBeCloseTo(7.0, 10)
    expect(r!.endSec).toBeCloseTo(28.0, 10)
    expect(r!.middleCuts).toEqual([{ startSec: 15, endSec: 17 }])
  })

  it('Edited block duration matches visibleSec — 19.0 sec', () => {
    const r = applyCutsToEntry(e, cuts)!
    const editedDur = origToEdited(r.endSec, cuts) - origToEdited(r.startSec, cuts)
    expect(editedDur).toBeCloseTo(19.0, 10)
  })
})

// ---------------------------------------------------------------------------
// applyCutsToEntry — additional branch coverage
// ---------------------------------------------------------------------------

describe('applyCutsToEntry — branch coverage', () => {
  it('complete containment returns null', () => {
    expect(applyCutsToEntry(makeEntry(5, 8), [cut(3, 10)])).toBeNull()
  })

  it('cut entirely before entry leaves entry untouched', () => {
    const r = applyCutsToEntry(makeEntry(10, 12), [cut(3, 7)])
    expect(r!.startSec).toBe(10)
    expect(r!.endSec).toBe(12)
    expect(r!.middleCuts).toHaveLength(0)
  })

  it('cut entirely after entry leaves entry untouched', () => {
    const r = applyCutsToEntry(makeEntry(2, 5), [cut(10, 12)])
    expect(r!.startSec).toBe(2)
    expect(r!.endSec).toBe(5)
    expect(r!.middleCuts).toHaveLength(0)
  })

  it('multiple middle cuts accumulate in order', () => {
    const r = applyCutsToEntry(makeEntry(5, 30), [cut(10, 12), cut(20, 22)])
    expect(r!.startSec).toBe(5)
    expect(r!.endSec).toBe(30)
    expect(r!.middleCuts).toEqual([
      { startSec: 10, endSec: 12 },
      { startSec: 20, endSec: 22 },
    ])
  })

  it('input entry is not mutated', () => {
    const e = makeEntry(5, 20)
    const before = JSON.parse(JSON.stringify(e))
    applyCutsToEntry(e, [cut(3, 7), cut(12, 14)])
    expect(e).toEqual(before)
  })

  it('visible duration below MIN_SUBTITLE_DURATION_SEC returns null', () => {
    // Original entry shorter than the floor.
    expect(applyCutsToEntry(makeEntry(5, 5.04), [])).toBeNull()
    // Clamped to below the floor by a head + tail combo.
    const e = makeEntry(5, 6)
    const cuts: Cut[] = [cut(4, 5.5), cut(5.52, 7)]
    expect(applyCutsToEntry(e, cuts)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// REQ-101 — tail cut to videoDuration: every entry fully contained in the
// cut MUST be reported as null by applyCutsToEntry, so both ffmpeg-burnin
// (which already filters) and the timeline-view filter introduced in REQ-101
// drop them from rendering / ASS emission.  The owner reported that confirming
// a "trim end → video end" cut left clips visible at the post-cut right edge,
// which traced to the timeline preview NOT filtering through this function
// (ffmpeg-burnin already does).
// ---------------------------------------------------------------------------

describe('REQ-101: tail cut covering entries up to the video end', () => {
  it('entry fully inside a tail-to-end cut returns null', () => {
    // videoDuration = 100; user trims [60, 100] (entire tail).
    // Whisper segment lives at [70, 75] — fully inside.
    expect(applyCutsToEntry(makeEntry(70, 75), [cut(60, 100)])).toBeNull()
  })

  it('entry whose endSec === cut.endSec === videoDuration is still fully contained', () => {
    // Boundary: entry ends EXACTLY at the cut end (= video duration).
    // The applyCutsToEntry test on `<=` at the right edge is the critical
    // bit — a strict `<` would have surfaced the entry here.
    expect(applyCutsToEntry(makeEntry(80, 100), [cut(60, 100)])).toBeNull()
  })

  it('entry whose startSec === cut.startSec is still fully contained', () => {
    // Boundary: entry starts EXACTLY at the cut start.
    expect(applyCutsToEntry(makeEntry(60, 80), [cut(60, 100)])).toBeNull()
  })

  it('entry exactly spanning the cut [cutStart, cutEnd] returns null', () => {
    // Both edges align with cut boundaries.
    expect(applyCutsToEntry(makeEntry(60, 100), [cut(60, 100)])).toBeNull()
  })

  it('entry that straddles cut.endSec is kept, head-clamped to cut.endSec', () => {
    // Tail cut [60, 95], entry [80, 100] — head overlap with the cut.
    const r = applyCutsToEntry(makeEntry(80, 100), [cut(60, 95)])
    expect(r).not.toBeNull()
    expect(r!.startSec).toBe(95)
    expect(r!.endSec).toBe(100)
  })

  it('multiple entries fully inside a tail cut all return null individually', () => {
    // The renderer-side filter loops applyCutsToEntry across the entry
    // array, so verifying each entry independently is the contract this
    // test locks.
    const tailCut = [cut(60, 100)]
    expect(applyCutsToEntry(makeEntry(70, 75), tailCut)).toBeNull()
    expect(applyCutsToEntry(makeEntry(80, 85), tailCut)).toBeNull()
    expect(applyCutsToEntry(makeEntry(90, 95), tailCut)).toBeNull()
    expect(applyCutsToEntry(makeEntry(95, 100), tailCut)).toBeNull()
  })

  it('entries OUTSIDE the cut survive and are reported with their original times', () => {
    // Tail cut [60, 100] does not affect entries before the cut.
    const tailCut = [cut(60, 100)]
    const before = applyCutsToEntry(makeEntry(10, 20), tailCut)
    expect(before).not.toBeNull()
    expect(before!.startSec).toBe(10)
    expect(before!.endSec).toBe(20)
  })

  it('integration: filtering an entries[] array via applyCutsToEntry produces the burn-in-equivalent set', () => {
    // This is the user's exact reported scenario.  Five entries, tail cut
    // from 60 to videoDuration (= 100).  Expected result: only the
    // before-cut entries and the head-clamped partial-overlap entry pass.
    const entries: SubtitleEntry[] = [
      makeEntry(10, 15, 'before-1'),
      makeEntry(30, 35, 'before-2'),
      makeEntry(55, 65, 'straddles-cut-start'), // head-overlap, keep
      makeEntry(70, 75, 'inside-1'),            // drop
      makeEntry(85, 95, 'inside-2'),            // drop
      makeEntry(95, 100, 'flush-with-cut-end'), // drop (endSec === cut.endSec)
    ]
    const tailCut: Cut[] = [cut(60, 100)]
    const filtered = entries.filter((e) => applyCutsToEntry(e, tailCut) !== null)
    expect(filtered.map((e) => e.id)).toEqual([
      'before-1',
      'before-2',
      'straddles-cut-start',
    ])
  })
})

// ---------------------------------------------------------------------------
// editedDuration
// ---------------------------------------------------------------------------

describe('editedDuration', () => {
  it('returns originalDuration when cuts is empty', () => {
    expect(editedDuration(60, [])).toBe(60)
  })

  it('subtracts total cut length', () => {
    expect(editedDuration(60, [cut(3, 7), cut(12, 14), cut(28, 35)])).toBe(60 - 4 - 2 - 7)
  })

  it('never returns negative', () => {
    expect(editedDuration(5, [cut(0, 100)])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// sanitizeCuts
// ---------------------------------------------------------------------------

describe('sanitizeCuts', () => {
  it('sorts by startSec ascending', () => {
    const out = sanitizeCuts([cut(10, 12, 'b'), cut(3, 5, 'a')])
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('merges overlapping cuts', () => {
    const out = sanitizeCuts([cut(3, 8), cut(5, 10)])
    expect(out).toHaveLength(1)
    expect(out[0].startSec).toBe(3)
    expect(out[0].endSec).toBe(10)
  })

  it('merges touching cuts (endSec === next startSec)', () => {
    const out = sanitizeCuts([cut(3, 7), cut(7, 10)])
    expect(out).toHaveLength(1)
    expect(out[0].endSec).toBe(10)
  })

  it('drops cuts with start >= end', () => {
    expect(sanitizeCuts([cut(5, 5)])).toHaveLength(0)
    expect(sanitizeCuts([cut(10, 5)])).toHaveLength(0)
  })

  it('clamps to [0, maxSec] when maxSec given', () => {
    const out = sanitizeCuts([cut(-5, 100, 'c1')], 60)
    expect(out).toEqual([{ id: 'c1', startSec: 0, endSec: 60 }])
  })

  it('drops NaN / Infinity', () => {
    expect(sanitizeCuts([cut(NaN, 10), cut(5, Number.POSITIVE_INFINITY)])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// buildKeptSegments — used by ffmpeg trim+concat builder (1d)
// ---------------------------------------------------------------------------

describe('buildKeptSegments', () => {
  it('returns single full segment when cuts is empty', () => {
    expect(buildKeptSegments(60, [])).toEqual([{ startSec: 0, endSec: 60 }])
  })

  it('produces complement intervals', () => {
    const cuts: Cut[] = [cut(10, 15), cut(30, 32)]
    expect(buildKeptSegments(60, cuts)).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 15, endSec: 30 },
      { startSec: 32, endSec: 60 },
    ])
  })

  it('handles cut at start (no leading kept segment)', () => {
    expect(buildKeptSegments(60, [cut(0, 10)])).toEqual([{ startSec: 10, endSec: 60 }])
  })

  it('handles cut at end (no trailing kept segment)', () => {
    expect(buildKeptSegments(60, [cut(50, 60)])).toEqual([{ startSec: 0, endSec: 50 }])
  })
})
