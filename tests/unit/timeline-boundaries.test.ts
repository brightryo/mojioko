import { describe, it, expect } from 'vitest'
import {
  buildBoundarySet,
  findPrevBoundary,
  findNextBoundary,
} from '../../src/renderer/lib/timeline-boundaries'
import type { Cut } from '../../src/shared/cuts'
import type { SubtitleEntry } from '../../src/shared/types'

function makeEntry(
  id: string,
  startSec: number,
  endSec: number,
  overrides?: Partial<SubtitleEntry>,
): SubtitleEntry {
  const base = {
    startSec,
    endSec,
    text: id,
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

// ---------------------------------------------------------------------------
// buildBoundarySet
// ---------------------------------------------------------------------------

describe('buildBoundarySet', () => {
  it('collects every start and end timestamp', () => {
    const entries = [
      makeEntry('a', 1, 3),
      makeEntry('b', 5, 8),
    ]
    expect(buildBoundarySet(entries, [])).toEqual([1, 3, 5, 8])
  })

  it('dedupes identical timestamps (adjacent block end === next block start)', () => {
    // 'a' ends at 3 and 'b' starts at 3 — the boundary set must contain
    // 3 only once so prev/next navigation does not stall on the seam.
    const entries = [
      makeEntry('a', 1, 3),
      makeEntry('b', 3, 5),
    ]
    expect(buildBoundarySet(entries, [])).toEqual([1, 3, 5])
  })

  it('returns empty array when no non-deleted entries exist', () => {
    expect(buildBoundarySet([], [])).toEqual([])
    const deletedOnly = [makeEntry('a', 1, 2, { isDeleted: true })]
    expect(buildBoundarySet(deletedOnly, [])).toEqual([])
  })

  it('skips deleted entries', () => {
    const entries = [
      makeEntry('a', 1, 2),
      makeEntry('b', 3, 4, { isDeleted: true }),
      makeEntry('c', 5, 6),
    ]
    expect(buildBoundarySet(entries, [])).toEqual([1, 2, 5, 6])
  })

  it('sorts ascending even when entries come in arbitrary order', () => {
    const entries = [
      makeEntry('a', 10, 12),
      makeEntry('b', 1, 3),
      makeEntry('c', 5, 7),
    ]
    expect(buildBoundarySet(entries, [])).toEqual([1, 3, 5, 7, 10, 12])
  })

  it('translates boundaries through cuts (Edited axis)', () => {
    // Entry [5, 20] with cut c0=[3, 7] (head) + c1=[12, 14] (middle):
    //   origToEdited(5)  = 5 (inside c0 → snaps to 3)... wait, 5 is inside c0.
    //   origToEdited(5)  = c0.startSec - removed = 3 - 0 = 3
    //   origToEdited(20) = 20 - (4 + 2)         = 14
    const entries = [makeEntry('a', 5, 20)]
    const cuts: Cut[] = [cut(3, 7), cut(12, 14)]
    expect(buildBoundarySet(entries, cuts)).toEqual([3, 14])
  })
})

// ---------------------------------------------------------------------------
// findPrevBoundary / findNextBoundary
// ---------------------------------------------------------------------------

describe('findPrevBoundary', () => {
  const boundaries = [1, 3, 5, 8]

  it('returns null when t is at or before the first boundary', () => {
    expect(findPrevBoundary(1, boundaries)).toBeNull()
    expect(findPrevBoundary(0, boundaries)).toBeNull()
  })

  it('returns the largest boundary strictly less than t', () => {
    expect(findPrevBoundary(4, boundaries)).toBe(3)
    expect(findPrevBoundary(5.0001, boundaries)).toBe(5)
  })

  it('strict comparison: t exactly on a boundary returns the boundary before it', () => {
    expect(findPrevBoundary(5, boundaries)).toBe(3)
    expect(findPrevBoundary(8, boundaries)).toBe(5)
  })

  it('returns the last boundary when t is past every boundary', () => {
    expect(findPrevBoundary(100, boundaries)).toBe(8)
  })

  it('returns null for empty boundary list', () => {
    expect(findPrevBoundary(5, [])).toBeNull()
  })
})

describe('findNextBoundary', () => {
  const boundaries = [1, 3, 5, 8]

  it('returns null when t is at or after the last boundary', () => {
    expect(findNextBoundary(8, boundaries)).toBeNull()
    expect(findNextBoundary(100, boundaries)).toBeNull()
  })

  it('returns the smallest boundary strictly greater than t', () => {
    expect(findNextBoundary(4, boundaries)).toBe(5)
    expect(findNextBoundary(0, boundaries)).toBe(1)
  })

  it('strict comparison: t exactly on a boundary returns the boundary after it', () => {
    expect(findNextBoundary(1, boundaries)).toBe(3)
    expect(findNextBoundary(5, boundaries)).toBe(8)
  })

  it('returns null for empty boundary list', () => {
    expect(findNextBoundary(5, [])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Integration — boundaries dedupe + nav round-trip
// ---------------------------------------------------------------------------

describe('boundary navigation integration', () => {
  it('back-to-back blocks (a.end === b.start) jump in a single step', () => {
    const entries = [
      makeEntry('a', 1, 3),
      makeEntry('b', 3, 5),
    ]
    const b = buildBoundarySet(entries, [])
    expect(b).toEqual([1, 3, 5])
    // From playhead at 2 — pressing "next" once goes to 3, not "3 again 3".
    expect(findNextBoundary(2, b)).toBe(3)
    expect(findNextBoundary(3, b)).toBe(5)
    // From playhead at 4 — "prev" once goes to 3, not "5 then 3".
    expect(findPrevBoundary(4, b)).toBe(3)
    expect(findPrevBoundary(3, b)).toBe(1)
  })
})
