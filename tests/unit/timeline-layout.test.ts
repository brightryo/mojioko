import { describe, expect, it } from 'vitest'
import { layoutEntries } from '../../src/renderer/lib/timeline-layout'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-057 regression: Whisper segments often share boundaries exactly
 * (`A.endSec === B.startSec`).  The greedy track allocator must treat that
 * as contiguous (single track), not as overlap.
 */

function entry(id: string, startSec: number, endSec: number): SubtitleEntry {
  return {
    id,
    startSec,
    endSec,
    text: id,
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeEnabled: false,
    isDeleted: false,
    isEdited: false,
    original: {
      startSec,
      endSec,
      text: id,
      fontSizePx: 64,
      textColorHex: '#ffffff',
      outlineColorHex: '#000000',
      outlineThicknessPx: 2,
      fadeEnabled: false
    }
  }
}

describe('layoutEntries — contact vs overlap', () => {
  it('places three Whisper-style contiguous entries on one track', () => {
    // A 0–1, B 1–2, C 2–3 — boundaries touch exactly.
    const result = layoutEntries(
      [entry('a', 0, 1), entry('b', 1, 2), entry('c', 2, 3)],
      10
    )
    expect(result.trackCount).toBe(1)
    expect(result.placements.map((p) => p.trackIndex)).toEqual([0, 0, 0])
  })

  it('still puts genuinely overlapping entries on separate tracks', () => {
    // A 0–1.5, B 1.0–2.5 — 0.5s of real overlap.
    const result = layoutEntries([entry('a', 0, 1.5), entry('b', 1.0, 2.5)], 10)
    expect(result.trackCount).toBe(2)
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(trackOf.get('a')).toBe(0)
    expect(trackOf.get('b')).toBe(1)
  })

  it('tolerates sub-millisecond float drift as contact (single track)', () => {
    // 1ns of "overlap" caused by float math is below TIME_EPS_SEC.
    const result = layoutEntries(
      [entry('a', 0, 1.0000000001), entry('b', 1, 2)],
      10
    )
    expect(result.trackCount).toBe(1)
  })

  it('treats overlap larger than the float-tolerance epsilon as real overlap', () => {
    // 10 ms of overlap — well above TIME_EPS_SEC (1 ms).
    const result = layoutEntries([entry('a', 0, 1.01), entry('b', 1.0, 2)], 10)
    expect(result.trackCount).toBe(2)
  })
})
