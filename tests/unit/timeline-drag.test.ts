import { describe, it, expect } from 'vitest'
import { computeDragPatch, type DragPatchInputs } from '../../src/renderer/lib/timeline-drag'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'
import { origToEdited, type CutList } from '../../src/shared/cuts'

function entry(id: string, startSec: number, endSec: number): SubtitleEntry {
  const base = {
    startSec,
    endSec,
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

  it('movement below 3 px → isNoop=true (matches Block body click-vs-drag threshold)', () => {
    // REQ-100 changed the noop signal from `null` to a flag so the
    // snap guide can still be derived from the cursor position even
    // while the entry write is skipped.  Previously this returned
    // null and applyDragPatch returned early without touching
    // snapGuidePx, which left the guide frozen at a stale value
    // during cursor oscillations around the drag origin.
    const patch = computeDragPatch(baseInput({
      kind: 'move',
      dxPx: 2,
    }))
    expect(patch.isNoop).toBe(true)
  })

  it('REQ-100: noop still computes a snap guide so the UI stays in sync', () => {
    // dxPx=2 (sub-3-px noop) BUT the cursor is over a snap target.
    // The block patch should be flagged isNoop=true (so the caller
    // skips updateEntry), but the snap-guide fields MUST still
    // surface the target — otherwise the visual guide freezes at
    // whatever value the last non-noop event left it at, producing
    // the "guide appears or disappears at random during move" report.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 2,                       // below noop threshold
      liveEntries: [entry('a', 5, 10), entry('b', 5.04, 8)], // B.startSec is at rawStart 5.04
      draggingEntryId: 'a',
    }))
    expect(patch.isNoop).toBe(true)
    // rawStart = 5 + 2/50 = 5.04; B.startSec = 5.04 → distPx 0 → snap.
    expect(patch.guideKind).toBe('edge')
    expect(patch.guideTimeSec).toBe(5.04)
  })

  it('REQ-100: noop with snap disabled still returns a non-null result (no guide)', () => {
    const patch = computeDragPatch(baseInput({
      kind: 'move',
      dxPx: 1,
      snapEnabled: false,
    }))
    expect(patch.isNoop).toBe(true)
    expect(patch.guideKind).toBeNull()
    expect(patch.guideTimeSec).toBeNull()
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

  /**
   * REQ-20260613-012: when the video duration falls between two
   * centisecond boundaries (e.g. ffprobe reports 8.787 s), the pre-fix
   * pipeline clamped finalEnd to dur=8.787 then `roundToCs` rounded
   * the value HALF-UP to 8.79.  That 8.79 strictly exceeded dur, which
   * lit up `overDuration` in entry-warnings even though the user had
   * only dragged the clip to the apparent right edge of the timeline.
   *
   * The fix is to floor `dur` to centiseconds (`Math.floor(dur*100)/100`)
   * before using it as the clamp ceiling.  Post-clamp ≤ floor-cs(dur),
   * post-round ≤ floor-cs(dur), so `finalEnd > dur` cannot arise from
   * a drag.  These three tests pin the invariant for each drag kind.
   */
  it('move clamp respects sub-cs video duration — endSec never exceeds dur', () => {
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 2 },
      kind: 'move',
      dxPx: 1000 * PPS,   // way past the video end
      dur: 8.787,         // sub-cs duration (= the user's observation)
      liveEntries: [],
      snapEnabled: false,
    }))
    expect(patch!.endSec).toBeLessThanOrEqual(8.787)
    // Pre-fix: patch.endSec would be 8.79 (= roundToCs(8.787)).
    expect(patch!.endSec).toBe(8.78)
  })

  it('resize-end clamp respects sub-cs video duration', () => {
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 2 },
      kind: 'resize-end',
      dxPx: 1000 * PPS,
      dur: 8.787,
      liveEntries: [],
      snapEnabled: false,
    }))
    expect(patch!.endSec).toBeLessThanOrEqual(8.787)
    expect(patch!.endSec).toBe(8.78)
  })

  it('move clamp at exact cs-aligned dur permits endSec == dur', () => {
    // Regression guard: the floor-to-cs fix must not over-clamp when
    // dur already sits on a cs boundary (= the most common case).
    // Dragging a 5-s clip past the end of an 8.00-s video should land
    // endSec at exactly 8.00, not 7.99.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 5 },
      kind: 'move',
      dxPx: 1000 * PPS,
      dur: 8.00,
      liveEntries: [],
      snapEnabled: false,
    }))
    expect(patch!.endSec).toBe(8.00)
    expect(patch!.startSec).toBe(3.00)
  })
})

