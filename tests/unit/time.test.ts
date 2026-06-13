import { describe, it, expect } from 'vitest'
import {
  formatTimecode,
  formatEditedTimecode,
  editedDurationOfEntry,
} from '../../src/renderer/lib/time'
import { sanitizeCuts, type Cut } from '../../src/shared/cuts'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

function makeEntry(
  startSec: number,
  endSec: number,
  id = `e-${startSec}-${endSec}`,
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
    ...makeEntryLayoutDefaults(),
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
// REQ-115 — formatEditedTimecode: Original time + cuts → Edited-axis HH:MM:SS.cc
// ---------------------------------------------------------------------------

describe('REQ-115: formatEditedTimecode', () => {
  it('cuts=[]  →  bit-identical to formatTimecode (origToEdited is identity)', () => {
    // The bit-identical lock the REQ called out: when no cuts exist,
    // every UI surface keeps its pre-REQ-115 behaviour.
    expect(formatEditedTimecode(0, [])).toBe(formatTimecode(0))
    expect(formatEditedTimecode(13.07, [])).toBe(formatTimecode(13.07))
    expect(formatEditedTimecode(3600 + 42.99, [])).toBe(formatTimecode(3600 + 42.99))
  })

  it('Original time AFTER a cut subtracts the cut duration on the Edited axis', () => {
    // The owner's reported mismatch: cut [4, 8] → Original 13.07 displays
    // as Edited 9.07.  This pins the fix at the timecode-string layer.
    const cuts: Cut[] = sanitizeCuts([cut(4, 8)])
    expect(formatEditedTimecode(13.07, cuts)).toBe('00:00:09.07')
  })

  it('Original time INSIDE a cut snaps to the cut-collapse Edited point', () => {
    // Per cuts.ts:139-148 contract, an Original time strictly inside a
    // cut returns `cut.startSec - removed` (= the collapse point).
    const cuts: Cut[] = sanitizeCuts([cut(4, 8)])
    expect(formatEditedTimecode(6, cuts)).toBe('00:00:04.00')
  })

  it('Original time BEFORE any cut is unchanged on the Edited axis', () => {
    const cuts: Cut[] = sanitizeCuts([cut(10, 20)])
    expect(formatEditedTimecode(5, cuts)).toBe('00:00:05.00')
    expect(formatEditedTimecode(0, cuts)).toBe('00:00:00.00')
  })

  it('multiple disjoint cuts subtract cumulative removed duration', () => {
    // cuts [3, 7] + [12, 14]: removed at t=20 = 4 + 2 = 6.  Edited 14.00.
    const cuts: Cut[] = sanitizeCuts([cut(3, 7), cut(12, 14)])
    expect(formatEditedTimecode(20, cuts)).toBe('00:00:14.00')
  })

  it('overlapping cuts use the union (Phase 1 contract)', () => {
    // cuts [8, 28] + nested [10, 26] union to [8, 28].  Edited 35 = 35-20=15.
    const cuts: Cut[] = sanitizeCuts([cut(8, 28), cut(10, 26)])
    expect(formatEditedTimecode(35, cuts)).toBe('00:00:15.00')
  })
})

// ---------------------------------------------------------------------------
// REQ-115 — editedDurationOfEntry: visible-on-Edited-axis duration of an entry
// ---------------------------------------------------------------------------

describe('REQ-115: editedDurationOfEntry', () => {
  it('cuts=[]  →  exactly endSec - startSec (bit-identical to legacy duration)', () => {
    expect(editedDurationOfEntry(makeEntry(5, 30), [])).toBe(25)
    expect(editedDurationOfEntry(makeEntry(0, 1.5), [])).toBe(1.5)
  })

  it('entry outside any cut → duration unchanged', () => {
    const cuts: Cut[] = sanitizeCuts([cut(100, 110)])
    expect(editedDurationOfEntry(makeEntry(5, 30), cuts)).toBe(25)
  })

  it('entry with a middle cut (REQ-104 shape) → duration shrinks by cut length', () => {
    // Entry [5, 30], cut [12, 14] (middle).  Edited duration = 25 - 2 = 23.
    const cuts: Cut[] = sanitizeCuts([cut(12, 14)])
    expect(editedDurationOfEntry(makeEntry(5, 30), cuts)).toBe(23)
  })

  it('entry head-clamped by a cut → Edited duration is the surviving tail', () => {
    // Entry [10, 20], cut [5, 15] (head clamp): origToEdited(10)=5,
    // origToEdited(20)=15-removed(10)=10.  Edited duration = 5.
    const cuts: Cut[] = sanitizeCuts([cut(5, 15)])
    expect(editedDurationOfEntry(makeEntry(10, 20), cuts)).toBe(5)
  })

  it('entry tail-clamped by a cut → Edited duration is the surviving head', () => {
    // Entry [10, 20], cut [15, 25] (tail clamp): origToEdited(10)=10,
    // origToEdited(20)=15 (collapse point).  Edited duration = 5.
    const cuts: Cut[] = sanitizeCuts([cut(15, 25)])
    expect(editedDurationOfEntry(makeEntry(10, 20), cuts)).toBe(5)
  })

  it('entry fully consumed by a cut → Edited duration = 0', () => {
    const cuts: Cut[] = sanitizeCuts([cut(10, 25)])
    expect(editedDurationOfEntry(makeEntry(15, 20), cuts)).toBe(0)
  })

  it('nested middle cuts (Phase 3) → Edited duration uses the union', () => {
    // Entry [5, 30], cuts [8, 28] + nested [10, 26]: union [8, 28].
    // Edited duration = origToEdited(30) - origToEdited(5)
    //                 = (30 - 20) - 5 = 5.
    const cuts: Cut[] = sanitizeCuts([cut(8, 28), cut(10, 26)])
    expect(editedDurationOfEntry(makeEntry(5, 30), cuts)).toBe(5)
  })

  it('degenerate entry (startSec > endSec) → returns 0, not negative', () => {
    expect(editedDurationOfEntry(makeEntry(20, 10), [])).toBe(0)
  })
})
