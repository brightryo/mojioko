import { describe, it, expect } from 'vitest'
import { computeDragPatch, type DragPatchInputs } from '../../src/renderer/lib/timeline-drag'
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
  return {
    id,
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base },
  }
}

/**
 * REQ-085 #1 integration-style tests for the drag-patch pipeline.
 *
 * RES-084 §1.1 declared the snap algorithm "verified by 12 unit tests"
 * and bumped SNAP_DISTANCE_PX from 6 to 12 — but the owner still reported
 * snap "完全に機能していない" in practice.  Those algorithm tests covered
 * `buildSnapTargets` / `findBestSnap` / `snapInterval` in isolation; they
 * never asserted that the pointermove handler's wiring actually invokes
 * them, propagates their result into a patch, and applies that patch to
 * the entry.  These tests close that gap: each one drives `computeDragPatch`
 * (the extracted core of `applyDragPatch`) with realistic drag inputs and
 * asserts the returned patch contains the snapped coordinates.
 *
 * If any of these regress, the silent "snap-tests-pass-but-real-snap-
 * broken" failure mode that RES-084 missed cannot recur unnoticed.
 */

const PPS = 50           // TIMELINE_PPS_DEFAULT
const DUR = 60           // 60-second video
const MIN = 0.05         // MIN_BLOCK_SEC

function baseInput(overrides: Partial<DragPatchInputs>): DragPatchInputs {
  return {
    snapshot: { startSec: 5, endSec: 10 },
    kind: 'move',
    dxPx: 0,
    pps: PPS,
    dur: DUR,
    minBlockSec: MIN,
    snapEnabled: true,
    playhead: 0,
    liveEntries: [],
    draggingEntryId: 'never',
    ...overrides,
  }
}

describe('computeDragPatch — move drag end-to-end', () => {
  it('snaps to a neighbour edge: dragging A near B.startSec moves A flush', () => {
    // A=[5,10], B=[12,15].  User drags A right by 350 px = 7 sec; raw
    // would land at startSec=12, which is B's start — snap pulls it
    // exactly there (and would also still snap if the cursor was within
    // 0.24 s thanks to SNAP_DISTANCE_PX=12).
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 7 * PPS,
      liveEntries: [entry('a', 5, 10), entry('b', 12, 15)],
      draggingEntryId: 'a',
    }))
    expect(patch).not.toBeNull()
    expect(patch!.startSec).toBe(12)
    expect(patch!.endSec).toBe(17)
    expect(patch!.guideKind).toBe('edge')
  })

  it('snaps to playhead when drag end lands near videoCurrentTimeSec', () => {
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 2, endSec: 7 },
      kind: 'move',
      dxPx: 3 * PPS,         // raw startSec → 5, endSec → 10
      playhead: 9.95,        // close to rawEnd=10; window is 0.24 s
      liveEntries: [entry('a', 2, 7)],
      draggingEntryId: 'a',
    }))
    expect(patch).not.toBeNull()
    // 'move' picks whichever edge snaps best.  playhead beats grid → end
    // snaps to playhead 9.95, start follows by duration 5 → 4.95.
    expect(patch!.endSec).toBe(9.95)
    expect(patch!.startSec).toBe(4.95)
    expect(patch!.guideKind).toBe('playhead')
  })

  it('snaps to ruler grid (chooseRulerStepSec=2 at 50 px/sec)', () => {
    // At pps=50 chooseRulerStepSec returns 2 → grid at 0, 2, 4, …
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 1 * PPS,         // raw startSec → 6, endSec → 11
      liveEntries: [],
    }))
    expect(patch).not.toBeNull()
    // rawStart=6 sits on a grid line — snap holds it there.
    expect(patch!.startSec).toBe(6)
    expect(patch!.guideKind).toBe('grid')
  })

  it('no snap target nearby → block follows the cursor freely', () => {
    // Drag to a position that is NOT inside the 12 px window of any
    // grid point.  At pps=50, grid points are 100 px apart (2 sec); a
    // 50 px offset puts us exactly between, ≥ 50 px from either side.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 0.7 * PPS,       // raw startSec → 5.7, endSec → 10.7
      liveEntries: [],
    }))
    expect(patch).not.toBeNull()
    expect(patch!.startSec).toBe(5.7)
    expect(patch!.endSec).toBe(10.7)
    expect(patch!.guideKind).toBeNull()
  })

  it('snap toggle OFF → block follows the cursor freely regardless of nearby targets', () => {
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 1 * PPS,         // raw startSec → 6 — would snap to grid 6 normally
      snapEnabled: false,    // ← toggle off
      liveEntries: [],
    }))
    expect(patch).not.toBeNull()
    expect(patch!.startSec).toBe(6)
    expect(patch!.guideKind).toBeNull()
  })

  it('movement below 3 px → no patch (matches Block body click-vs-drag threshold)', () => {
    const patch = computeDragPatch(baseInput({
      kind: 'move',
      dxPx: 2,
    }))
    expect(patch).toBeNull()
  })
})

describe('computeDragPatch — resize-start / resize-end snap to neighbour edge', () => {
  it('resize-start snaps the start handle to a neighbour edge', () => {
    // A=[3,10], B=[8,12].  Drag A.start handle right by 4.85 s = 242.5 px;
    // raw start lands at 7.85, within 12 px of B's start at 8 (= 7.5 px).
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 3, endSec: 10 },
      kind: 'resize-start',
      dxPx: 4.85 * PPS,
      liveEntries: [entry('a', 3, 10), entry('b', 8, 12)],
      draggingEntryId: 'a',
    }))
    expect(patch).not.toBeNull()
    expect(patch!.startSec).toBe(8)
    expect(patch!.guideKind).toBe('edge')
  })

  it('resize-end snaps the end handle to a grid point', () => {
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'resize-end',
      dxPx: 1.85 * PPS,       // raw end → 11.85, grid 12 is 7.5 px away → snap
      liveEntries: [],
    }))
    expect(patch).not.toBeNull()
    expect(patch!.endSec).toBe(12)
    expect(patch!.guideKind).toBe('grid')
  })
})

describe('computeDragPatch — clamping invariants', () => {
  it('rawStart is clamped to [0, maxEnd - duration] for move', () => {
    // Drag far past the video end — final endSec must not exceed dur.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 50, endSec: 55 },
      kind: 'move',
      dxPx: 20 * PPS,        // would push beyond 60 s duration
      liveEntries: [],
    }))
    expect(patch).not.toBeNull()
    expect(patch!.endSec).toBeLessThanOrEqual(DUR)
    expect(patch!.startSec).toBeGreaterThanOrEqual(0)
  })

  it('roundToCs produces cs-aligned outputs (REQ-059)', () => {
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 17,              // 17/50 = 0.34 → rawStart 5.34
      liveEntries: [],
      snapEnabled: false,    // skip snap to test pure rounding
    }))
    expect(patch).not.toBeNull()
    // 0.34 is already cs-aligned.  Pick a value that isn't — 19 / 50 = 0.38.
    const patch2 = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 19,
      liveEntries: [],
      snapEnabled: false,
    }))
    expect(patch2!.startSec).toBe(5.38)
    expect((patch2!.startSec * 100) % 1).toBeCloseTo(0, 10)
  })
})