/**
 * REQ-0200 / REQ-0201 — drag delta is Edited-axis, translated through
 * origToEdited / editedToOrig so cuts do not create an axis mismatch.
 *
 * The pre-fix pipeline computed `dxSec = dxPx / pps` (Edited seconds by
 * construction — pps is Edited px/s) and added it directly to
 * `snapshot.endSec` (Original seconds).  With cuts present that
 * mismatch caused the block to visually stop at the cut boundary while
 * the cursor kept moving, until the underlying Original endSec had
 * traversed the entire cut interior (RES-0200 §4.1).
 *
 * The tests below drive the fixed pipeline with a realistic cut list
 * and assert that:
 *   1. the no-cut path is bit-identical to the pre-fix output (the
 *      identity contract) — pinned by the existing 15 tests above,
 *      which we deliberately do NOT rewrite; they still pass with
 *      cuts defaulting to `[]`.
 *   2. dragging across a cut boundary makes the block's Edited-axis
 *      right edge track the cursor pixel-for-pixel (no plateau, no
 *      leap).
 *   3. resize-start / move behave symmetrically.
 *   4. clamps (video duration, min block width) still hold under cuts.
 *
 * The pixel-for-pixel invariant is the whole point of the fix, so the
 * cut cases assert it directly rather than via a coordinate snapshot.
 */
