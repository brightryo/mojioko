import { describe, expect, it } from 'vitest'
import { layoutEntries, LAYOUT_MIN_BLOCK_SEC } from '../../src/renderer/lib/timeline-layout'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-057 regression: Whisper segments often share boundaries exactly
 * (`A.endSec === B.startSec`).  The greedy track allocator must treat that
 * as contiguous (single track), not as overlap.
 */

function entry(id: string, startSec: number, endSec: number): SubtitleEntry {
  const layoutDefaults = makeEntryLayoutDefaults()
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
    ...layoutDefaults,
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
      fadeEnabled: false,
      ...makeEntryLayoutDefaults()
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

/**
 * REQ-088 #2: Whisper occasionally emits 0.02-s segments.  Each block
 * renders with a CSS min-width of 2 px so it remains clickable; if the
 * layout assigns the following block to the same track without
 * reserving track-time for that visual minimum, the two blocks' rendered
 * boxes overlap by 1–2 px and the user sees "duplicated blocks on one
 * row" even though the underlying SubtitleEntry times do not overlap.
 *
 * The `minBlockSec` parameter — defaulted to LAYOUT_MIN_BLOCK_SEC = 0.05
 * by the timeline-view call site — fixes this by treating each block as
 * occupying at least 0.05 s of track-time (effective_end = max(endSec,
 * startSec + 0.05)).  Adjacent blocks then fall onto a fresh track.
 */
describe('layoutEntries — minBlockSec (REQ-088 #2)', () => {
  it('LAYOUT_MIN_BLOCK_SEC is the value the renderer relies on', () => {
    expect(LAYOUT_MIN_BLOCK_SEC).toBe(0.05)
  })

  it('legacy default (minBlockSec = 0) lets adjacent 0.02-s blocks share a track', () => {
    // Whisper-style degenerate output: two back-to-back 0.02-s segments.
    // Without minBlockSec, the greedy treats them as touching and reuses
    // track 0 — this is what produced the visual overlap before REQ-088 #2.
    const result = layoutEntries(
      [entry('a', 123.53, 123.55), entry('b', 123.55, 123.57)],
      200,
    )
    expect(result.trackCount).toBe(1)
  })

  it('with minBlockSec = 0.05 adjacent 0.02-s blocks split across two tracks', () => {
    // Same degenerate input, the production path through timeline-view:
    // adjacent 0.02-s blocks land on separate tracks so the rendered
    // min-width has clearance to the right edge of the previous block.
    const result = layoutEntries(
      [entry('a', 123.53, 123.55), entry('b', 123.55, 123.57)],
      200,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(2)
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(trackOf.get('a')).not.toBe(trackOf.get('b'))
  })

  it('two 0.02-s blocks far apart still share a track', () => {
    // The minBlockSec rule only kicks in for blocks that fall within
    // the reserved window — well-separated short blocks do NOT split.
    const result = layoutEntries(
      [entry('a', 1.00, 1.02), entry('b', 5.00, 5.02)],
      10,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(1)
  })

  it('normal-length back-to-back blocks (REQ-057) still share a track', () => {
    // Regression guard: the existing REQ-057 invariant (Whisper contiguous
    // multi-second segments share a track) must NOT be broken by the new
    // reservation logic.  A 1-s block's effective_end == its actual end,
    // so adjacent 1-s blocks behave identically to the legacy path.
    const result = layoutEntries(
      [entry('a', 0, 1), entry('b', 1, 2), entry('c', 2, 3)],
      10,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(1)
    expect(result.placements.map((p) => p.trackIndex)).toEqual([0, 0, 0])
  })

  it('genuine overlap on normal-length blocks (REQ-057) still splits tracks', () => {
    const result = layoutEntries(
      [entry('a', 0, 1.5), entry('b', 1.0, 2.5)],
      10,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(2)
  })

  it('same-startSec different-id (REQ-079) still splits tracks', () => {
    const result = layoutEntries(
      [entry('existing', 5, 10), entry('added', 5, 10)],
      10,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(2)
  })

  it('long block then short block touching its end shares a track', () => {
    // The long block's effective_end == actualEnd (already past
    // startSec + 0.05); the next short block can sit on the same track
    // when it starts at the long block's actualEnd.
    const result = layoutEntries(
      [entry('long', 0, 5), entry('short', 5, 5.02)],
      10,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(1)
  })

  it('short block then another short block within the reserved window splits tracks', () => {
    // 0.02-s block at [10.00, 10.02]; another 0.02-s block at
    // [10.03, 10.05] would render with min-width and overlap the
    // first block visually.  The 0.05-s reservation pushes the second
    // onto a new track.
    const result = layoutEntries(
      [entry('a', 10.00, 10.02), entry('b', 10.03, 10.05)],
      20,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(2)
  })
})

/**
 * REQ-20260613-002: dragging a clip in the timeline mutates `entry.startSec`
 * on every pointermove tick.  Without the `greedyTimes` override, the sort
 * key flips as soon as the dragged entry's live time crosses a neighbour's
 * — the greedy reassigns tracks and the visual rows swap, even though React
 * keeps each Block bound to its own id.  The user perceives "the wrong
 * clip moved."
 *
 * The override locks the dragged entry's greedy slot to its snapshot (pre-
 * drag) times so its trackIndex is stable for the entire drag.  These
 * tests exercise the same code path the production drag handler invokes.
 */
describe('layoutEntries — greedyTimes override (REQ-20260613-002)', () => {
  it('without override, same-time clips swap tracks when one moves earlier', () => {
    // Pre-drag: a (id "a") and b (id "b") share startSec.  Id tie-break
    // puts a on track 0, b on track 1.
    const before = layoutEntries([entry('a', 10, 15), entry('b', 10, 15)], 20)
    const beforeTracks = new Map(before.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(beforeTracks.get('a')).toBe(0)
    expect(beforeTracks.get('b')).toBe(1)

    // Mid-drag (b moved left 0.1s): no override → greedy now sorts b
    // first and assigns it track 0.  This IS the reported bug.
    const during = layoutEntries([entry('a', 10, 15), entry('b', 9.9, 14.9)], 20)
    const duringTracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(duringTracks.get('b')).toBe(0)
    expect(duringTracks.get('a')).toBe(1)
  })

  it('with override (snapshot times for the dragged entry) tracks stay pinned', () => {
    const before = layoutEntries([entry('a', 10, 15), entry('b', 10, 15)], 20)
    const beforeTracks = new Map(before.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(beforeTracks.get('a')).toBe(0)
    expect(beforeTracks.get('b')).toBe(1)

    // Mid-drag (b moved left 0.1s) WITH the production override —
    // greedyTimes pins b's sort key to its pre-drag startSec.
    const during = layoutEntries(
      [entry('a', 10, 15), entry('b', 9.9, 14.9)],
      20,
      0,
      { greedyTimes: new Map([['b', { startSec: 10, endSec: 15 }]]) },
    )
    const duringTracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(duringTracks.get('a')).toBe(0)
    expect(duringTracks.get('b')).toBe(1)
  })

  it('override keeps b pinned even when it drags far right past a', () => {
    // b dragged so far right that its live interval no longer overlaps a.
    // Without override, b would merge down to track 0.  With override, b
    // stays on track 1 (= the row the user grabbed) for the whole drag.
    const during = layoutEntries(
      [entry('a', 10, 15), entry('b', 20, 25)],
      30,
      0,
      { greedyTimes: new Map([['b', { startSec: 10, endSec: 15 }]]) },
    )
    const tracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(tracks.get('a')).toBe(0)
    expect(tracks.get('b')).toBe(1)
  })

  it('override on a does not affect b when only b is dragging', () => {
    // Smoke check: the override only acts on the entry whose id is in the
    // map.  An override for 'a' does not silently freeze 'b' too.
    const result = layoutEntries(
      [entry('a', 10, 15), entry('b', 11, 16)],
      20,
      0,
      { greedyTimes: new Map([['a', { startSec: 10, endSec: 15 }]]) },
    )
    // a and b overlap → two tracks; a (sorts first by override) → 0, b → 1.
    const tracks = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(tracks.get('a')).toBe(0)
    expect(tracks.get('b')).toBe(1)
  })

  it('empty override map → identical behaviour to no override', () => {
    const withEmpty = layoutEntries(
      [entry('a', 10, 15), entry('b', 11, 16)],
      20,
      0,
      { greedyTimes: new Map() },
    )
    const without = layoutEntries(
      [entry('a', 10, 15), entry('b', 11, 16)],
      20,
    )
    expect(withEmpty.placements.map((p) => [p.entry.id, p.trackIndex])).toEqual(
      without.placements.map((p) => [p.entry.id, p.trackIndex]),
    )
    expect(withEmpty.trackCount).toBe(without.trackCount)
  })

  it('three same-time clips: pinning the bottom one keeps the other two stable', () => {
    // Repro for the "three duplicates" stress case (REQ §5 #4).  c on
    // track 2.  User drags c left.  Without pin, c would crowd onto a
    // lower track and reshuffle a / b.  With pin, c stays on track 2.
    const during = layoutEntries(
      [entry('a', 10, 15), entry('b', 10, 15), entry('c', 9, 14)],
      20,
      0,
      { greedyTimes: new Map([['c', { startSec: 10, endSec: 15 }]]) },
    )
    const tracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(tracks.get('a')).toBe(0)
    expect(tracks.get('b')).toBe(1)
    expect(tracks.get('c')).toBe(2)
  })
})
