import { describe, it, expect } from 'vitest'
import { filterEntries } from '../../src/renderer/lib/subtitle-filter'
import {
  sanitizeCuts,
  effectiveEntryState,
  type Cut,
} from '../../src/shared/cuts'
import type { SubtitleEntry } from '../../src/shared/types'
import type { EntryWarnings } from '../../src/renderer/lib/entry-warnings'

/**
 * REQ-111 — production-path parity tests for the Step 2 tab counts.
 *
 * Built specifically to lock the REQ-104 invariant "middle cut → edited,
 * NOT trim-deleted" against the entire Phase 1-5 plumbing.  Each test
 * compares two predicates side-by-side:
 *
 *   - `filterEntries(...)` (= subtitle-filter.ts, drives the table view)
 *   - `entries.filter(e => effectiveEntryState(e, cuts).<flag>).length`
 *     (= step2.tsx tab-count predicate)
 *
 * Both must agree on every (entries, cuts) shape — that's the
 * "test/production parity" gate REQ-111 spelled out.  If a future change
 * lets one path diverge from the other, these tests are the surface where
 * it will fail.
 */

function makeEntry(
  startSec: number,
  endSec: number,
  id = `e-${startSec}-${endSec}`,
  overrides?: Partial<SubtitleEntry>,
): SubtitleEntry {
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
    ...overrides,
  }
}

function cut(startSec: number, endSec: number, id?: string): Cut {
  return { startSec, endSec, id: id ?? `c-${startSec}-${endSec}` }
}

const EMPTY_WARNINGS_MAP = new Map<string, EntryWarnings>()

// ---------------------------------------------------------------------------
// REQ-111 — the user's regression: middle cut on a clip with lots remaining
// must NOT count as deleted.  The 41-entry fixture mirrors the user's
// observed numbers ("すべて41 / 出力対象40 / 削除1 / 編集済み1") so the test
// reproduces the count surface area where the report fired.
// ---------------------------------------------------------------------------

