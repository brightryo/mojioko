import { describe, it, expect } from 'vitest'
import {
  origToEdited,
  editedToOrig,
  editedDuration,
  applyCutsToEntry,
  effectiveEntryState,
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
