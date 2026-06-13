import type { SubtitleEntry } from '../../shared/types'
import {
  buildSnapTargets,
  snapInterval,
  SNAP_DISTANCE_PX,
  type SnapKind,
} from './timeline-snap'
import { chooseRulerStepSec } from './timeline-layout'
import { roundToCs } from './entry-edits'

export type DragKind = 'resize-start' | 'resize-end' | 'move'

/**
 * Below this body-drag movement we abort the patch entirely (matches the
 * 3 px click-vs-drag threshold in `Block`'s body button).
 */
export const MOVE_DRAG_NOOP_THRESHOLD_PX = 3

/**
 * Pure-function form of the drag-patch computation that used to live
 * inline in `timeline-view.tsx`'s applyDragPatch closure.  Extracted so
 * the snap integration can be unit-tested against the EXACT inputs the
 * pointermove handler passes — REQ-085 #1's investigation needed this
 * because the snap algorithm tests alone passed but real-world drags
 * felt like snap "完全に機能していない" (RES-084 §1.1).
 *
 * Inputs:
 *   - `snapshot`     : the entry's start/end captured at drag-start
 *   - `kind`         : resize-start / resize-end / move
 *   - `dxPx`         : pointer displacement from drag-start (viewport pixels)
 *   - `pps`          : current zoom (px / sec)
 *   - `dur`          : video.durationSec — `Infinity` when no video loaded
 *   - `minBlockSec`  : duration floor for resize operations
 *   - `snapEnabled`  : current toolbar toggle state
 *   - `playhead`     : videoCurrentTimeSec (Original axis)
 *   - `liveEntries`  : current entries (used to derive neighbour edges)
 *   - `draggingEntryId` : id of the entry being dragged (excluded from edges)
 *
 * Output (or `null` for the move-noop case below 3 px):
 *   - `startSec` / `endSec`  : the patch to write through to the store
 *   - `guideTimeSec` / `guideKind` : drives the visual snap-guide line
 *                                    (null when no snap landed)
 */
export interface DragPatchInputs {
  snapshot: { startSec: number; endSec: number }
  kind: DragKind
  dxPx: number
  pps: number
  dur: number
  minBlockSec: number
  snapEnabled: boolean
  playhead: number
  liveEntries: readonly SubtitleEntry[]
  draggingEntryId: string
}

export interface DragPatchOutput {
  startSec: number
  endSec: number
  guideTimeSec: number | null
  guideKind: SnapKind | null
  /**
   * REQ-100: signalled `true` when a `move` drag's cursor is within
   * MOVE_DRAG_NOOP_THRESHOLD_PX of the drag origin (i.e., the user has
   * not yet committed to dragging vs. clicking).  Callers should skip
   * writing the block patch when this is set, but the `guideTimeSec`
   * / `guideKind` fields remain authoritative — the snap guide stays
   * in sync with the cursor even during the click-vs-drag dead zone.
   *
   * For `resize-start` / `resize-end` this is always `false`; the
   * resize handles use the edge-handle pointer-down which doesn't
   * need a click-vs-drag threshold.
   */
  isNoop: boolean
}