describe('REQ-111: pure middle cut on a wide entry → edited, NOT trim-deleted', () => {
  // Simulates 41 Whisper-style entries followed by ONE small middle cut.
  // No entry is fully contained, no head/tail clamp, no nesting.
  // Locks both filter paths and the count-predicate path.
  const entries: SubtitleEntry[] = []
  for (let i = 0; i < 41; i++) {
    entries.push(makeEntry(i * 10, i * 10 + 10, `whisper-${i}`))
  }
  // Middle of entry 20 (= [200, 210]).  Cut is 4 seconds; entry has 6
  // seconds of visible time remaining — way above the 0.05s floor.
  const cuts: Cut[] = sanitizeCuts([cut(203, 207, 'middle-cut')])

  it('filterEntries("deleted") returns empty array', () => {
    expect(filterEntries(entries, 'deleted', EMPTY_WARNINGS_MAP, cuts)).toEqual([])
  })

  it('filterEntries("ready") returns ALL 41 entries', () => {
    expect(filterEntries(entries, 'ready', EMPTY_WARNINGS_MAP, cuts)).toHaveLength(41)
  })

  it('filterEntries("edited") returns exactly the middle-cut entry', () => {
    const result = filterEntries(entries, 'edited', EMPTY_WARNINGS_MAP, cuts)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('whisper-20')
  })

  it('step2-style deletedCount predicate agrees with the filter (= 0)', () => {
    // Mimic step2.tsx:289-292 exactly so a regression in either path
    // surfaces here.
    const deletedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    expect(deletedCount).toBe(0)
  })

  it('step2-style readyCount predicate agrees with the filter (= 41)', () => {
    const readyCount = entries.filter(
      (e) => !effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    expect(readyCount).toBe(41)
  })

  it('step2-style editedCount predicate agrees with the filter (= 1)', () => {
    const editedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).wasEdited,
    ).length
    expect(editedCount).toBe(1)
  })

  it('count conservation: ready + deleted === all (= 41)', () => {
    // The REQ-103 §6 invariant, exercised through the production filter.
    const readyCount = filterEntries(entries, 'ready', EMPTY_WARNINGS_MAP, cuts).length
    const deletedCount = filterEntries(entries, 'deleted', EMPTY_WARNINGS_MAP, cuts).length
    expect(readyCount + deletedCount).toBe(entries.length)
  })

  it('the middle-cut entry has status "edited" (REQ-104 lock, not trimDeleted)', () => {
    const e = entries[20]
    const state = effectiveEntryState(e, cuts)
    expect(state.status).toBe('edited')
    expect(state.effectivelyDeleted).toBe(false)
    expect(state.wasEdited).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// REQ-111 — the "different entries" interpretation: a cut that the user
// thinks is a middle cut on entry A may simultaneously consume a different
// short entry B.  Spec says B is trim-deleted; this test pins that contract.
// ---------------------------------------------------------------------------

describe('REQ-111: cut that mid-cuts one entry AND consumes another short entry', () => {
  const entries: SubtitleEntry[] = [
    makeEntry(0, 30, 'wide-entry-A'),   // straddles cut both sides → edited
    makeEntry(10, 15, 'short-entry-B'), // fully inside cut → trimDeleted
    makeEntry(50, 60, 'unrelated-C'),   // outside cut → normal
  ]
  const cuts: Cut[] = sanitizeCuts([cut(8, 20, 'cut-spanning-both')])

  it('wide entry A is "edited" (middle cut)', () => {
    expect(effectiveEntryState(entries[0], cuts).status).toBe('edited')
  })

  it('short entry B is "trimDeleted" (full containment)', () => {
    expect(effectiveEntryState(entries[1], cuts).status).toBe('trimDeleted')
  })

  it('unrelated entry C is "normal"', () => {
    expect(effectiveEntryState(entries[2], cuts).status).toBe('normal')
  })

  it('counts: ready=2, deleted=1, edited=1', () => {
    const readyCount = entries.filter(
      (e) => !effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    const deletedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    const editedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).wasEdited,
    ).length
    expect(readyCount).toBe(2)
    expect(deletedCount).toBe(1)
    expect(editedCount).toBe(1)
    expect(readyCount + deletedCount).toBe(entries.length)
  })

  it('the deleted-tab filter surfaces ONLY the consumed short entry', () => {
    const deleted = filterEntries(entries, 'deleted', EMPTY_WARNINGS_MAP, cuts)
    expect(deleted.map((e) => e.id)).toEqual(['short-entry-B'])
  })
})

// ---------------------------------------------------------------------------
// REQ-111 — REQ-103 §B cross-cutting wasEdited: an entry the user previously
// manually edited, then a cut trims it.  The same entry surfaces in BOTH
// the 削除 tab (status = trimDeleted) AND the 編集済み tab (wasEdited via
// entry.isEdited).  This is the user's likely observed "deleted=1 + edited=1
// both pointing to the same row" scenario — by design per REQ-103, not a bug.
// ---------------------------------------------------------------------------

describe('REQ-111: previously-edited entry + trim-cut → both deleted AND edited (REQ-103 §B)', () => {
  // Entry [10, 15] was manually edited (e.g. text changed → isEdited:true),
  // then a cut [10, 15] fully consumes it.
  const entries: SubtitleEntry[] = [
    { ...makeEntry(10, 15, 'edited-then-trimmed'), isEdited: true },
  ]
  const cuts: Cut[] = sanitizeCuts([cut(10, 15, 'consume')])

  it('status is "trimDeleted" (full containment)', () => {
    expect(effectiveEntryState(entries[0], cuts).status).toBe('trimDeleted')
  })

  it('wasEdited is true (preserved from entry.isEdited)', () => {
    expect(effectiveEntryState(entries[0], cuts).wasEdited).toBe(true)
  })

  it('appears in BOTH the deleted filter AND the edited filter (REQ-103 §B cross-cutting)', () => {
    const deleted = filterEntries(entries, 'deleted', EMPTY_WARNINGS_MAP, cuts)
    const edited = filterEntries(entries, 'edited', EMPTY_WARNINGS_MAP, cuts)
    expect(deleted.map((e) => e.id)).toEqual(['edited-then-trimmed'])
    expect(edited.map((e) => e.id)).toEqual(['edited-then-trimmed'])
  })

  it('count conservation still holds (ready + deleted === all)', () => {
    const readyCount = entries.filter(
      (e) => !effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    const deletedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    expect(readyCount + deletedCount).toBe(entries.length)
  })
})

// ---------------------------------------------------------------------------
// REQ-111 — boundary regression locks.  Each of these scenarios was the
// surface of a past bug at some point in REQ-103 / 104 / 105 Phase 1-5.
// Keep them green so the user's reported regression never silently flips.
// ---------------------------------------------------------------------------

describe('REQ-111: boundary scenarios from prior REQ regressions', () => {
  it('entry exactly equal to cut → trimDeleted (boundary case (c))', () => {
    const e = makeEntry(10, 20)
    expect(effectiveEntryState(e, sanitizeCuts([cut(10, 20)])).status).toBe('trimDeleted')
  })

  it('entry endSec === cut.endSec → trimDeleted (boundary, REQ-101)', () => {
    const e = makeEntry(15, 20)
    expect(effectiveEntryState(e, sanitizeCuts([cut(10, 20)])).status).toBe('trimDeleted')
  })

  it('entry startSec === cut.startSec → trimDeleted (boundary, REQ-101)', () => {
    const e = makeEntry(10, 15)
    expect(effectiveEntryState(e, sanitizeCuts([cut(10, 20)])).status).toBe('trimDeleted')
  })

  it('cut strictly inside entry, both sides survive → edited (REQ-104 lock)', () => {
    const e = makeEntry(5, 30)
    expect(effectiveEntryState(e, sanitizeCuts([cut(12, 14)])).status).toBe('edited')
  })

  it('cut clamps entry head only → edited (Phase 0.5 trace 1 stripe)', () => {
    const e = makeEntry(5, 20)
    expect(effectiveEntryState(e, sanitizeCuts([cut(3, 7)])).status).toBe('edited')
  })

  it('cut clamps entry tail only → edited', () => {
    const e = makeEntry(5, 20)
    expect(effectiveEntryState(e, sanitizeCuts([cut(15, 25)])).status).toBe('edited')
  })

  it('nested middle cuts inside entry (Phase 3 fix) → edited', () => {
    const e = makeEntry(5, 30)
    const cuts = sanitizeCuts([cut(8, 28, 'outer'), cut(10, 26, 'inner')])
    expect(effectiveEntryState(e, cuts).status).toBe('edited')
  })

  it('Phase 3 floor case: extremely small visibleSec → trimDeleted', () => {
    // Entry length 1.0, two cuts whose union covers 0.96+ of it.
    const e = makeEntry(5, 6)
    const cuts = sanitizeCuts([cut(5.005, 5.99), cut(5.04, 5.96)])
    expect(effectiveEntryState(e, cuts).status).toBe('trimDeleted')
  })
})

// ---------------------------------------------------------------------------
// REQ-111 — test/production parity surface check.  For every scenario above,
// the assertion below holds: subtitle-filter.ts and effectiveEntryState
// produce IDENTICAL classifications for every entry.  Locks the rule
// physically — adding a second predicate to either path would break this.
// ---------------------------------------------------------------------------

describe('REQ-111: subtitle-filter.ts and effectiveEntryState classify every entry identically', () => {
  it('agreement holds across a mixed (normal / edited / trimDeleted / manuallyDeleted) shape', () => {
    const entries: SubtitleEntry[] = [
      makeEntry(0, 5, 'normal-A'),
      makeEntry(20, 25, 'normal-B'),
      makeEntry(10, 14, 'middle-cut-target'),  // becomes edited via middle cut [11,13]
      makeEntry(30, 35, 'fully-contained'),    // becomes trimDeleted
      { ...makeEntry(40, 45, 'manually-deleted'), isDeleted: true },
      { ...makeEntry(50, 55, 'edited-then-trimmed'), isEdited: true },  // wasEdited+trimDeleted
    ]
    const cuts: Cut[] = sanitizeCuts([
      cut(11, 13, 'middle'),
      cut(28, 40, 'wide'),          // consumes 'fully-contained' [30,35]
      cut(50, 55, 'consume-edited'),// consumes 'edited-then-trimmed'
    ])

    // Walk every entry via both paths.  filterEntries uses a `switch` per
    // filter key, so we mirror each branch and compare the resulting id
    // sets.
    const filteredDeleted = new Set(
      filterEntries(entries, 'deleted', EMPTY_WARNINGS_MAP, cuts).map((e) => e.id),
    )
    const predicateDeleted = new Set(
      entries.filter(
        (e) => effectiveEntryState(e, cuts).effectivelyDeleted,
      ).map((e) => e.id),
    )
    expect(filteredDeleted).toEqual(predicateDeleted)

    const filteredReady = new Set(
      filterEntries(entries, 'ready', EMPTY_WARNINGS_MAP, cuts).map((e) => e.id),
    )
    const predicateReady = new Set(
      entries.filter(
        (e) => !effectiveEntryState(e, cuts).effectivelyDeleted,
      ).map((e) => e.id),
    )
    expect(filteredReady).toEqual(predicateReady)

    const filteredEdited = new Set(
      filterEntries(entries, 'edited', EMPTY_WARNINGS_MAP, cuts).map((e) => e.id),
    )
    const predicateEdited = new Set(
      entries.filter((e) => effectiveEntryState(e, cuts).wasEdited).map((e) => e.id),
    )
    expect(filteredEdited).toEqual(predicateEdited)
  })
})

// ---------------------------------------------------------------------------
// REQ-112 — the owner's actual reproduction.  REQ-111 missed it because the
// fixture used a single isolated middle cut; the real shape needs a
// head-clamp cut + a middle cut nested INSIDE the head-clamp range so
// applyCutsToEntry over-subtracts the inner middle.  Mirror the production
// count path AND the timeline-view extra filter so the "削除 1 / タイムライン
// 表示 0" mismatch the owner saw is reproducible here.
// ---------------------------------------------------------------------------

describe('REQ-112: owner reproduction — head clamp + inner middle (REAL count vs display divergence)', () => {
  // Entries with 1s gaps so the head-clamp cut on entry 20 cannot leak
  // into entry 19 (= isolates the bug surface to entry 20 exactly).
  // Each entry is 8s wide; gap is 2s.  Entry i = [i*10, i*10 + 8].
  const entries: SubtitleEntry[] = []
  for (let i = 0; i < 41; i++) {
    entries.push(makeEntry(i * 10, i * 10 + 8, `whisper-${i}`))
  }
  // Entry 20 = [200, 208].  Head clamp [199, 206] starts in the 2s gap
  // before entry 20 (entry 19 ends at 198), so cut affects entry 20 ONLY.
  // Inner middle [201, 204] sits inside the head-clamped [206..208]
  // window's complement — the very shape that triggered the bug.
  const cuts: Cut[] = sanitizeCuts([
    cut(199, 206, 'pre-existing-head'),
    cut(201, 204, 'small-middle'),
  ])

  it('★ post-REQ-112: filterEntries("deleted") is EMPTY (no entry classified as trimDeleted)', () => {
    // Pre-REQ-112 this would have returned [entries[20]].  Post-fix the
    // clip step keeps middle [201, 204] out of the sClamped=206..208
    // window, so visibleSec stays positive and entry 20 is 'edited'.
    expect(filterEntries(entries, 'deleted', EMPTY_WARNINGS_MAP, cuts)).toEqual([])
  })

  it('★ post-REQ-112: deletedCount = 0', () => {
    const deletedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    expect(deletedCount).toBe(0)
  })

  it('★ post-REQ-112: editedCount = 1 (entry 20 alone, no leak into entry 19)', () => {
    const editedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).wasEdited,
    ).length
    expect(editedCount).toBe(1)
    expect(effectiveEntryState(entries[20], cuts).status).toBe('edited')
    // Entry 19 = [190, 198], cut [199, 206] doesn't touch it.
    expect(effectiveEntryState(entries[19], cuts).status).toBe('normal')
  })

  it('★ count and timeline-display agree (no "1 counted / 0 displayed" mismatch)', () => {
    // The timeline view (RES-103) applies an additional
    // `.filter(!effectivelyDeleted)` on top of `filterEntries('deleted')`.
    // Pre-fix: `filterEntries('deleted')` returned the entry, the timeline
    // strip dropped it → count=1, display=0.  Post-fix: filter returns
    // empty → count=0, display=0.  They agree.
    const filterResult = filterEntries(entries, 'deleted', EMPTY_WARNINGS_MAP, cuts)
    const timelineDisplay = filterResult.filter(
      (e) => !effectiveEntryState(e, cuts).effectivelyDeleted,
    )
    expect(filterResult.length).toBe(timelineDisplay.length)
    expect(filterResult.length).toBe(0)
  })

  it('count conservation still holds (ready + deleted === all)', () => {
    const readyCount = entries.filter(
      (e) => !effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    const deletedCount = entries.filter(
      (e) => effectiveEntryState(e, cuts).effectivelyDeleted,
    ).length
    expect(readyCount + deletedCount).toBe(entries.length)
  })
})