describe('computeDragPatch — REQ-0201 Edited-axis translation with cuts', () => {
  // Reference cut: Original [1.5, 3.4].  Edited timeline collapses this
  // to a single point at Edited 1.5, and any subsequent Original time
  // shifts left by 1.9 s.
  const CUT: CutList = [{ id: 'c', startSec: 1.5, endSec: 3.4 }]

  it('no-cut path: adding an empty cuts array is bit-identical to omitting cuts', () => {
    // The identity contract — critical for shipping to users who never
    // touched the cut feature.  Any observable difference here would
    // regress cases the pre-REQ-0201 test suite has already pinned.
    const inputWithout = baseInput({
      snapshot: { startSec: 5, endSec: 10 },
      kind: 'move',
      dxPx: 3 * PPS,
      liveEntries: [entry('a', 5, 10)],
      draggingEntryId: 'a',
    })
    const inputWith = { ...inputWithout, cuts: [] }
    const a = computeDragPatch(inputWithout)
    const b = computeDragPatch(inputWith)
    expect(b.startSec).toBe(a.startSec)
    expect(b.endSec).toBe(a.endSec)
    expect(b.guideKind).toBe(a.guideKind)
    expect(b.guideTimeSec).toBe(a.guideTimeSec)
  })

  it('resize-end before the cut: cursor and block right edge coincide (no cut interaction)', () => {
    // Dragging clip1's right edge from Edited 1.0 to Edited 1.3 —
    // entirely inside the pre-cut region, so origToEdited === identity
    // here and behaviour matches the no-cut path exactly.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 1.0 },
      kind: 'resize-end',
      dxPx: 0.3 * PPS,
      dur: 10,
      liveEntries: [entry('a', 0, 1.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
    }))
    expect(origToEdited(patch.endSec, CUT)).toBeCloseTo(1.3, 10)
    expect(patch.endSec).toBeCloseTo(1.3, 10)
  })

  it('resize-end across the cut: block right edge follows cursor pixel-for-pixel', () => {
    // The core REQ-0200 scenario.  snapshot.endSec = 1.0 (Original =
    // Edited).  Drag cursor to Edited 2.0 — that is past the cut
    // boundary at Edited 1.5 and lands in the post-cut portion of the
    // Edited timeline (Original ~3.9 s).
    //
    // Pre-fix behaviour: rawEnd = 1.0 + 1.0 = 2.0 (Original), which is
    // INSIDE the cut, so the block's Edited visual right edge clamped
    // to 1.5 — stuck 0.5 s behind the cursor.
    //
    // Post-fix behaviour: rawEnd = editedToOrig(1.0 + 1.0, CUT) = 3.9
    // (Original), which origToEdited maps back to Edited 2.0.  Block
    // right edge lands exactly under the cursor.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 1.0 },
      kind: 'resize-end',
      dxPx: 1.0 * PPS,
      dur: 10,
      liveEntries: [entry('a', 0, 1.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
    }))
    // Cursor was at Edited 2.0 → block right edge SHOULD be at Edited 2.0.
    expect(origToEdited(patch.endSec, CUT)).toBeCloseTo(2.0, 10)
    // Corresponding Original endSec is post-cut (2.0 + 1.9 = 3.9).
    expect(patch.endSec).toBeCloseTo(3.9, 10)
  })

  it('resize-end deep past the cut: Edited displacement = cursor displacement', () => {
    // Cursor at Edited 3.0 (2.0 s of Edited movement past snapshot.end
    // at Edited 1.0).  Original endSec should land at 4.9 (3.0 + cut
    // duration 1.9), and the block's Edited right edge at 3.0.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 1.0 },
      kind: 'resize-end',
      dxPx: 2.0 * PPS,
      dur: 10,
      liveEntries: [entry('a', 0, 1.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
    }))
    expect(origToEdited(patch.endSec, CUT)).toBeCloseTo(3.0, 10)
    expect(patch.endSec).toBeCloseTo(4.9, 10)
  })

  it('resize-end when snapshot already lives past the cut: still tracks cursor exactly', () => {
    // snapshot at Original 4.0 = Edited 2.1.  Drag +0.5 Edited-sec →
    // Edited 2.6, Original editedToOrig(2.6, CUT) = 4.5.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 4.0, endSec: 4.5 },
      kind: 'resize-end',
      dxPx: 0.5 * PPS,
      dur: 10,
      liveEntries: [entry('a', 4.0, 4.5)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
    }))
    // 4.5 (Edited 2.6) + 0.5 Edited → Edited 3.1 = Original 5.0.
    expect(origToEdited(patch.endSec, CUT)).toBeCloseTo(3.1, 10)
    expect(patch.endSec).toBeCloseTo(5.0, 10)
  })

  it('resize-start across the cut: block left edge follows cursor pixel-for-pixel', () => {
    // Symmetric to resize-end.  clip at Original [4.0, 5.0] (= Edited
    // [2.1, 3.1]).  Drag the START handle LEFT by 1.0 Edited-sec →
    // cursor at Edited 1.1, block left should land at Edited 1.1
    // (Original 1.1, still before the cut).
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 4.0, endSec: 5.0 },
      kind: 'resize-start',
      dxPx: -1.0 * PPS,
      dur: 10,
      liveEntries: [entry('a', 4.0, 5.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
    }))
    expect(origToEdited(patch.startSec, CUT)).toBeCloseTo(1.1, 10)
    expect(patch.startSec).toBeCloseTo(1.1, 10)
  })

  it('move across the cut: both edges track cursor and preserve Edited duration', () => {
    // clip at Original [0, 1.0] (Edited [0, 1.0]).  Move by +1.5 Edited-
    // sec.  Cursor drags clip toward Edited [1.5, 2.5].  Post-clamp
    // (0 is already the origin, no upper block issue) the clip should
    // land at Edited [1.5, 2.5] → Original [1.5, 4.4] (start snaps to
    // 1.5 = cut boundary; end is editedToOrig(2.5) = 4.4).
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 1.0 },
      kind: 'move',
      dxPx: 1.5 * PPS,
      dur: 10,
      liveEntries: [entry('a', 0, 1.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
    }))
    // Edited duration preserved.
    const editedStart = origToEdited(patch.startSec, CUT)
    const editedEnd = origToEdited(patch.endSec, CUT)
    expect(editedEnd - editedStart).toBeCloseTo(1.0, 10)
    expect(editedStart).toBeCloseTo(1.5, 10)
    expect(editedEnd).toBeCloseTo(2.5, 10)
  })

  it('resize-end clamp: cannot extend past editedDuration(dur, cuts)', () => {
    // dur = 10, cuts = [1.5, 3.4] → editedDuration = 8.1.  Drag WAY past
    // the end.  Block's Edited right edge must land at 8.1 (or floor-cs
    // of it: 8.10), and Original endSec at editedToOrig(8.1) = 10.0.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 1.0 },
      kind: 'resize-end',
      dxPx: 1000 * PPS,
      dur: 10,
      liveEntries: [entry('a', 0, 1.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
    }))
    expect(patch.endSec).toBeLessThanOrEqual(10)
    // Block visual right edge <= edited timeline end.
    expect(origToEdited(patch.endSec, CUT)).toBeLessThanOrEqual(8.1)
    // Sanity: the clamp landed AT the ceiling (post-cs-floor).
    expect(origToEdited(patch.endSec, CUT)).toBeCloseTo(8.1, 2)
  })

  it('minBlockSec floor holds under cuts (cannot shrink resize-end below floor)', () => {
    // snapshot = clip of Edited-duration 1.0 s.  Drag resize-end LEFT
    // to a value below snapshot.startSec + minBlockSec.  Post-clamp,
    // Edited duration must be exactly minBlockSec.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 0, endSec: 1.0 },
      kind: 'resize-end',
      dxPx: -10 * PPS,
      dur: 10,
      liveEntries: [entry('a', 0, 1.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
      minBlockSec: 0.05,
    }))
    // rawEnd should have clamped to snapshot.startSec + minBlockSec = 0.05.
    expect(patch.endSec).toBeCloseTo(0.05, 10)
  })

  it('minBlockSec ceiling holds for resize-start under cuts', () => {
    // clip at Original [4.0, 5.0].  Drag resize-start RIGHT by more than
    // (Edited duration - minBlockSec).  Post-clamp, block's Edited
    // duration must be exactly minBlockSec.
    const patch = computeDragPatch(baseInput({
      snapshot: { startSec: 4.0, endSec: 5.0 },
      kind: 'resize-start',
      dxPx: 10 * PPS,
      dur: 10,
      liveEntries: [entry('a', 4.0, 5.0)],
      draggingEntryId: 'a',
      snapEnabled: false,
      cuts: CUT,
      minBlockSec: 0.05,
    }))
    const editedStart = origToEdited(patch.startSec, CUT)
    const editedEnd = origToEdited(5.0, CUT) // unchanged for resize-start
    expect(editedEnd - editedStart).toBeCloseTo(0.05, 10)
  })

  it('cursor moving through the cut region does NOT plateau — block right stays under cursor', () => {
    // The full regression pin against the RES-0200 symptom.  Sample
    // cursor at 12 Edited-sec offsets from snapshot.end (Edited 1.0):
    //   +0.3, +0.7, +1.0, +1.3, +1.7, +2.0
    // For every sample, the block's Edited right edge must equal the
    // cursor's Edited position (within cs precision).  If any sample
    // shows a plateau at cut boundary 1.5, the axis fix has broken.
    for (const dxSec of [0.3, 0.7, 1.0, 1.3, 1.7, 2.0]) {
      const patch = computeDragPatch(baseInput({
        snapshot: { startSec: 0, endSec: 1.0 },
        kind: 'resize-end',
        dxPx: dxSec * PPS,
        dur: 10,
        liveEntries: [entry('a', 0, 1.0)],
        draggingEntryId: 'a',
        snapEnabled: false,
        cuts: CUT,
      }))
      const editedEnd = origToEdited(patch.endSec, CUT)
      const expected = 1.0 + dxSec
      // cs precision — the roundToCs pass can drift by up to one cs.
      expect(editedEnd).toBeCloseTo(expected, 2)
    }
  })
})
