import { describe, it, expect } from 'vitest'
import { maxCueNumber, nextCueNumber, assignCueNumbers } from '../../src/shared/cue-number'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0400 — stable per-cue display numbers ("字幕ID").  These pin the pure
 * numbering the store applies in setEntries / addEntry.
 */
function e(id: string, cueNumber?: number): SubtitleEntry {
  const base = {
    startSec: 0,
    endSec: 1,
    text: id,
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    ...makeEntryLayoutDefaults(),
  }
  return {
    id,
    ...base,
    ...(cueNumber !== undefined ? { cueNumber } : {}),
    isDeleted: false,
    isEdited: false,
    original: { ...base },
  } as SubtitleEntry
}

describe('maxCueNumber / nextCueNumber', () => {
  it('empty / all-unnumbered → max 0, next 1', () => {
    expect(maxCueNumber([])).toBe(0)
    expect(maxCueNumber([e('a'), e('b')])).toBe(0)
    expect(nextCueNumber([])).toBe(1)
  })

  it('reports the largest present number and one past it', () => {
    expect(maxCueNumber([e('a', 2), e('b', 5), e('c', 3)])).toBe(5)
    expect(nextCueNumber([e('a', 2), e('b', 5)])).toBe(6)
  })
})

describe('assignCueNumbers', () => {
  it('numbers a fresh (all-unnumbered) batch 1,2,3… in array order', () => {
    const out = assignCueNumbers([e('a'), e('b'), e('c')])
    expect(out.map((x) => x.cueNumber)).toEqual([1, 2, 3])
  })

  it('back-fills only the missing ones, counting past the current max', () => {
    // 'b' already 5 → the unnumbered 'a' and 'c' get 6 and 7 (not 1/2), so a
    // legacy entry can never collide with an already-numbered peer.
    const out = assignCueNumbers([e('a'), e('b', 5), e('c')])
    expect(out.map((x) => x.cueNumber)).toEqual([6, 5, 7])
  })

  it('is stable under reordering — the number rides the entry, not its index', () => {
    const numbered = assignCueNumbers([e('a'), e('b'), e('c')]) // a=1 b=2 c=3
    const reversed = [...numbered].reverse()
    const again = assignCueNumbers(reversed)
    // No re-assignment: c stays 3, b stays 2, a stays 1 despite being last now.
    expect(again.map((x) => [x.id, x.cueNumber])).toEqual([
      ['c', 3],
      ['b', 2],
      ['a', 1],
    ])
  })

  it('a soft-deleted numbered cue still counts toward the max (no reuse)', () => {
    const deleted = { ...e('gone', 3), isDeleted: true }
    const out = assignCueNumbers([deleted, e('new')])
    expect(out[1].cueNumber).toBe(4) // 3 is taken by the deleted cue
  })

  it('returns the same array reference when everything is already numbered', () => {
    const input = [e('a', 1), e('b', 2)]
    expect(assignCueNumbers(input)).toBe(input)
  })

  it('preserves object identity for already-numbered entries; clones only new ones', () => {
    const a = e('a', 1)
    const b = e('b') // unnumbered
    const out = assignCueNumbers([a, b])
    expect(out[0]).toBe(a) // untouched
    expect(out[1]).not.toBe(b) // cloned with a number
    expect(out[1].cueNumber).toBe(2)
  })
})
