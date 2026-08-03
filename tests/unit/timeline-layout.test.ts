import { describe, expect, it } from 'vitest'
import { layoutEntries, LAYOUT_MIN_BLOCK_SEC } from '../../src/renderer/lib/timeline-layout'
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

describe('layoutEntries — rows = stored layer (REQ-0396)', () => {
  it('empty input → no rows', () => {
    const result = layoutEntries([], 10)
    expect(result.placements).toEqual([])
    expect(result.trackCount).toBe(0)
    expect(result.trackLayers).toEqual([])
  })

  it('all default (layer 0) sequential cues share the single row 0', () => {
    const result = layoutEntries([entry('a', 0, 1), entry('b', 1, 2), entry('c', 2, 3)], 10)
    expect(result.trackCount).toBe(1)
    expect(result.trackLayers).toEqual([0])
    expect(result.placements.map((p) => p.trackIndex)).toEqual([0, 0, 0])
  })

  it('★ same-layer cues that OVERLAP in time still share one row (no auto-separation)', () => {
    // The key REQ-0396 change: overlapping same-layer cues are NOT split onto
    // separate rows — they share row 0 (and overlap on it).
    const result = layoutEntries([entry('a', 0, 2), entry('b', 1, 3)], 10)
    expect(result.trackCount).toBe(1)
    expect(result.trackLayers).toEqual([0])
    expect(trackOf(result).get('a')).toBe(0)
    expect(trackOf(result).get('b')).toBe(0)
  })

  it('distinct layers make distinct rows, DESC (highest = top, layer 0 = bottom)', () => {
    const result = layoutEntries(
      [entry('back', 0, 2, 0), entry('mid', 0, 2, 1), entry('front', 0, 2, 2)],
      10,
    )
    expect(result.trackCount).toBe(3)
    expect(result.trackLayers).toEqual([2, 1, 0]) // top → bottom
    const t = trackOf(result)
    expect(t.get('front')).toBe(0) // layer 2 → top
    expect(t.get('mid')).toBe(1)
    expect(t.get('back')).toBe(2) // layer 0 → bottom
  })

  it('a cue never leaves its layer\'s row regardless of time (row is time-independent)', () => {
    // Two layer-1 cues at very different times both sit on the layer-1 row; the
    // layer-0 cue sits below.  Moving times around cannot change these rows.
    const result = layoutEntries(
      [entry('x', 0, 1, 1), entry('y', 100, 101, 1), entry('z', 50, 51, 0)],
      200,
    )
    expect(result.trackCount).toBe(2)
    expect(result.trackLayers).toEqual([1, 0])
    const t = trackOf(result)
    expect(t.get('x')).toBe(0)
    expect(t.get('y')).toBe(0) // same layer as x → same row, even far apart in time
    expect(t.get('z')).toBe(1) // layer 0 → bottom
  })

  it('sparse layer values still produce contiguous rows labelled with the layer', () => {
    const result = layoutEntries([entry('a', 0, 1, 0), entry('b', 2, 3, 5)], 10)
    expect(result.trackCount).toBe(2)
    expect(result.trackLayers).toEqual([5, 0]) // labels are the actual layer values
    const t = trackOf(result)
    expect(t.get('b')).toBe(0) // layer 5 → top row
    expect(t.get('a')).toBe(1) // layer 0 → bottom row
  })

  it('legacy negative layer still sorts below layer 0 (layoutEntries tolerant)', () => {
    // REQ-0397 §1 — the UI no longer GENERATES negative layers ("send to back"
    // floors at 0), but a project saved before that clamp may still carry one.
    // layoutEntries must remain tolerant: a negative layer sorts below layer 0.
    const result = layoutEntries([entry('a', 0, 1, 0), entry('back', 0, 1, -1)], 10)
    expect(result.trackLayers).toEqual([0, -1])
    const t = trackOf(result)
    expect(t.get('a')).toBe(0) // layer 0 → top of these two
    expect(t.get('back')).toBe(1) // layer -1 → bottom
  })

  it('totalSec spans the rightmost block', () => {
    const result = layoutEntries([entry('a', 0, 3), entry('b', 5, 12)], 8)
    expect(result.totalSec).toBe(12)
  })
})

describe('layoutEntries — legacy params are inert for rows (REQ-0396)', () => {
  it('LAYOUT_MIN_BLOCK_SEC is still exported', () => {
    expect(LAYOUT_MIN_BLOCK_SEC).toBe(0.05)
  })

  it('minBlockSec no longer affects row assignment', () => {
    // Adjacent short same-layer blocks share a row whether or not minBlockSec is
    // supplied — rows are z-order, not a visual time packing.
    const withMin = layoutEntries([entry('a', 1.0, 1.02), entry('b', 1.02, 1.04)], 10, LAYOUT_MIN_BLOCK_SEC)
    const without = layoutEntries([entry('a', 1.0, 1.02), entry('b', 1.02, 1.04)], 10)
    expect(withMin.trackCount).toBe(1)
    expect(without.trackCount).toBe(1)
  })

  it('greedyTimes override does not change rows (rows depend only on layer)', () => {
    // Two same-layer overlapping cues share row 0 with or without an override.
    const base = layoutEntries([entry('a', 10, 15), entry('b', 10, 15)], 20)
    const withOverride = layoutEntries(
      [entry('a', 10, 15), entry('b', 9.9, 14.9)],
      20,
      0,
      { greedyTimes: new Map([['b', { startSec: 10, endSec: 15 }]]) },
    )
    expect(base.trackCount).toBe(1)
    expect(withOverride.trackCount).toBe(1)
    expect(withOverride.placements.map((p) => p.trackIndex)).toEqual([0, 0])
  })
})
