import { describe, it, expect } from 'vitest'
import { findActiveEntryId, findActiveEntryIds } from '../../src/renderer/lib/active-entry'
import type { SubtitleEntry } from '../../src/shared/types'

function entry(id: string, startSec: number, endSec: number): SubtitleEntry {
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
