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
}

export function computeDragPatch(input: DragPatchInputs): DragPatchOutput | null {
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
  const maxEnd = isFinite(dur) && dur > 0 ? dur : Number.MAX_VALUE

  let rawStart = snapshot.startSec
  let rawEnd = snapshot.endSec
  if (kind === 'resize-start') {
    const ceiling = snapshot.endSec - minBlockSec
    rawStart = Math.min(ceiling, Math.max(0, snapshot.startSec + dxSec))
  } else if (kind === 'resize-end') {
    const floor = snapshot.startSec + minBlockSec
    rawEnd = Math.max(floor, Math.min(maxEnd, snapshot.endSec + dxSec))
  } else {
    // move
    if (Math.abs(dxPx) < MOVE_DRAG_NOOP_THRESHOLD_PX) return null
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
  }
}
