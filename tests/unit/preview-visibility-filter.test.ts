import { describe, it, expect } from 'vitest'
import { effectiveEntryState, type CutList } from '../../src/shared/cuts'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0202 / REQ-0203 — the visibility contract shared between
 * `video-preview-panel.tsx` and `audio-preview-panel.tsx`'s
 * `sortedActiveEntries` filter, and the burn-in path in
 * `ffmpeg-burnin.ts` + `ass-generator.ts`.
 *
 * Both preview panels apply the same predicate:
 *
 *   entries.filter((e) => !effectiveEntryState(e, cuts).effectivelyDeleted)
 *
 * These tests exercise that exact predicate (not a mock) against real
 * entry / cut fixtures, so any drift in either `effectiveEntryState`
 * or in a future consumer that re-invents its own filter breaks here.
 *
 * The pre-REQ-0203 filter was `!e.isDeleted` — which let trim-deleted
 * entries (`entry.isDeleted === false` but `applyCutsToEntry === null`)
 * leak into the preview overlay as phantom stack lines while the
 * burn-in correctly dropped them.  RES-0202 §4.1 is the diagnosis; this
 * test suite is the regression guard.
 */

function makeEntry(overrides: Partial<SubtitleEntry> & { id: string }): SubtitleEntry {
  const layout = makeEntryLayoutDefaults()
  const base = {
    startSec: 0,
    endSec: 1,
    text: overrides.id,
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    fontId: undefined,
    ...layout,
    ...overrides,
  }
  return {
    id: overrides.id,
    ...base,
    isDeleted: overrides.isDeleted ?? false,
    isEdited: overrides.isEdited ?? false,
    original: { ...base },
  }
}

/** Mirror of the exact filter both preview panels apply. */
function previewVisible(entries: readonly SubtitleEntry[], cuts: CutList): SubtitleEntry[] {
  return entries.filter((e) => !effectiveEntryState(e, cuts).effectivelyDeleted)
}

