import { describe, it, expect } from 'vitest'
import { findActiveEntryId } from '../../src/renderer/lib/active-entry'
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
