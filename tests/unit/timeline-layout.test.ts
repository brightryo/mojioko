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

  /**
   * REQ-079 #2: adding a new row at the EXACT same time as an existing
   * one (e.g. "Add row" while a row is focused — its times seed the
   * dialog) must land on a separate track, NOT pile up on the existing
   * one.  The previous layout greedy treated `same start, same end` as
   * "fits" and assigned the second entry to track 0.
   */
  it('places two entries with identical start AND end on separate tracks', () => {
    const result = layoutEntries(
      [entry('existing', 5, 10), entry('added', 5, 10)],
      10,
    )
    expect(result.trackCount).toBe(2)
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    // The two entries land on different tracks; the exact assignment
    // (which gets track 0) depends on id ordering, but they MUST be
    // different.
    expect(trackOf.get('existing')).not.toBe(trackOf.get('added'))
  })

  it('places identical-time entries from "new-" id prefix on a new track', () => {
    // Reproduces the user-reported flow: an existing "e-001" row + an
    // "Add row" copy carrying the default `new-${Date.now()}` id.
    const result = layoutEntries(
      [entry('e-001', 5, 10), entry('new-1700000000000', 5, 10)],
      10,
    )
    expect(result.trackCount).toBe(2)
  })

  it('three same-time entries spread across three tracks', () => {
    const result = layoutEntries(
      [entry('a', 5, 10), entry('b', 5, 10), entry('c', 5, 10)],
      10,
    )
    expect(result.trackCount).toBe(3)
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    const tracks = [trackOf.get('a'), trackOf.get('b'), trackOf.get('c')]
    expect(new Set(tracks).size).toBe(3)  // all three distinct
  })

  it('same start but different end → still separate tracks', () => {
    // Common when an Add Row copies the focused row's startSec but the
    // user shortens its endSec before confirming.
    const result = layoutEntries(
      [entry('existing', 5, 10), entry('shorter', 5, 8)],
      10,
    )
    expect(result.trackCount).toBe(2)
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(trackOf.get('existing')).not.toBe(trackOf.get('shorter'))
  })

  it('partial overlap (later block starts inside the previous) → separate tracks', () => {
    const result = layoutEntries(
      [entry('a', 5, 10), entry('b', 7, 12)],
      15,
    )
    expect(result.trackCount).toBe(2)
  })

  /**
   * REQ-079 #2 root-cause guard.  When two entries collide on the same
   * `id` (e.g. two `new-${Date.now()}` rows added within one millisecond
   * before the fix), `trackOf` keeps only the LAST assignment and both
   * placements read the same trackIndex — every block stacks at one
   * vertical position.  Once Add Row hands out collision-resistant ids
   * (step2.tsx via crypto.randomUUID) the bug cannot arise; this test
   * locks the correct behaviour for any future id source.
   */
  it('distinct ids on same-time entries yield distinct placements', () => {
    const result = layoutEntries(
      [entry('id-a', 5, 10), entry('id-b', 5, 10)],
      10,
    )
    const tracks = result.placements.map((p) => p.trackIndex)
    expect(new Set(tracks).size).toBe(2)
  })
})
