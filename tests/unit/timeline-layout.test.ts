import { describe, expect, it } from 'vitest'
import { layoutEntries, timelineMaxRow, LAYOUT_MIN_BLOCK_SEC } from '../../src/renderer/lib/timeline-layout'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0396 — timeline rows ARE the stored z-order `layer` (no automatic
 * time-overlap separation).  `trackIndex` = rank of `resolveLayer(entry)` among
 * the distinct layers, DESCENDING (row 0 = top = highest layer; the last row is
 * layer 0 = bottom).  `trackLayers[i]` = the layer value for row i.  A cue never
 * leaves the row its own `layer` names; cues sharing a layer share a row.
 */

function entry(id: string, startSec: number, endSec: number, layer?: number): SubtitleEntry {
  const layoutDefaults = makeEntryLayoutDefaults()
  const base = {
    id,
    startSec,
    endSec,
    text: id,
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    ...layoutDefaults,
    ...(layer !== undefined ? { layer } : {}),
    isDeleted: false,
    isEdited: false,
  }
  return { ...base, original: { ...base } } as SubtitleEntry
}

const trackOf = (result: ReturnType<typeof layoutEntries>) =>
  new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))

describe('layoutEntries — contiguous rows 0..maxRow (REQ-0402)', () => {
  it('empty input → no rows', () => {
    const result = layoutEntries([], 10)
    expect(result.placements).toEqual([])
    expect(result.trackCount).toBe(0)
    expect(result.trackLayers).toEqual([])
  })

  it('all default (layer 0) cues share the bottom row; one spare row above', () => {
    // REQ-0402 — maxRow = 0 + 1 = 1, so two contiguous rows [1(spare), 0]; the
    // layer-0 cues sit on the BOTTOM row (trackIndex 1), the empty spare on top.
    const result = layoutEntries([entry('a', 0, 1), entry('b', 1, 2), entry('c', 2, 3)], 10)
    expect(result.trackCount).toBe(2)
    expect(result.trackLayers).toEqual([1, 0])
    expect(result.placements.map((p) => p.trackIndex)).toEqual([1, 1, 1])
  })

  it('★ same-layer cues that OVERLAP in time still share one row (no auto-separation)', () => {
    const result = layoutEntries([entry('a', 0, 2), entry('b', 1, 3)], 10)
    expect(result.trackCount).toBe(2) // layer-0 row + one spare
    expect(result.trackLayers).toEqual([1, 0])
    expect(trackOf(result).get('a')).toBe(1) // both on the layer-0 (bottom) row
    expect(trackOf(result).get('b')).toBe(1)
  })

  it('distinct layers make contiguous rows (highest+1 = top spare, layer 0 = bottom)', () => {
    const result = layoutEntries(
      [entry('back', 0, 2, 0), entry('mid', 0, 2, 1), entry('front', 0, 2, 2)],
      10,
    )
    expect(result.trackCount).toBe(4) // rows for layers 3(spare),2,1,0
    expect(result.trackLayers).toEqual([3, 2, 1, 0]) // top → bottom
    const t = trackOf(result)
    expect(t.get('front')).toBe(1) // layer 2 → row index 1
    expect(t.get('mid')).toBe(2)
    expect(t.get('back')).toBe(3) // layer 0 → bottom
  })

  it('a cue never leaves its layer\'s row regardless of time (row is time-independent)', () => {
    const result = layoutEntries(
      [entry('x', 0, 1, 1), entry('y', 100, 101, 1), entry('z', 50, 51, 0)],
      200,
    )
    expect(result.trackCount).toBe(3) // layers 2(spare),1,0
    expect(result.trackLayers).toEqual([2, 1, 0])
    const t = trackOf(result)
    expect(t.get('x')).toBe(1) // layer 1 → row index 1
    expect(t.get('y')).toBe(1) // same layer as x → same row, even far apart in time
    expect(t.get('z')).toBe(2) // layer 0 → bottom
  })

  it('★ sparse layer values fill in the GAPS — contiguous rows, no skipped numbers', () => {
    // The core REQ-0402 fix: layers {0,5} render as rows 6..0 (7 rows), so the
    // gutter shows 0,1,2,3,4,5,6 with no jump (the REQ-0399 "1 → 3" gap is gone).
    const result = layoutEntries([entry('a', 0, 1, 0), entry('b', 2, 3, 5)], 10)
    expect(result.trackCount).toBe(7)
    expect(result.trackLayers).toEqual([6, 5, 4, 3, 2, 1, 0]) // contiguous
    const t = trackOf(result)
    expect(t.get('b')).toBe(1) // layer 5 → row index 6−5 = 1
    expect(t.get('a')).toBe(6) // layer 0 → bottom row
  })

  it('legacy negative layer clamps onto the layer-0 row (floor 0, REQ-0402)', () => {
    // REQ-0397 §1 stopped GENERATING negatives; REQ-0402 renders rows only from
    // 0 up, so a legacy negative clamps onto the bottom (layer-0) row.
    const result = layoutEntries([entry('a', 0, 1, 0), entry('back', 0, 1, -1)], 10)
    expect(result.trackLayers).toEqual([1, 0]) // no row below 0
    const t = trackOf(result)
    expect(t.get('a')).toBe(1) // layer 0 → bottom
    expect(t.get('back')).toBe(1) // -1 clamped to the layer-0 row too
  })

  it('caps rows at MAX_LAYER (50): a cue at 50 gets no spare above', () => {
    const result = layoutEntries([entry('a', 0, 1, 50), entry('b', 0, 1, 0)], 10)
    expect(result.trackCount).toBe(51) // layers 50..0, no 51st spare
    expect(result.trackLayers[0]).toBe(50)
    expect(result.trackLayers[50]).toBe(0)
    const t = trackOf(result)
    expect(t.get('a')).toBe(0) // layer 50 → top
    expect(t.get('b')).toBe(50) // layer 0 → bottom
  })

  it('totalSec spans the rightmost block', () => {
    const result = layoutEntries([entry('a', 0, 3), entry('b', 5, 12)], 8)
    expect(result.totalSec).toBe(12)
  })
})