export function computeDragPatch(input: DragPatchInputs): DragPatchOutput {
  const {
    snapshot,
    kind,
    dxPx,
    pps,
    dur,
    minBlockSec,
    snapEnabled,
    playhead,
    liveEntries,
    draggingEntryId,
  } = input

  const dxSec = dxPx / pps
  // REQ-20260613-012: floor `dur` to centisecond precision before using it
  // as the upper-bound for the drag clamp.  Without the floor, a video
  // whose duration is not on a cs boundary (e.g. ffprobe reports 8.787 s)
  // lets the post-clamp `finalEnd` sit at 8.787; `roundToCs` (applied
  // below) then rounds HALF-UP to 8.79, which is strictly greater than
  // the video duration and trips `overDuration` in entry-warnings.  The
  // existing clamp was correct in spirit — REQ-002 / REQ-009 etc. all
  // relied on it — but the round-up edge case made the maximum
  // dragable end-time exceed the video by up to one cs.  Flooring the
  // ceiling to cs aligns the clamp with the cs precision the round
  // produces: post-clamp ≤ floor-cs(dur), post-round ≤ floor-cs(dur),
  // overDuration condition (endSec > dur) cannot fire from a drag.
  // resize-end + move both run through this `maxEnd`; resize-start uses
  // `snapshot.endSec - minBlockSec` as its ceiling so it is naturally
  // safe whenever the snapshot was itself in-range (= the only way
  // resize-start can violate is if the entry was already out-of-range
  // before the drag, i.e. via the TimeEditorDialog numeric path that
  // REQ-20260613-012 §4 補足 deliberately leaves un-clamped).
  const maxEnd = isFinite(dur) && dur > 0
    ? Math.floor(dur * 100) / 100
    : Number.MAX_VALUE

  let rawStart = snapshot.startSec
  let rawEnd = snapshot.endSec
  // REQ-100: even when the move drag is in the sub-3-px click-vs-drag
  // dead zone, compute rawStart/rawEnd so the snap guide reflects what
  // WOULD snap if the user moved further.  The previous early-return
  // at this point left snapGuidePx frozen at a stale value (the cause
  // of the owner's "guide flickers / disappears at random during
  // move" report — the guide was deterministic but only updated at
  // dxPx >= 3 px, so any cursor oscillation around the drag origin
  // produced visible gaps).
  let isNoop = false
  if (kind === 'resize-start') {
    const ceiling = snapshot.endSec - minBlockSec
    rawStart = Math.min(ceiling, Math.max(0, snapshot.startSec + dxSec))
  } else if (kind === 'resize-end') {
    const floor = snapshot.startSec + minBlockSec
    rawEnd = Math.max(floor, Math.min(maxEnd, snapshot.endSec + dxSec))
  } else {
    // move — note we no longer early-return here.  isNoop is signalled
    // back to the caller so it can skip the entry write.
    if (Math.abs(dxPx) < MOVE_DRAG_NOOP_THRESHOLD_PX) {
      isNoop = true
    }
    const duration = snapshot.endSec - snapshot.startSec
    const maxStart = Math.max(0, maxEnd - duration)
    rawStart = Math.min(maxStart, Math.max(0, snapshot.startSec + dxSec))
    rawEnd = rawStart + duration
  }

  let finalStart = rawStart
  let finalEnd = rawEnd
  let guideTimeSec: number | null = null
  let guideKind: SnapKind | null = null

  if (snapEnabled) {
    const totalForGrid =
      isFinite(dur) && dur > 0
        ? dur
        : Math.max(
            10,
            liveEntries.reduce((m, x) => (x.endSec > m ? x.endSec : m), 0) * 1.2,
          )
    const targets = buildSnapTargets(
      liveEntries,
      draggingEntryId,
      playhead,
      totalForGrid,
      chooseRulerStepSec(pps),
    )
    const snapped = snapInterval(rawStart, rawEnd, kind, targets, pps, SNAP_DISTANCE_PX)
    // Re-clamp after snap — snap targets are vetted for proximity, not
    // legality (= within video duration, start+min ≤ end).
    finalStart = Math.max(0, Math.min(maxEnd - minBlockSec, snapped.startSec))
    finalEnd = Math.max(finalStart + minBlockSec, Math.min(maxEnd, snapped.endSec))
    if (snapped.guide) {
      guideTimeSec = snapped.guide.timeSec
      guideKind = snapped.guide.kind
    }
  }

  // Round to cs precision so drag output matches the TimeEditorDialog's
  // roundCs confirm path (REQ-059).
  finalStart = roundToCs(finalStart)
  finalEnd = roundToCs(finalEnd)

  return {
    startSec: finalStart,
    endSec: finalEnd,
    guideTimeSec,
    guideKind,
    isNoop,
  }
}
