import { describe, it, expect } from 'vitest'
import {
  buildSnapTargets,
  findBestSnap,
  snapInterval,
  SNAP_DISTANCE_PX,
} from '../../src/renderer/lib/timeline-snap'
import type { SubtitleEntry } from '../../src/shared/types'

function entry(
  id: string,
  startSec: number,
  endSec: number,
  isDeleted = false,
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
    isDeleted,
    isEdited: false,
    original: { ...base },
  }
}

/**
 * REQ-084 #1 regression guard.  After REQ-083 the user reported snap
 * completely stopped working in practice.  These tests pin the pure
 * snap algorithm at the values the drag handler actually passes —
 * 50 px/sec default zoom, the 6 px SNAP_DISTANCE_PX threshold — so
 * any future commit that silently breaks snap fails CI.
 */

describe('buildSnapTargets — outputs all three categories', () => {
  it('emits playhead + neighbour edges + grid points', () => {
    const entries = [entry('a', 5, 10), entry('b', 20, 25)]
    const targets = buildSnapTargets(entries, 'a', 8, 60, 1)
    const kinds = targets.map((t) => t.kind)
    expect(kinds).toContain('playhead')
    expect(kinds).toContain('edge')
    expect(kinds).toContain('grid')
    // playhead at 8
    expect(targets.find((t) => t.kind === 'playhead')?.timeSec).toBe(8)
    // b's start (20) and end (25) — a is the drag entry, so its
    // edges are excluded.
    const edges = targets.filter((t) => t.kind === 'edge').map((t) => t.timeSec)
    expect(edges).toEqual(expect.arrayContaining([20, 25]))
    expect(edges).not.toContain(5)
    expect(edges).not.toContain(10)
  })

  it('skips deleted entries', () => {
    const entries = [entry('a', 5, 10), entry('b', 20, 25, true)]
    const targets = buildSnapTargets(entries, 'a', 8, 60, 1)
    const edges = targets.filter((t) => t.kind === 'edge').map((t) => t.timeSec)
    expect(edges).not.toContain(20)
    expect(edges).not.toContain(25)
  })

  it('handles videoCurrentTimeSec = 0 (no video loaded) by emitting playhead at 0', () => {
    const targets = buildSnapTargets([], 'never', 0, 30, 1)
    expect(targets.find((t) => t.kind === 'playhead')?.timeSec).toBe(0)
  })
})

describe('findBestSnap — distance threshold + kind priority', () => {
  const pps = 50  // default zoom
  const snapPx = SNAP_DISTANCE_PX  // 12 px (REQ-084)

  it('returns null when no target lies within snapPx', () => {
    const targets = [{ timeSec: 10, kind: 'edge' as const }]
    // candidate 5 s → |10 - 5| * 50 = 250 px (well beyond 12 px)
    expect(findBestSnap(5, targets, pps, snapPx)).toBeNull()
  })

  it('snaps to the nearest target within snapPx (= 0.24 s at 50 px/sec)', () => {
    const targets = [{ timeSec: 12, kind: 'edge' as const }]
    // 11.85 → |12 - 11.85| * 50 = 7.5 px → within
    const r = findBestSnap(11.85, targets, pps, snapPx)
    expect(r).not.toBeNull()
    expect(r!.timeSec).toBe(12)
  })

  it('candidate just inside the snap window snaps', () => {
    const targets = [{ timeSec: 12, kind: 'edge' as const }]
    // |12 - 11.8| * 50 = 10 → comfortably inside the 12 px window.
    // Avoid float-exact threshold tests (0.24 * 50 trips IEEE-754 drift).
    const r = findBestSnap(11.8, targets, pps, snapPx)
    expect(r).not.toBeNull()
  })

  it('picks playhead over edge over grid when both within range', () => {
    const targets = [
      { timeSec: 12.0, kind: 'grid' as const },
      { timeSec: 12.0, kind: 'edge' as const },
      { timeSec: 12.0, kind: 'playhead' as const },
    ]
    const r = findBestSnap(12.0, targets, pps, snapPx)
    expect(r!.kind).toBe('playhead')
  })
})

describe('snapInterval — end-to-end drag scenarios at default 50 px/sec', () => {
  const pps = 50
  const snapPx = SNAP_DISTANCE_PX

  it('move drag close to a neighbour edge snaps the block to it', () => {
    // A at [5, 10] dragged so it would start near 11.85; B's start
    // is at 12.  Snap should move A to [12, 17].
    const targets = buildSnapTargets(
      [entry('a', 5, 10), entry('b', 12, 15)],
      'a',
      8,
      30,
      1,
    )
    const r = snapInterval(11.85, 16.85, 'move', targets, pps, snapPx)
    expect(r.guide).not.toBeNull()
    expect(r.startSec).toBe(12)
    expect(r.endSec).toBe(17)
  })

  it('resize-start near playhead snaps the start to playhead', () => {
    const targets = buildSnapTargets(
      [entry('a', 5, 10)],
      'a',
      7.96,
      30,
      1,
    )
    // dragging the start handle from 5 → 7.85: snap to playhead 7.96
    // (|7.96 - 7.85| * 50 = 5.5 px → well inside the 12 px window)
    const r = snapInterval(7.85, 10, 'resize-start', targets, pps, snapPx)
    expect(r.guide?.kind).toBe('playhead')
    expect(r.startSec).toBe(7.96)
    expect(r.endSec).toBe(10)
  })

  it('resize-end near grid point snaps the end', () => {
    const targets = buildSnapTargets([entry('a', 5, 10)], 'a', NaN, 30, 1)
    // grid at 10 (stepSec=1); dragging end from 10 → 9.85 snaps back to 10
    const r = snapInterval(5, 9.85, 'resize-end', targets, pps, snapPx)
    expect(r.guide).not.toBeNull()
    expect(r.endSec).toBe(10)
  })

  it('no nearby targets → pass-through, guide null', () => {
    const targets = buildSnapTargets(
      [entry('a', 5, 10), entry('b', 50, 55)],
      'a',
      45,
      60,
      1,
    )
    // candidate at 20.5 — nearest grid points 20 and 21 sit 25 px away,
    // both beyond the 12 px window.  Edge targets (b's 50, 55) are far.
    const r = snapInterval(20.5, 25.5, 'move', targets, pps, snapPx)
    expect(r.guide).toBeNull()
    expect(r.startSec).toBe(20.5)
    expect(r.endSec).toBe(25.5)
  })

  /**
   * REQ-084 anchor for the snap-distance bump.  Without this constant
   * locked into a test, a regression that re-shrinks the window slips
   * past CI silently.
   */
  it('SNAP_DISTANCE_PX is 12 (REQ-084 bumped from the original 6)', () => {
    expect(SNAP_DISTANCE_PX).toBe(12)
  })
})