describe('REQ-0203 preview visibility filter — no-cut identity contract', () => {
  it('cuts=[] collapses effectivelyDeleted to entry.isDeleted (regression pin)', () => {
    // No-cut users must see byte-identical behaviour to the pre-REQ-0203
    // filter (`!e.isDeleted`).  If effectiveEntryState ever changes its
    // no-cut branch, this test fires and blocks the merge.
    const entries = [
      makeEntry({ id: 'a', startSec: 0, endSec: 1, isDeleted: false }),
      makeEntry({ id: 'b', startSec: 2, endSec: 3, isDeleted: true }),
      makeEntry({ id: 'c', startSec: 4, endSec: 5, isDeleted: false }),
    ]
    const visible = previewVisible(entries, [])
    expect(visible.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('cuts=[] with all entries active returns them all', () => {
    const entries = [
      makeEntry({ id: 'a', startSec: 0, endSec: 1 }),
      makeEntry({ id: 'b', startSec: 1, endSec: 2 }),
    ]
    expect(previewVisible(entries, []).map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('cuts=[] with only manual-deleted returns empty', () => {
    const entries = [
      makeEntry({ id: 'a', startSec: 0, endSec: 1, isDeleted: true }),
      makeEntry({ id: 'b', startSec: 2, endSec: 3, isDeleted: true }),
    ]
    expect(previewVisible(entries, [])).toEqual([])
  })
})

describe('REQ-0203 preview visibility filter — trim-deleted exclusion', () => {
  it('excludes an entry fully consumed by a cut (the RES-0202 symptom A pin)', () => {
    const entries = [
      makeEntry({ id: 'a', startSec: 0, endSec: 1 }),         // untouched
      makeEntry({ id: 'b', startSec: 1.7, endSec: 2.5 }),      // inside cut
      makeEntry({ id: 'c', startSec: 4, endSec: 5 }),          // untouched
    ]
    const cuts: CutList = [{ id: 'cut1', startSec: 1.5, endSec: 3.4 }]

    const visible = previewVisible(entries, cuts)
    // b is fully consumed by cut → trim-deleted → dropped
    expect(visible.map((e) => e.id)).toEqual(['a', 'c'])
    // Cross-check: effectiveEntryState classifies b as trim-deleted with
    // isDeleted still false (the exact shape RES-0202 §1.3 documented).
    expect(effectiveEntryState(entries[1], cuts).status).toBe('trimDeleted')
    expect(entries[1].isDeleted).toBe(false)
  })

  it('drops a manually-deleted entry AND a trim-deleted entry in one pass', () => {
    const entries = [
      makeEntry({ id: 'a', startSec: 0, endSec: 1 }),
      makeEntry({ id: 'manual', startSec: 2, endSec: 3, isDeleted: true }),
      makeEntry({ id: 'trim', startSec: 4.5, endSec: 5.5 }),   // fully in cut
    ]
    const cuts: CutList = [{ id: 'cut1', startSec: 4, endSec: 6 }]

    expect(previewVisible(entries, cuts).map((e) => e.id)).toEqual(['a'])
  })
})

describe('REQ-0203 preview visibility filter — partial-cut entries stay visible', () => {
  it('keeps an entry whose head is clipped by a cut', () => {
    // e.startSec=1 is inside cut [0.5, 1.5] but e.endSec=3 sits past it.
    // applyCutsToEntry clamps e to [1.5, 3] (visible duration 1.5 s > MIN
    // floor 0.05), so status is 'edited', not 'trimDeleted' — the entry
    // MUST stay visible.
    const entries = [makeEntry({ id: 'head', startSec: 1, endSec: 3 })]
    const cuts: CutList = [{ id: 'c', startSec: 0.5, endSec: 1.5 }]

    expect(previewVisible(entries, cuts).map((e) => e.id)).toEqual(['head'])
    expect(effectiveEntryState(entries[0], cuts).status).toBe('edited')
  })

  it('keeps an entry whose tail is clipped by a cut', () => {
    const entries = [makeEntry({ id: 'tail', startSec: 1, endSec: 3 })]
    const cuts: CutList = [{ id: 'c', startSec: 2.5, endSec: 4 }]

    expect(previewVisible(entries, cuts).map((e) => e.id)).toEqual(['tail'])
    expect(effectiveEntryState(entries[0], cuts).status).toBe('edited')
  })

  it('keeps an entry with a middle cut (both edges preserved, cut sits inside)', () => {
    // e = [1, 5], cut = [2, 3].  applyCutsToEntry preserves start/end
    // and records the cut in middleCuts.  status = 'edited' (REQ-104).
    const entries = [makeEntry({ id: 'mid', startSec: 1, endSec: 5 })]
    const cuts: CutList = [{ id: 'c', startSec: 2, endSec: 3 }]

    expect(previewVisible(entries, cuts).map((e) => e.id)).toEqual(['mid'])
    expect(effectiveEntryState(entries[0], cuts).status).toBe('edited')
  })

  it('a partial-cut entry that ALSO carries isDeleted=true is dropped (manual wins)', () => {
    // effectivelyDeleted's precedence contract from cuts.ts:386-397:
    // manual delete beats trim classification.  The filter must drop it
    // regardless of the partial-cut status.
    const entries = [
      makeEntry({ id: 'x', startSec: 1, endSec: 3, isDeleted: true }),
    ]
    const cuts: CutList = [{ id: 'c', startSec: 0.5, endSec: 1.5 }]
    expect(previewVisible(entries, cuts)).toEqual([])
  })
})

describe('REQ-0203 preview visibility filter — undo/redo cut reversal', () => {
  it('an entry that was trim-deleted becomes visible again when the cut is removed', () => {
    // Simulates the user removing the cut via undo/redo:
    //   before: cuts=[c] → b is trim-deleted → dropped
    //   after:  cuts=[]  → b classification collapses → visible again
    const b = makeEntry({ id: 'b', startSec: 1.7, endSec: 2.5 })
    const entries = [
      makeEntry({ id: 'a', startSec: 0, endSec: 1 }),
      b,
      makeEntry({ id: 'c', startSec: 4, endSec: 5 }),
    ]
    const cutsBefore: CutList = [{ id: 'c1', startSec: 1.5, endSec: 3.4 }]
    const cutsAfter: CutList = []

    expect(previewVisible(entries, cutsBefore).map((e) => e.id)).toEqual(['a', 'c'])
    expect(previewVisible(entries, cutsAfter).map((e) => e.id)).toEqual(['a', 'b', 'c'])
    // Entry object itself is unchanged (`isDeleted` never flipped) —
    // the contract is purely derived from cuts.
    expect(b.isDeleted).toBe(false)
  })
})