describe('timelineMaxRow (REQ-0402)', () => {
  it('empty → 0', () => {
    expect(timelineMaxRow([])).toBe(0)
  })
  it('all layer 0 → 1 (one spare above)', () => {
    expect(timelineMaxRow([entry('a', 0, 1), entry('b', 1, 2)])).toBe(1)
  })
  it('highest occupied + 1', () => {
    expect(timelineMaxRow([entry('a', 0, 1, 0), entry('b', 0, 1, 4)])).toBe(5)
  })
  it('caps at 50', () => {
    expect(timelineMaxRow([entry('a', 0, 1, 50)])).toBe(50)
  })
  it('legacy negatives do not drop below 0', () => {
    expect(timelineMaxRow([entry('a', 0, 1, -3)])).toBe(1)
  })
})

describe('layoutEntries — legacy params are inert for rows (REQ-0396/0402)', () => {
  it('LAYOUT_MIN_BLOCK_SEC is still exported', () => {
    expect(LAYOUT_MIN_BLOCK_SEC).toBe(0.05)
  })

  it('minBlockSec no longer affects row assignment', () => {
    const withMin = layoutEntries([entry('a', 1.0, 1.02), entry('b', 1.02, 1.04)], 10, LAYOUT_MIN_BLOCK_SEC)
    const without = layoutEntries([entry('a', 1.0, 1.02), entry('b', 1.02, 1.04)], 10)
    expect(withMin.trackCount).toBe(2) // layer-0 row + spare
    expect(without.trackCount).toBe(2)
  })

  it('greedyTimes override does not change rows (rows depend only on layer)', () => {
    const base = layoutEntries([entry('a', 10, 15), entry('b', 10, 15)], 20)
    const withOverride = layoutEntries(
      [entry('a', 10, 15), entry('b', 9.9, 14.9)],
      20,
      0,
      { greedyTimes: new Map([['b', { startSec: 10, endSec: 15 }]]) },
    )
    expect(base.trackCount).toBe(2)
    expect(withOverride.trackCount).toBe(2)
    expect(withOverride.placements.map((p) => p.trackIndex)).toEqual([1, 1]) // both on layer-0 row
  })
})
