import { describe, expect, it } from 'vitest'
import { isEditedFromOriginal, roundToCs } from '../../src/renderer/lib/entry-edits'
import type { SubtitleEntry, SubtitleEntryOriginal } from '../../src/shared/types'

/**
 * REQ-059 — `isEdited` is computed from `entry` vs `entry.original` so a
 * round-trip edit (drag away + back, type-revert, bulk-revert) correctly
 * clears the "edited" amber state.  Time fields compare at centisecond
 * display precision; other fields use strict equality.
 */

function baseOriginal(): SubtitleEntryOriginal {
  return {
    startSec: 13.07,
    endSec: 15.50,
    text: 'hello',
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeEnabled: false,
    fontId: undefined
  }
}

function entry(overrides: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const original = baseOriginal()
  return {
    id: 'e1',
    ...original,
    isDeleted: false,
    isEdited: false,
    original,
    ...overrides
  }
}

describe('roundToCs', () => {
  it('rounds floats to centisecond precision', () => {
    expect(roundToCs(13.0700001)).toBe(13.07)
    expect(roundToCs(13.0749)).toBe(13.07)
    expect(roundToCs(13.0750001)).toBe(13.08)
    expect(roundToCs(0)).toBe(0)
  })
})

describe('isEditedFromOriginal — time fields', () => {
  it('returns false when values exactly match original', () => {
    expect(isEditedFromOriginal(entry())).toBe(false)
  })

  it('returns false when startSec differs by drift below half a centisecond', () => {
    // 13.0700001 vs 13.07 — both round to cs 1307.
    expect(isEditedFromOriginal(entry({ startSec: 13.0700001 }))).toBe(false)
  })

  it('returns true when startSec moves to a different centisecond bucket', () => {
    // 13.08 vs 13.07 — cs 1308 vs 1307.
    expect(isEditedFromOriginal(entry({ startSec: 13.08 }))).toBe(true)
  })

  it('treats endSec the same way', () => {
    expect(isEditedFromOriginal(entry({ endSec: 15.5000001 }))).toBe(false)
    expect(isEditedFromOriginal(entry({ endSec: 15.51 }))).toBe(true)
  })

  it('returns false when a Whisper-imported sub-cs original matches a cs-aligned edit at the same display', () => {
    // Whisper imports raw float — e.g. 13.0723.  The user drags back to the
    // displayed "13.07" (cs-aligned by roundToCs).  Both render as 13.07cs.
    const o: SubtitleEntryOriginal = { ...baseOriginal(), startSec: 13.0723 }
    const e: SubtitleEntry = {
      id: 'w',
      ...o,
      startSec: 13.07,
      isDeleted: false,
      isEdited: false,
      original: o
    }
    expect(isEditedFromOriginal(e)).toBe(false)
  })
})

describe('isEditedFromOriginal — non-time fields use strict equality', () => {
  it('text', () => {
    expect(isEditedFromOriginal(entry({ text: 'hello' }))).toBe(false)
    expect(isEditedFromOriginal(entry({ text: 'hello!' }))).toBe(true)
  })

  it('fontSizePx', () => {
    expect(isEditedFromOriginal(entry({ fontSizePx: 64 }))).toBe(false)
    expect(isEditedFromOriginal(entry({ fontSizePx: 65 }))).toBe(true)
  })

  it('textColorHex / outlineColorHex / outlineThicknessPx', () => {
    expect(isEditedFromOriginal(entry({ textColorHex: '#ff0000' }))).toBe(true)
    expect(isEditedFromOriginal(entry({ outlineColorHex: '#ff0000' }))).toBe(true)
    expect(isEditedFromOriginal(entry({ outlineThicknessPx: 3 }))).toBe(true)
  })

  it('fadeEnabled', () => {
    expect(isEditedFromOriginal(entry({ fadeEnabled: true }))).toBe(true)
  })

  it('fontId — undefined ↔ undefined is unchanged, undefined → defined is an edit', () => {
    expect(isEditedFromOriginal(entry({ fontId: undefined }))).toBe(false)
    expect(isEditedFromOriginal(entry({ fontId: 'noto-sans-jp-semibold' }))).toBe(true)
  })
})

describe('isEditedFromOriginal — round-trip behaviour', () => {
  it('text edited then reverted clears isEdited', () => {
    const e = entry({ text: 'something else' })
    expect(isEditedFromOriginal(e)).toBe(true)
    const reverted = { ...e, text: 'hello' }
    expect(isEditedFromOriginal(reverted)).toBe(false)
  })

  it('drag-style time edit then snap back to the displayed value clears isEdited', () => {
    // Original 13.07s.  Simulated drag away then back-to-display.
    const after = entry({ startSec: 14.123456 })
    expect(isEditedFromOriginal(after)).toBe(true)
    const snappedBack = { ...after, startSec: roundToCs(13.0700001) }
    expect(isEditedFromOriginal(snappedBack)).toBe(false)
  })

  it('two fields edited, one reverted — still edited', () => {
    const e = entry({ text: 'X', fontSizePx: 80 })
    expect(isEditedFromOriginal(e)).toBe(true)
    const partial = { ...e, text: 'hello' }
    expect(isEditedFromOriginal(partial)).toBe(true)
  })
})
