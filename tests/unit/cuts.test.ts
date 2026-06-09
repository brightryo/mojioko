import { describe, it, expect } from 'vitest'
import {
  origToEdited,
  editedToOrig,
  editedDuration,
  applyCutsToEntry,
  effectiveEntryState,
  sanitizeCuts,
  buildKeptSegments,
  unionizeCuts,
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
// REQ-102 — effectiveEntryState: derive table classification (deleted /
// edited) from manual flags + cuts without mutating the entry.
// ---------------------------------------------------------------------------

describe('REQ-102: effectiveEntryState (REQ-103 expanded shape)', () => {
  it('empty cuts list — state mirrors the manual flags', () => {
    expect(effectiveEntryState(makeEntry(5, 10), [])).toEqual({
      status: 'normal',
      wasEdited: false,
      effectivelyDeleted: false,
      effectivelyEdited: false,
    })
    const edited = { ...makeEntry(5, 10), isEdited: true }
    expect(effectiveEntryState(edited, [])).toEqual({
      status: 'edited',
      wasEdited: true,
      effectivelyDeleted: false,
      effectivelyEdited: true,
    })
    const deleted = { ...makeEntry(5, 10), isDeleted: true }
    expect(effectiveEntryState(deleted, [])).toEqual({
      status: 'manuallyDeleted',
      wasEdited: false,
      effectivelyDeleted: true,
      effectivelyEdited: false,
    })
  })

  it('manual isDeleted always wins over cut analysis', () => {
    // Even when the entry is also fully outside any cut, the manual flag
    // dominates — same contract as the legacy `entries.filter(!isDeleted)`
    // path so REQ-079 / REQ-091 reset behaviour is unaffected.
    const deletedOutsideCut: SubtitleEntry = { ...makeEntry(5, 10), isDeleted: true }
    expect(effectiveEntryState(deletedOutsideCut, [cut(50, 100)])).toEqual({
      status: 'manuallyDeleted',
      wasEdited: false,
      effectivelyDeleted: true,
      effectivelyEdited: false,
    })
  })

  it('fully-contained entry → status: trimDeleted (REQ-103)', () => {
    // REQ-103 §A — previously this was `effectivelyDeleted` lumped together
    // with manual delete.  The 4-state split lets the table badge AND the
    // future "復活" workflow distinguish "user removed this row" from "a
    // cut consumed this row".
    const e = makeEntry(70, 75)
    expect(effectiveEntryState(e, [cut(60, 100)])).toEqual({
      status: 'trimDeleted',
      wasEdited: false,
      effectivelyDeleted: true,
      effectivelyEdited: false,
    })
  })

  it('partial head-overlap → effectivelyEdited, NOT effectivelyDeleted', () => {
    // Entry [55, 65] with cut [60, 100]: tail of the entry sits inside the
    // cut, applyCutsToEntry clamps endSec from 65 → 60.  The user did not
    // manually edit this row, so without the cut-induced flag the entry
    // would silently appear in 出力対象 with the OLD endSec → table view
    // mismatched the burnin output.  REQ-102 promotes it to 編集済み.
    const e = makeEntry(55, 65)
    expect(effectiveEntryState(e, [cut(60, 100)])).toEqual({
      status: 'edited',
      wasEdited: true,
      effectivelyDeleted: false,
      effectivelyEdited: true,
    })
  })

  it('partial tail-overlap → effectivelyEdited', () => {
    // Entry [80, 105] crossing cut [60, 95]: head clamped startSec
    // from 80 → 95.
    const e = makeEntry(80, 105)
    expect(effectiveEntryState(e, [cut(60, 95)])).toEqual({
      status: 'edited',
      wasEdited: true,
      effectivelyDeleted: false,
      effectivelyEdited: true,
    })
  })

  it('middle cut entirely inside entry → status edited (REQ-104 flip)', () => {
    // Entry [5, 30] with middle cut [12, 14]: applyCutsToEntry returns
    // the entry with startSec / endSec unchanged but records the middle
    // cut in `middleCuts`.  Per Phase 0.5 spec §3.1 / SPEC-trimming
    // §2.2 ("端・真ん中とも編集済み"), the row is "edited" because the
    // audible duration shrinks even when the boundaries don't move.
    //
    // REQ-104 flipped this from 'normal' → 'edited' by extending the
    // `cutClamped` predicate in shared/cuts.ts to also fire when
    // `middleCuts.length > 0`.  The owner reported a middle-cut entry
    // showing 編集済み=0 / 出力対象 short-by-one; this test locks the
    // corrected contract.
    const e = makeEntry(5, 30)
    expect(effectiveEntryState(e, [cut(12, 14)])).toEqual({
      status: 'edited',
      wasEdited: true,
      effectivelyDeleted: false,
      effectivelyEdited: true,
    })
  })

  it('entry outside all cuts → state mirrors manual flags', () => {
    // Entry [10, 20] with cut [60, 100]: applyCutsToEntry returns the
    // entry untouched (case (a) of the algorithm).  No cut-induced
    // classification — only the manual flags surface.
    const e = makeEntry(10, 20)
    expect(effectiveEntryState(e, [cut(60, 100)])).toEqual({
      status: 'normal',
      wasEdited: false,
      effectivelyDeleted: false,
      effectivelyEdited: false,
    })

    const editedOutside = { ...e, isEdited: true }
    expect(effectiveEntryState(editedOutside, [cut(60, 100)])).toEqual({
      status: 'edited',
      wasEdited: true,
      effectivelyDeleted: false,
      effectivelyEdited: true,
    })
  })

  it('manual isEdited + cut-induced edit do NOT double-count', () => {
    // The user manually edited this row; a cut later clamps it.  The
    // `editedCount` predicate in step2.tsx is `effectivelyEdited &&
    // !effectivelyDeleted`, and `effectivelyEdited` is a single
    // boolean — so the row contributes ONCE to the 編集済み count
    // regardless of which of the two reasons fired.  This is the
    // "二重計上の回避" requirement spelled out in REQ-102.
    const e = { ...makeEntry(55, 65), isEdited: true }
    const state = effectiveEntryState(e, [cut(60, 100)])
    expect(state.effectivelyEdited).toBe(true)
    expect(state.wasEdited).toBe(true)
    // Same row would still be counted in the table's 編集済み tab
    // exactly once because the predicate compares to a single boolean.
  })

  it('manual isDeleted + cut-fully-contained → status: manuallyDeleted (REQ-103)', () => {
    // Same row, both reasons.  REQ-103 — manual delete WINS over trim
    // delete in the status field so the badge shows "削除済み" (not
    // "トリミング削除") when the user took explicit action.  This is
    // the precedence ordering called out in the boundary contract.
    const e = { ...makeEntry(70, 75), isDeleted: true }
    const state = effectiveEntryState(e, [cut(60, 100)])
    expect(state.status).toBe('manuallyDeleted')
    expect(state.effectivelyDeleted).toBe(true)
  })

  it('removing the cut RESTORES the original effective state (data non-destructive)', () => {
    // Same SubtitleEntry instance, evaluated with and without a cut.
    // This is the regression lock for REQ-102's "カット取消で完全復元"
    // promise: nothing about the entry mutates when cuts are added,
    // so dropping the cuts list back to [] produces the same state as
    // before the cut was confirmed.
    const e = makeEntry(70, 75)
    const cuts: Cut[] = [cut(60, 100)]
    expect(effectiveEntryState(e, cuts).effectivelyDeleted).toBe(true)
    expect(effectiveEntryState(e, [])).toEqual({
      status: 'normal',
      wasEdited: false,
      effectivelyDeleted: false,
      effectivelyEdited: false,
    })
    // Verify the entry data itself was not touched.
    expect(e.startSec).toBe(70)
    expect(e.endSec).toBe(75)
    expect(e.isDeleted).toBe(false)
    expect(e.isEdited).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// REQ-103 — new 4-state classification, count-conservation contract, and
// the cross-cutting `wasEdited` filter.
// ---------------------------------------------------------------------------

describe('REQ-103: 4-state classification + count conservation', () => {
  it('manually-deleted row that was once edited keeps `wasEdited: true`', () => {
    // The user manually edited then manually deleted this row.  The
    // 編集済み filter in REQ-103 §B is "cross-cutting" — it should still
    // surface the row.  `status` is `manuallyDeleted` (= 削除 tab); the
    // cross-cutting flag is on `wasEdited`, not on `effectivelyEdited`.
    const e = { ...makeEntry(10, 15), isEdited: true, isDeleted: true }
    const state = effectiveEntryState(e, [])
    expect(state.status).toBe('manuallyDeleted')
    expect(state.wasEdited).toBe(true)
    expect(state.effectivelyDeleted).toBe(true)
    // effectivelyEdited is the REQ-102 alias (= wasEdited && !deleted),
    // so it goes false for deleted rows.  REQ-103 callers should read
    // `wasEdited` instead.
    expect(state.effectivelyEdited).toBe(false)
  })

  it('cut-clamped row that is then manually deleted: status manuallyDeleted, wasEdited true', () => {
    // Mixed cause — cut clamped the row AND the user manually deleted
    // it.  Precedence: manual delete wins on `status`; the cut
    // clamp still bubbled up as `wasEdited`.
    const e = { ...makeEntry(55, 65), isDeleted: true }
    const state = effectiveEntryState(e, [cut(60, 100)])
    expect(state.status).toBe('manuallyDeleted')
    // applyCutsToEntry runs even for deleted rows — `wasEdited`
    // reflects "the row would have been edited" which the 編集済み
    // filter cares about.
    expect(state.wasEdited).toBe(true)
  })

  it('count conservation: ready + deleted === all for any (entries, cuts) pair', () => {
    // The REQ-103 §6 invariant.  Build a varied entries array and
    // verify the partition by counting each `status` value.
    const entries: SubtitleEntry[] = [
      makeEntry(10, 15, 'normal-1'),
      makeEntry(20, 25, 'normal-2'),
      { ...makeEntry(30, 35, 'edited-manual'), isEdited: true },
      makeEntry(55, 65, 'edited-cut-clamp'),    // straddles cut start → edited
      makeEntry(70, 75, 'trim-deleted-1'),
      makeEntry(80, 85, 'trim-deleted-2'),
      makeEntry(95, 100, 'flush-with-cut-end'), // also trim-deleted
      { ...makeEntry(110, 115, 'outside-cut-deleted'), isDeleted: true },
    ]
    const cuts: Cut[] = [cut(60, 100)]
    let normal = 0, edited = 0, manuallyDeleted = 0, trimDeleted = 0
    for (const e of entries) {
      const s = effectiveEntryState(e, cuts)
      switch (s.status) {
        case 'normal':          normal++; break
        case 'edited':          edited++; break
        case 'manuallyDeleted': manuallyDeleted++; break
        case 'trimDeleted':     trimDeleted++; break
      }
    }
    // Verify the partition fills all entries:
    expect(normal + edited + manuallyDeleted + trimDeleted).toBe(entries.length)
    // Verify the count-conservation identity:
    const readyCount = normal + edited
    const deletedCount = manuallyDeleted + trimDeleted
    expect(readyCount + deletedCount).toBe(entries.length)

    // Spot-check the actual values (= regression lock against future
    // changes that silently re-categorise rows).
    expect(normal).toBe(2)
    expect(edited).toBe(2)
    expect(trimDeleted).toBe(3)
    expect(manuallyDeleted).toBe(1)
    expect(readyCount).toBe(4)
    expect(deletedCount).toBe(4)
  })

  it('REQ-104: pure middle cut → edited + wasEdited + NOT effectivelyDeleted', () => {
    // The owner's regression: a clip that has a cut sitting INSIDE its
    // [startSec, endSec] interval (both sides survive) used to be
    // classified as 'normal' because cutClamped only checked the
    // start/end fields.  Per Phase 0.5 spec §3.1 the row is edited.
    const e = makeEntry(5, 30)
    const state = effectiveEntryState(e, [cut(12, 14)])
    expect(state.status).toBe('edited')
    expect(state.wasEdited).toBe(true)
    expect(state.effectivelyDeleted).toBe(false)
    expect(state.effectivelyEdited).toBe(true)
  })

  it('REQ-104: multiple middle cuts on one entry → edited (single classification)', () => {
    // Two middle cuts on the same entry — the row is still ONE
    // edited row, not double-counted.  Locks "字幕の個数は増えない"
    // from spec §0.4: the row is never split.
    const e = makeEntry(5, 30)
    const state = effectiveEntryState(e, [cut(10, 12), cut(20, 22)])
    expect(state.status).toBe('edited')
    expect(state.wasEdited).toBe(true)
  })

  it('REQ-104: head + middle combo → edited', () => {
    // Phase 0.5 trace 1 — head clamp AND middle cut.  Before the
    // REQ-104 fix this was already 'edited' via the head clamp;
    // after the fix the middle-cut signal independently confirms
    // it.  Regression-locks both paths.
    const e = makeEntry(5, 20)
    const state = effectiveEntryState(e, [cut(3, 7), cut(12, 14)])
    expect(state.status).toBe('edited')
    expect(state.wasEdited).toBe(true)
  })

  it('REQ-104: middle cut count + filter agreement on the same (entries, cuts)', () => {
    // Locks the REQ-104 "件数計算と表示フィルタが同一判定" contract.
    // Both the step2.tsx tab-count predicate and subtitle-filter.ts
    // filterEntries() consume effectiveEntryState; if the partition
    // counted here and the per-tab `entries.filter(...)` walk land
    // on the same number for any (entries, cuts) pair, the table
    // and the count badge can NEVER disagree.
    const entries: SubtitleEntry[] = [
      makeEntry(5, 30, 'middle-cut'),               // middle cut → edited
      makeEntry(50, 55, 'untouched'),               // outside → normal
      makeEntry(70, 75, 'fully-contained'),         // contained → trimDeleted
    ]
    const cuts: Cut[] = [cut(12, 14), cut(60, 100)]
    // ‘deleted’ filter mirrors the deletedCount predicate exactly.
    const deletedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    const readyCount = entries.filter(
      (e) => !effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    const editedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).wasEdited,
    ).length
    expect(readyCount).toBe(2)
    expect(deletedCount).toBe(1)
    expect(editedCount).toBe(1)
    // Count-conservation invariant.
    expect(readyCount + deletedCount).toBe(entries.length)
  })

  it('wasEdited filter is cross-cutting: includes deleted rows that were edited', () => {
    // The 編集済み filter in REQ-103 §B explicitly says "削除済みでも
    // 出力対象でも、編集されていれば表示".  This test pins that contract
    // at the effectiveEntryState layer.
    const editedThenDeleted = { ...makeEntry(10, 15), isEdited: true, isDeleted: true }
    expect(effectiveEntryState(editedThenDeleted, []).wasEdited).toBe(true)

    const editedThenTrim = makeEntry(70, 75)   // straddles cut → wasEdited
    expect(effectiveEntryState(editedThenTrim, [cut(60, 100)]).status).toBe('trimDeleted')
    // ...but `wasEdited` only fires for partial overlap; full
    // containment doesn't clamp the start/end (it returns null),
    // so wasEdited stays false here.  That matches the contract —
    // a fully-cut row was never "edited" by the cut, it was wholly
    // removed.
    expect(effectiveEntryState(editedThenTrim, [cut(60, 100)]).wasEdited).toBe(false)
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

describe('sanitizeCuts (REQ-105 Phase 2: no-merge, dedupe-only)', () => {
  it('sorts by startSec ascending', () => {
    const out = sanitizeCuts([cut(10, 12, 'b'), cut(3, 5, 'a')])
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('preserves overlapping cuts as separate entries (REQ-105 Phase 2 flip)', () => {
    // Phase 0.5 (旧): two overlapping cuts merged into one.
    // Phase 2 (新): kept as TWO separate cuts with their original ids so
    // the staged-unbind UI (Phase 4) can address each one independently.
    const out = sanitizeCuts([cut(3, 8, 'a'), cut(5, 10, 'b')])
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
    expect(out).toEqual([
      { id: 'a', startSec: 3, endSec: 8 },
      { id: 'b', startSec: 5, endSec: 10 },
    ])
  })

  it('preserves touching cuts (endSec === next startSec) as separate entries (REQ-105 Phase 2 flip)', () => {
    // REQ-107 confirmed: touching cuts are kept separate.  Coordinate math
    // (unionizeCuts in Phase 1) collapses them on the math side, so the
    // visible result is identical to a single merged cut; the user can
    // still un-do them step by step.
    const out = sanitizeCuts([cut(3, 7, 'a'), cut(7, 10, 'b')])
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id)).toEqual(['a', 'b'])
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

  // -------------------------------------------------------------------------
  // REQ-105 Phase 2 new contracts: nested preserved, exact-duplicate dedupe,
  // tie-break (endSec DESC on equal startSec).
  // -------------------------------------------------------------------------

  it('preserves nested cuts (outer + inner) as two separate entries', () => {
    // The staged-unbind contract: removing the outer must NOT remove
    // the inner, so they have to be in storage as two distinct ids.
    const out = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    expect(out).toHaveLength(2)
    expect(out.map((c) => c.id)).toEqual(['outer', 'inner'])
    expect(out[0]).toEqual({ id: 'outer', startSec: 10, endSec: 30 })
    expect(out[1]).toEqual({ id: 'inner', startSec: 15, endSec: 20 })
  })

  it('dedupes fully identical (startSec, endSec) — first id wins', () => {
    // History snapshot replay or a buggy caller could push the "same"
    // cut twice with two ids.  The user has no way to tell them apart, so
    // we keep the earlier one and drop the later.  Different `id`s with
    // the same interval are pointless.
    const out = sanitizeCuts([cut(10, 20, 'first'), cut(10, 20, 'second')])
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ id: 'first', startSec: 10, endSec: 20 })
  })

  it('does NOT dedupe cuts with same startSec but different endSec', () => {
    // Same start, different end = different operations.  Must stay
    // separate so the user can remove the wider/narrower one
    // independently.
    const out = sanitizeCuts([cut(10, 30, 'wide'), cut(10, 20, 'narrow')])
    expect(out).toHaveLength(2)
  })

  it('tie-break on equal startSec puts the wider (outer) cut first (endSec DESC)', () => {
    // Outer-first ordering is exploited by `containsCut` /
    // `removableCutIds` in Phase 4: the scan can short-circuit as soon as
    // it sees a containing cut whose startSec equals the candidate's.
    const out = sanitizeCuts([cut(10, 20, 'narrow'), cut(10, 30, 'wide')])
    expect(out.map((c) => c.id)).toEqual(['wide', 'narrow'])
  })

  it('tie-break still respects startSec ordering across groups', () => {
    // Outer-first applies WITHIN a single startSec group; across groups
    // the primary key is startSec.
    const out = sanitizeCuts([
      cut(20, 25, 'late'),
      cut(10, 20, 'mid-narrow'),
      cut(10, 30, 'mid-wide'),
      cut(5, 8, 'early'),
    ])
    expect(out.map((c) => c.id)).toEqual([
      'early',
      'mid-wide',
      'mid-narrow',
      'late',
    ])
  })

  it('preserves identity (id) across mutation rounds for non-overlapping cuts', () => {
    // Regression lock: the existing "addCut → setCuts(prevSnapshot) →
    // addCut" undo path must not lose `id`s when sanitize re-clones the
    // entries (it does: it copies id + startSec + endSec into a fresh
    // object).
    const out = sanitizeCuts([cut(0, 5, 'id-a'), cut(10, 15, 'id-b')])
    expect(out.map((c) => c.id)).toEqual(['id-a', 'id-b'])
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

// ---------------------------------------------------------------------------
// REQ-105 Phase 1 — unionizeCuts + overlap tolerance for the 3 coordinate
// functions.
//
// Phase 1 invariant the tests below must enforce:
//   - For disjoint inputs (the entire Phase 1 storage shape, since
//     sanitizeCuts still merges in Phase 1), origToEdited / editedToOrig /
//     editedDuration are BIT-IDENTICAL to their pre-REQ-105 behaviour.
//     The pre-Phase-0.5 trace 1 / trace 2 / REQ-101 boundary tests above
//     already lock this — no edits needed to keep the lock active.
//   - For overlapping / nested / touching inputs (the Phase 2 storage
//     shape), the same three functions must NOT double-count and must
//     return the same result as the disjoint-union-equivalent input.
// ---------------------------------------------------------------------------

describe('REQ-105 Phase 1: unionizeCuts', () => {
  it('empty input → empty output', () => {
    expect(unionizeCuts([])).toEqual([])
  })

  it('single cut → identity (id stripped)', () => {
    expect(unionizeCuts([cut(10, 20)])).toEqual([{ startSec: 10, endSec: 20 }])
  })

  it('disjoint cuts → identity ordering (id stripped)', () => {
    // The Phase 1 storage shape — sanitizeCuts already enforces this.
    // unionizeCuts must be the identity here to preserve bit-identicality
    // of the three coordinate functions.
    expect(unionizeCuts([cut(3, 7), cut(15, 17), cut(28, 35)])).toEqual([
      { startSec: 3, endSec: 7 },
      { startSec: 15, endSec: 17 },
      { startSec: 28, endSec: 35 },
    ])
  })

  it('overlapping cuts → merged into one interval', () => {
    // c0 ends inside c1 → union covers [10, 25].
    expect(unionizeCuts([cut(10, 20), cut(15, 25)])).toEqual([
      { startSec: 10, endSec: 25 },
    ])
  })

  it('nested cut → outer wins (inner absorbed)', () => {
    // Phase 2 storage shape — both kept in storage, but for axis math
    // they reduce to the outer interval since the inner removes the
    // same frames the outer already removed.
    expect(unionizeCuts([cut(10, 30), cut(15, 20)])).toEqual([
      { startSec: 10, endSec: 30 },
    ])
  })

  it('fully identical (startSec, endSec) collapse to one', () => {
    // The §4.5 dedupe ask — same range, two ids.  Phase 1 already
    // handles this at the union level so Phase 2's sanitizeCuts dedupe
    // is just a storage-side cleanup, not a math correctness fix.
    expect(unionizeCuts([cut(10, 20), cut(10, 20)])).toEqual([
      { startSec: 10, endSec: 20 },
    ])
  })

  it('touching cuts (endSec === next startSec) merge for math purposes', () => {
    // Storage will keep them separate (Phase 2 + §4.2 owner decision),
    // but for coordinate math two touching intervals remove the exact
    // same frames as one continuous interval.
    expect(unionizeCuts([cut(10, 15), cut(15, 20)])).toEqual([
      { startSec: 10, endSec: 20 },
    ])
  })

  it('chain of three overlapping cuts → single span', () => {
    expect(unionizeCuts([cut(10, 18), cut(15, 22), cut(20, 30)])).toEqual([
      { startSec: 10, endSec: 30 },
    ])
  })
})

describe('REQ-105 Phase 1: coordinate functions tolerate overlapping cuts', () => {
  // The "lock" tests in Phase 0.5 trace 1 / trace 2 / REQ-101 above keep
  // disjoint-input bit-identicality alive.  These new tests prove the
  // overlap-handling branch is correct for the Phase 2 storage shape.

  it('origToEdited: nested cut yields the same result as the outer alone', () => {
    // Outer [10, 30], inner [15, 20].  Frames removed = 20 (outer only).
    // tOrig = 35 → Edited = 35 - 20 = 15.
    expect(origToEdited(35, [cut(10, 30), cut(15, 20)])).toBeCloseTo(15.0, 10)
    // Compare with the merged-equivalent disjoint input.
    expect(origToEdited(35, [cut(10, 30)])).toBeCloseTo(15.0, 10)
  })

  it('origToEdited: chain of overlapping cuts does not double-subtract', () => {
    // [10, 18] ∪ [15, 22] ∪ [20, 30] = [10, 30] (= 20 frames).
    // tOrig = 35 → 35 - 20 = 15.
    expect(origToEdited(35, [cut(10, 18), cut(15, 22), cut(20, 30)])).toBeCloseTo(
      15.0,
      10,
    )
  })

  it('origToEdited: touching cuts produce same result as one continuous cut', () => {
    // [10, 15] + [15, 20] = [10, 20] (= 10 frames).  tOrig = 25 → 25 - 10 = 15.
    expect(origToEdited(25, [cut(10, 15), cut(15, 20)])).toBeCloseTo(15.0, 10)
    expect(origToEdited(25, [cut(10, 20)])).toBeCloseTo(15.0, 10)
  })

  it('editedToOrig: nested cut yields the same result as the outer alone', () => {
    // Inverse of the above: Edited 15 → Original 35 with cuts unioning to [10, 30].
    expect(editedToOrig(15, [cut(10, 30), cut(15, 20)])).toBeCloseTo(35.0, 10)
    expect(editedToOrig(15, [cut(10, 30)])).toBeCloseTo(35.0, 10)
  })

  it('editedToOrig: touching cuts produce same result as one continuous cut', () => {
    expect(editedToOrig(15, [cut(10, 15), cut(15, 20)])).toBeCloseTo(25.0, 10)
    expect(editedToOrig(15, [cut(10, 20)])).toBeCloseTo(25.0, 10)
  })

  it('editedDuration: nested cut counts the OUTER interval once, not twice', () => {
    // Without the unionizeCuts fix, this would return 60 - (20 + 5) = 35
    // because inner [15, 20] = 5 frames would be subtracted on top of the
    // outer's 20.  The correct value is 60 - 20 = 40.
    expect(editedDuration(60, [cut(10, 30), cut(15, 20)])).toBe(40)
  })

  it('editedDuration: touching cuts count once total', () => {
    // [10, 15] + [15, 20] = 10 frames removed total.  60 - 10 = 50.
    expect(editedDuration(60, [cut(10, 15), cut(15, 20)])).toBe(50)
  })

  it('editedDuration: fully duplicated (startSec, endSec) does not double-subtract', () => {
    expect(editedDuration(60, [cut(10, 20), cut(10, 20)])).toBe(50)
  })

  it('origToEdited / editedToOrig: round-trip survives overlapping cuts', () => {
    // Round-trip lock — every t in [0, edited duration] must round-trip
    // back to itself through edited→orig→edited.  Anchors the
    // overlap-tolerant inverse pair contract.
    const cuts: Cut[] = [cut(10, 30), cut(15, 20)]   // nested
    for (const tEdited of [0, 5, 9, 10, 15, 25, 35]) {
      const tOrig = editedToOrig(tEdited, cuts)
      expect(origToEdited(tOrig, cuts)).toBeCloseTo(tEdited, 10)
    }
  })
})

// ---------------------------------------------------------------------------
// REQ-105 Phase 2 — downstream consumers of overlapping cuts.  Phase 2
// puts nested / touching cuts INTO storage; the consumers below must
// keep working without modification (RES-105 §1.3 B / Phase 2 verification
// gate).
//
// Each test exercises one consumer with a representative overlapping shape
// (nested outer/inner or touching) and locks the expected result.
// ---------------------------------------------------------------------------

describe('REQ-105 Phase 2: applyCutsToEntry with nested/touching cuts', () => {
  it('nested cuts: entry fully inside the OUTER → status trimDeleted (outer fires first)', () => {
    // Sort order after sanitize: outer first (tie-break endSec DESC).
    // applyCutsToEntry's branch (c) catches the outer at the first iter
    // and returns null — inner never gets visited.
    const cuts: Cut[] = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    const e = makeEntry(16, 18)
    expect(applyCutsToEntry(e, cuts)).toBeNull()
    expect(effectiveEntryState(e, cuts).status).toBe('trimDeleted')
  })

  it('nested cuts: removing the OUTER alone does NOT revive an entry the inner still consumes', () => {
    // Staged-unbind: user removes outer → entry is still inside inner →
    // remains trimDeleted.  Phase 5 will surface this as the "revive
    // failed" toast.
    const e = makeEntry(16, 18)
    // After removing outer, cuts = [inner only].
    const afterRemove = sanitizeCuts([cut(15, 20, 'inner')])
    expect(applyCutsToEntry(e, afterRemove)).toBeNull()
    expect(effectiveEntryState(e, afterRemove).status).toBe('trimDeleted')
  })

  it('nested cuts: removing BOTH revives the entry (becomes normal)', () => {
    const e = makeEntry(16, 18)
    expect(effectiveEntryState(e, []).status).toBe('normal')
    // Verify the entry data was not touched along the way.
    expect(e.startSec).toBe(16)
    expect(e.endSec).toBe(18)
    expect(e.isDeleted).toBe(false)
  })

  it('nested cuts: entry that straddles the outer head clamps normally', () => {
    // Entry [5, 15] straddles outer [10, 30]'s startSec.  applyCutsToEntry
    // takes branch (e) for the outer (tail-overlap from the entry's POV:
    // c.startSec(10) < e.endSec(15) AND e.endSec(15) <= c.endSec(30)),
    // clamps enClamped=10, and breaks.  Inner [15, 20] is past the break.
    const cuts: Cut[] = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    const e = makeEntry(5, 15)
    const r = applyCutsToEntry(e, cuts)
    expect(r).not.toBeNull()
    expect(r!.startSec).toBe(5)
    expect(r!.endSec).toBe(10)
    expect(effectiveEntryState(e, cuts).status).toBe('edited')
  })

  it('touching cuts: entry across the boundary is still head-clamped to the latest cut.endSec', () => {
    // Cuts [10,15] + [15,20] (touching).  Entry [12, 25].  Outer-first
    // sort gives [10,15] first.  Branch (d): clamps sClamped = 15.
    // Next iter cut [15,20]: branch (a) (c.endSec(20) <= e.startSec(12)?
    // No) → (d) again (c.startSec(15) <= e.startSec(12)? No) → (e)?
    // (c.startSec(15) < e.endSec(25)? yes AND e.endSec(25) <= c.endSec(20)?
    // No) → (f) middle… wait, c.startSec(15)===sClamped, but ALGORITHM
    // tests against e.startSec(12), not sClamped.  So this falls to
    // middleCuts.push({15,20}).  That's a middle cut by the algorithm's
    // contract even though sClamped already moved past it.
    //
    // Lock the resulting shape so a future cleanup that rewrote this path
    // would have to flip this assertion deliberately.
    const cuts: Cut[] = sanitizeCuts([cut(10, 15, 'a'), cut(15, 20, 'b')])
    const e = makeEntry(12, 25)
    const r = applyCutsToEntry(e, cuts)
    expect(r).not.toBeNull()
    expect(r!.startSec).toBe(15)
    expect(r!.endSec).toBe(25)
    // Touching second cut surfaces in middleCuts because the algorithm
    // reads e.startSec (not sClamped) — consistent with the Phase 0.5
    // invariant.  The visible duration math (sClamped..enClamped minus
    // middleCuts) collapses correctly: (25 - 15) - (20 - 15) = 5.
    expect(r!.middleCuts).toEqual([{ startSec: 15, endSec: 20 }])
  })
})

describe('REQ-105 Phase 2: count conservation + tab classification with overlapping cuts', () => {
  it('count conservation holds for an entries[] / nested-cuts pair', () => {
    // Three entries, two nested cuts.  The partition still satisfies
    // ready + deleted === all and `status` is in {normal, edited,
    // trimDeleted, manuallyDeleted} exactly once.
    const cuts: Cut[] = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    const entries: SubtitleEntry[] = [
      makeEntry(2, 5, 'before'),          // outside cuts → normal
      makeEntry(5, 12, 'tail-of-outer'),  // tail clamp by outer → edited
      makeEntry(16, 18, 'inside-both'),   // outer kills first → trimDeleted
      makeEntry(40, 45, 'after'),         // outside cuts → normal
    ]
    let normal = 0, edited = 0, trim = 0, manual = 0
    for (const e of entries) {
      const s = effectiveEntryState(e, cuts)
      switch (s.status) {
        case 'normal':           normal++; break
        case 'edited':           edited++; break
        case 'trimDeleted':      trim++; break
        case 'manuallyDeleted':  manual++; break
      }
    }
    expect(normal).toBe(2)
    expect(edited).toBe(1)
    expect(trim).toBe(1)
    expect(manual).toBe(0)
    expect(normal + edited + trim + manual).toBe(entries.length)
    expect((normal + edited) + (trim + manual)).toBe(entries.length)
  })
})

describe('REQ-105 Phase 2: buildKeptSegments + ffmpeg-trim-filter consume overlapping cuts correctly', () => {
  it('buildKeptSegments: nested cuts produce the SAME kept segments as the union [outer]', () => {
    // The user's burnin must NOT remove the inner cut's frames twice.
    // buildKeptSegments has a Math.max(cursor, c.endSec) that naturally
    // unions overlaps — verify it stays true with the Phase 2 storage
    // shape.
    const nested = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    const merged = sanitizeCuts([cut(10, 30, 'merged-equivalent')])
    expect(buildKeptSegments(60, nested)).toEqual(buildKeptSegments(60, merged))
    // Spot check: kept segments are [0,10] + [30,60].
    expect(buildKeptSegments(60, nested)).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 30, endSec: 60 },
    ])
  })

  it('buildKeptSegments: touching cuts produce the SAME kept segments as one continuous cut', () => {
    const touching = sanitizeCuts([cut(10, 15, 'a'), cut(15, 20, 'b')])
    expect(buildKeptSegments(60, touching)).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 20, endSec: 60 },
    ])
  })

  it('buildKeptSegments: 3-way overlap collapses to single union span', () => {
    const cuts = sanitizeCuts([cut(10, 18, 'a'), cut(15, 22, 'b'), cut(20, 30, 'c')])
    expect(buildKeptSegments(60, cuts)).toEqual([
      { startSec: 0, endSec: 10 },
      { startSec: 30, endSec: 60 },
    ])
  })
})

// ---------------------------------------------------------------------------
// REQ-105 Phase 3 — supplemental regression guards.  Each describe block
// addresses a verification slice from REQ-108 §a-f; together they fill the
// gaps left by Phase 1 / Phase 2 testing.
//
// Two of these blocks expose a Phase-2-reachable bug found during this
// verification pass: when nested or overlapping middle cuts fall strictly
// inside an entry, `applyCutsToEntry` used to double-count their removed
// frames in the visible-duration floor check.  The fix routes the
// `middleCuts` sum through `unionizeCuts` (`cuts.ts:223-234`).
// ---------------------------------------------------------------------------

describe('REQ-105 Phase 3 (a): state classification with nested + middle-cut mix', () => {
  it('manual delete WINS over a nested cut that would also kill the entry', () => {
    // Phase 2 nested storage shape: outer + inner both consume the entry,
    // AND the user manually deleted it.  Precedence order from REQ-103
    // boundary contract: manuallyDeleted > trimDeleted.  Tests both that
    // sanitizeCuts keeps both cuts in storage AND that the precedence
    // is unaffected.
    const cuts: Cut[] = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    const e: SubtitleEntry = { ...makeEntry(16, 18), isDeleted: true }
    const state = effectiveEntryState(e, cuts)
    expect(state.status).toBe('manuallyDeleted')
    expect(state.effectivelyDeleted).toBe(true)
  })

  it('entry with TWO nested middle cuts → status edited (REQ-105 Phase 3 bug fix lock)', () => {
    // ★ Phase 3 bug discovered: Entry [5, 30] with cuts [8, 28] and
    // [10, 26] (the second nested inside the first).  Both fall through
    // to branch (f) of applyCutsToEntry and accumulate in `middleCuts`.
    // The pre-fix `removedMiddleSec` summed them directly:
    //   removed = (28-8) + (26-10) = 20 + 16 = 36
    //   visibleSec = (30-5) - 36 = -11 → null → trimDeleted (WRONG)
    // The Phase 2 sanitize relaxation made this reachable.  The fix
    // unions middleCuts before summing:
    //   removed = union([{8,28},{10,26}]) = 20
    //   visibleSec = 25 - 20 = 5 → returns clamped → edited (CORRECT)
    const cuts: Cut[] = sanitizeCuts([cut(8, 28, 'outer'), cut(10, 26, 'inner')])
    const e = makeEntry(5, 30)
    const r = applyCutsToEntry(e, cuts)
    expect(r).not.toBeNull()
    expect(r!.startSec).toBe(5)
    expect(r!.endSec).toBe(30)
    // middleCuts itself still holds BOTH for the future scissor-badge
    // UI — only the visibleSec floor check uses the union.
    expect(r!.middleCuts).toHaveLength(2)
    expect(effectiveEntryState(e, cuts).status).toBe('edited')
  })

  it('entry with 3-deep nested middle cuts → status edited', () => {
    // Same bug class, depth-3 chain.  Real removed frames = 22 (outer);
    // naive sum would have been 22 + 18 + 6 = 46 (way over the 25-second
    // entry duration).
    const cuts: Cut[] = sanitizeCuts([
      cut(7, 29, 'l1'),
      cut(10, 28, 'l2'),
      cut(15, 21, 'l3'),
    ])
    const e = makeEntry(5, 30)
    const r = applyCutsToEntry(e, cuts)
    expect(r).not.toBeNull()
    expect(r!.middleCuts).toHaveLength(3)
    expect(effectiveEntryState(e, cuts).status).toBe('edited')
  })

  it('entry with disjoint middle cuts still computes visibleSec correctly (regression lock)', () => {
    // Lock that the union-in-floor-check change is a no-op for disjoint
    // middleCuts (the only shape that existed before Phase 2).
    const cuts: Cut[] = sanitizeCuts([cut(8, 10, 'a'), cut(20, 22, 'b')])
    const e = makeEntry(5, 30)
    const r = applyCutsToEntry(e, cuts)
    expect(r).not.toBeNull()
    expect(r!.startSec).toBe(5)
    expect(r!.endSec).toBe(30)
    expect(r!.middleCuts).toEqual([
      { startSec: 8, endSec: 10 },
      { startSec: 20, endSec: 22 },
    ])
    // Real visibleSec = 25 - 2 - 2 = 21 (well above the floor).
    expect(effectiveEntryState(e, cuts).status).toBe('edited')
  })

  it('entry with nested middles whose union still under-floors → null (trimDeleted)', () => {
    // The fix MUST still fire when even the unionized middle-cut span
    // exceeds the entry's duration.  Two cuts whose union spans almost
    // the entire entry width.
    const cuts: Cut[] = sanitizeCuts([cut(5.005, 5.99, 'a'), cut(5.04, 5.96, 'b')])
    const e = makeEntry(5, 6)
    expect(applyCutsToEntry(e, cuts)).toBeNull()
    expect(effectiveEntryState(e, cuts).status).toBe('trimDeleted')
  })
})

describe('REQ-105 Phase 3 (b): cross-cutting wasEdited filter with nested cuts', () => {
  it('wasEdited fires for nested-middle-cut entries (REQ-104 contract preserved)', () => {
    // REQ-104 extended `cutClamped` to fire when middleCuts.length > 0,
    // regardless of nesting.  This test pins that the nested-middles
    // bug fix above did not regress the wasEdited flag — the row still
    // surfaces in the cross-cutting 編集済み filter even though it
    // could have been silently mis-classified as trimDeleted pre-fix.
    const cuts: Cut[] = sanitizeCuts([cut(8, 28, 'outer'), cut(10, 26, 'inner')])
    const e = makeEntry(5, 30)
    const state = effectiveEntryState(e, cuts)
    expect(state.wasEdited).toBe(true)
    expect(state.effectivelyEdited).toBe(true)
    expect(state.effectivelyDeleted).toBe(false)
  })

  it('wasEdited STILL fires for a nested-killed entry that was once manually edited', () => {
    // The REQ-103 §B cross-cutting contract: a row that the user edited
    // and a cut later killed must still surface in the 編集済み filter
    // via `wasEdited` (= cross-cutting), even though `effectivelyEdited`
    // (= alias) goes false.
    const cuts: Cut[] = sanitizeCuts([cut(10, 30, 'outer'), cut(15, 20, 'inner')])
    const e: SubtitleEntry = { ...makeEntry(16, 18), isEdited: true }
    const state = effectiveEntryState(e, cuts)
    expect(state.status).toBe('trimDeleted')
    expect(state.wasEdited).toBe(true)         // ← user's manual edit
    expect(state.effectivelyEdited).toBe(false) // ← deleted, so alias goes false
  })
})

describe('REQ-105 Phase 3 (f): degenerate / boundary shapes', () => {
  it('two fully-identical cuts collapse via sanitize → behave like a single cut', () => {
    const cuts: Cut[] = sanitizeCuts([cut(10, 20, 'first'), cut(10, 20, 'second')])
    expect(cuts).toHaveLength(1)
    expect(cuts[0].id).toBe('first')
    const e = makeEntry(15, 18)
    expect(applyCutsToEntry(e, cuts)).toBeNull()
    expect(effectiveEntryState(e, cuts).status).toBe('trimDeleted')
  })

  it('chain of touching cuts behaves like one continuous cut for entry consumption', () => {
    // Three touching cuts: [5,10] + [10,15] + [15,20].  Entry [11, 14]
    // sits inside the middle one — but the union is [5, 20] so the
    // entry is wholly consumed.  applyCutsToEntry sees the middle cut
    // as case (c) (containment) and returns null directly.
    const cuts: Cut[] = sanitizeCuts([
      cut(5, 10, 'a'),
      cut(10, 15, 'b'),
      cut(15, 20, 'c'),
    ])
    expect(applyCutsToEntry(makeEntry(11, 14), cuts)).toBeNull()
  })

  it('depth-3 nested cuts that all contain the entry → outer fires first → trimDeleted', () => {
    // sanitizeCuts orders by startSec ASC, endSec DESC, so the outermost
    // cut comes first and applyCutsToEntry's branch (c) (full containment)
    // catches it immediately.  Inner cuts are never visited.
    const cuts: Cut[] = sanitizeCuts([
      cut(5, 40, 'L1-outer'),
      cut(7, 30, 'L2-middle'),
      cut(8, 25, 'L3-inner'),
    ])
    const e = makeEntry(15, 20)
    expect(applyCutsToEntry(e, cuts)).toBeNull()
    expect(effectiveEntryState(e, cuts).status).toBe('trimDeleted')
  })
})

// ---------------------------------------------------------------------------
// REQ-105 Phase 3 — Phase 4 PREP (no implementation, design sketch only).
//
// These tests do NOT exercise production code (containsCut / removableCutIds
// will be implemented in Phase 4).  They lock the EXPECTED algebra of the
// containment predicate against the Phase 2 sort order so Phase 4 can be
// implemented without re-discovering the rules.  Each `it()` block is a
// pure scenario description.
// ---------------------------------------------------------------------------

describe('REQ-105 Phase 3 (Phase 4 prep): containment algebra against Phase 2 sort order', () => {
  it('Phase 2 sort puts the WIDER cut first when two cuts share startSec', () => {
    // The `endSec DESC` tie-break is exactly what makes a one-pass
    // containment scan possible: the "wider" candidate is always seen
    // before the "narrower" one when they share startSec.
    const out = sanitizeCuts([cut(10, 15, 'narrow'), cut(10, 30, 'wide')])
    expect(out.map((c) => c.id)).toEqual(['wide', 'narrow'])
  })

  it('nested cuts (different startSec) keep startSec-ascending order', () => {
    // sanitizeCuts sorts by startSec ASC.  The outer (smaller startSec)
    // is naturally first.
    const out = sanitizeCuts([cut(15, 20, 'inner'), cut(10, 30, 'outer')])
    expect(out.map((c) => c.id)).toEqual(['outer', 'inner'])
  })

  it('a candidate "outer" must satisfy outer.startSec <= inner.startSec AND inner.endSec <= outer.endSec', () => {
    // Pure algebra — Phase 4 will implement this as `containsCut(outer,
    // inner)`.  Locks the predicate so Phase 4 can copy it verbatim.
    const outer = { startSec: 10, endSec: 30 }
    const inner = { startSec: 15, endSec: 20 }
    expect(outer.startSec <= inner.startSec).toBe(true)
    expect(inner.endSec <= outer.endSec).toBe(true)

    // Conversely: a non-containing case fails the predicate.
    const sibling = { startSec: 40, endSec: 50 }
    expect(outer.startSec <= sibling.startSec).toBe(true)
    expect(sibling.endSec <= outer.endSec).toBe(false)   // disjoint
  })

  it('a cut with NO outer containing it is "removable"; otherwise locked', () => {
    // Phase 4 will implement removableCutIds(cuts) as: for each cut c,
    // c is removable IFF no other cut in the same list contains it.
    // This test traces the expected output of that algorithm against a
    // mixed input.
    const cuts: Cut[] = sanitizeCuts([
      cut(10, 30, 'outer-A'),
      cut(15, 20, 'inner-of-A'),
      cut(40, 50, 'disjoint-B'),
      cut(45, 48, 'inner-of-B'),
    ])
    // Outer-A and disjoint-B have no container → removable.
    // Inner-of-A is inside outer-A → locked.
    // Inner-of-B is inside disjoint-B → locked.
    const removable = new Set<string>()
    for (const c of cuts) {
      const isInside = cuts.some(
        (o) =>
          o.id !== c.id &&
          o.startSec <= c.startSec &&
          c.endSec <= o.endSec,
      )
      if (!isInside) removable.add(c.id)
    }
    expect(removable).toEqual(new Set(['outer-A', 'disjoint-B']))
  })

  it('two fully-identical cuts: after sanitize dedupes, only one survives — that one is removable', () => {
    // The §4.5 dedupe rule combined with the containment algebra:
    // identical cuts collapse to one, which has no other cut containing
    // it, so it is removable.
    const cuts: Cut[] = sanitizeCuts([cut(10, 20, 'first'), cut(10, 20, 'second')])
    expect(cuts).toHaveLength(1)
  })
})
