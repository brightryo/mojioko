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
    fadeDurationSec: 0,
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
      fadeDurationSec: 0,
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

  it('still puts genuinely overlapping entries on separate tracks (REQ-0394: later = front = top)', () => {
    // A 0–1.5, B 1.0–2.5 — 0.5s of real overlap.  REQ-0394: rows are z-order.
    // Both are layer-0 intent; the later cue B gets the higher effective layer
    // (front) → the TOP row (trackIndex 0); A sits below it.
    const result = layoutEntries([entry('a', 0, 1.5), entry('b', 1.0, 2.5)], 10)
    expect(result.trackCount).toBe(2)
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(trackOf.get('b')).toBe(0) // overlapping later cue → front → top row
    expect(trackOf.get('a')).toBe(1) // earlier cue → back → bottom row
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

  /**
   * REQ-20260615-031: when the entries-array order is
   * [original, duplicate] for two same-startSec rows, the original must
   * keep track 0 and the duplicate must spill onto track 1.  Before this
   * REQ the tiebreaker was alphabetical on id, and `dup-<UUID>` often
   * sorted before the original id, so the duplicate would grab track 0
   * and the original would get pushed to track 1 (a visual row swap with
   * no underlying data change).
   *
   * The two cases below cover both id-ordering directions so the test
   * catches a regression to ANY id-based tiebreaker, not only
   * alphabetical.
   */
  it('duplicate inserted after original lands on the FRONT (top) row (REQ-031 / REQ-0394)', () => {
    // Same-time original + duplicate overlap → distinct effective layers by
    // input order.  REQ-0394: the later-in-array duplicate gets the higher
    // (front) layer → the TOP row (trackIndex 0); the original sits below it.
    // (This is "複製は前面" — consistent with the burn's emission-order z-order.)
    // The id-alphabetical tiebreaker REQ-031 removed must NOT resurface: 'dup-x'
    // must not sort ahead of 'e-001' and steal the ordering.
    const result = layoutEntries(
      [entry('e-001', 5, 10), entry('dup-x', 5, 10)],
      10,
    )
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(trackOf.get('dup-x')).toBe(0) // duplicate → front → top row
    expect(trackOf.get('e-001')).toBe(1) // original → back → bottom row
  })

  it('insertion order wins regardless of id alphabetical order (REQ-031 / REQ-0394)', () => {
    // 'a' < 'z', but if 'z' is inserted FIRST the array order must win: the
    // later-inserted 'a-second' gets the front (top) row, not the alphabetical one.
    const result = layoutEntries(
      [entry('z-first', 5, 10), entry('a-second', 5, 10)],
      10,
    )
    const trackOf = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(trackOf.get('a-second')).toBe(0) // later-inserted → front → top
    expect(trackOf.get('z-first')).toBe(1)
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

  it('REQ-0394: minBlockSec no longer splits non-overlapping short blocks (rows are z-order)', () => {
    // a[123.53,123.55] and b[123.55,123.57] are contact (not a real time
    // overlap), so under the z-order row model they share layer 0 = one row.
    // minBlockSec is ignored for row assignment now (rows mean z-order, not a
    // visual time-packing); it is kept only for call-site compatibility.  The
    // minor cost: two very-short near-adjacent blocks can render touching on one
    // row — accepted so timeline rows == burn Layer == preview z-index.
    const result = layoutEntries(
      [entry('a', 123.53, 123.55), entry('b', 123.55, 123.57)],
      200,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(1)
    expect(result.placements.map((p) => p.trackIndex)).toEqual([0, 0])
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

  it('REQ-0394: near-adjacent short blocks with a gap share a row (minBlockSec ignored for rows)', () => {
    // a[10.00,10.02] and b[10.03,10.05] have a real gap → no time overlap →
    // same effective layer → one row.  (Pre-REQ-0394 minBlockSec split them; now
    // rows are z-order so only genuine time overlap separates rows.)
    const result = layoutEntries(
      [entry('a', 10.00, 10.02), entry('b', 10.03, 10.05)],
      20,
      LAYOUT_MIN_BLOCK_SEC,
    )
    expect(result.trackCount).toBe(1)
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
  it('without override, same-time clips swap rows when one moves earlier', () => {
    // Pre-drag: a and b share startSec (input order a,b) → b is the later cue →
    // front → top row (0); a below it (1).
    const before = layoutEntries([entry('a', 10, 15), entry('b', 10, 15)], 20)
    const beforeTracks = new Map(before.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(beforeTracks.get('a')).toBe(1)
    expect(beforeTracks.get('b')).toBe(0)

    // Mid-drag (b moved left 0.1s): no override → b now sorts first (earlier
    // start) so a becomes the higher effective layer → top row.  The rows swap
    // (a: 1→0, b: 0→1).  This IS the reported bug the override below fixes.
    const during = layoutEntries([entry('a', 10, 15), entry('b', 9.9, 14.9)], 20)
    const duringTracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(duringTracks.get('a')).toBe(0)
    expect(duringTracks.get('b')).toBe(1)
  })

  it('with override (snapshot times for the dragged entry) tracks stay pinned', () => {
    const before = layoutEntries([entry('a', 10, 15), entry('b', 10, 15)], 20)
    const beforeTracks = new Map(before.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(beforeTracks.get('a')).toBe(1)
    expect(beforeTracks.get('b')).toBe(0)

    // Mid-drag (b moved left 0.1s) WITH the production override — greedyTimes
    // pins b's overlap/effective-layer to its pre-drag snapshot, so the rows
    // stay exactly as before the drag (a below, b on top).
    const during = layoutEntries(
      [entry('a', 10, 15), entry('b', 9.9, 14.9)],
      20,
      0,
      { greedyTimes: new Map([['b', { startSec: 10, endSec: 15 }]]) },
    )
    const duringTracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(duringTracks.get('a')).toBe(1)
    expect(duringTracks.get('b')).toBe(0)
  })

  it('override keeps b pinned even when it drags far right past a', () => {
    // b dragged so far right that its live interval no longer overlaps a.  With
    // the override, b's overlap is still computed from its pre-drag snapshot
    // (10-15, overlapping a), so b keeps the front (top) row it was grabbed on.
    const during = layoutEntries(
      [entry('a', 10, 15), entry('b', 20, 25)],
      30,
      0,
      { greedyTimes: new Map([['b', { startSec: 10, endSec: 15 }]]) },
    )
    const tracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(tracks.get('a')).toBe(1)
    expect(tracks.get('b')).toBe(0)
  })

  it('override on a does not affect b when only b is dragging', () => {
    // Smoke check: the override only acts on the entry whose id is in the map.
    const result = layoutEntries(
      [entry('a', 10, 15), entry('b', 11, 16)],
      20,
      0,
      { greedyTimes: new Map([['a', { startSec: 10, endSec: 15 }]]) },
    )
    // a and b overlap → two rows; a sorts first (start 10) → back → bottom (1),
    // b is the later/front cue → top (0).
    const tracks = new Map(result.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(tracks.get('a')).toBe(1)
    expect(tracks.get('b')).toBe(0)
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

  it('three same-time clips: pinning the dragged one keeps all three rows stable', () => {
    // Three same-time cues (input order a,b,c) → effective 0,1,2 → rows: c is the
    // last/front cue on the TOP row (0), b in the middle (1), a at the bottom (2).
    // User grabs c (pre-drag snapshot 10-15) and drags it left to 9-14; the
    // override pins c's overlap to the snapshot so every row stays put.
    const during = layoutEntries(
      [entry('a', 10, 15), entry('b', 10, 15), entry('c', 9, 14)],
      20,
      0,
      { greedyTimes: new Map([['c', { startSec: 10, endSec: 15 }]]) },
    )
    const tracks = new Map(during.placements.map((p) => [p.entry.id, p.trackIndex]))
    expect(tracks.get('c')).toBe(0) // front → top
    expect(tracks.get('b')).toBe(1)
    expect(tracks.get('a')).toBe(2) // back → bottom
  })
})
