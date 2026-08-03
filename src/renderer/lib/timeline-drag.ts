import type { SubtitleEntry } from '../../shared/types'
import {
  buildSnapTargets,
  snapInterval,
  SNAP_DISTANCE_PX,
  type SnapKind,
} from './timeline-snap'
import { chooseRulerStepSec } from './timeline-layout'
import { roundToCs } from './entry-edits'
import { MIN_LAYER, MAX_LAYER, resolveLayer } from '../../shared/cue-placement'
import {
  origToEdited,
  editedToOrig,
  editedDuration,
  type CutList,
} from '../../shared/cuts'

export type DragKind = 'resize-start' | 'resize-end' | 'move'

/**
 * Below this body-drag movement we abort the patch entirely (matches the
 * 3 px click-vs-drag threshold in `Block`'s body button).
 */
export const MOVE_DRAG_NOOP_THRESHOLD_PX = 3

/**
 * REQ-0399 — a body 'move' drag can travel two ways: horizontally to change
 * TIME (the legacy behaviour) or vertically to change the cue's z-order LAYER
 * (carry it to another track, like a standard NLE).  `decideDragAxis` picks the
 * axis from the drag vector and the caller LOCKS it for the rest of the gesture
 * so a diagonal drag resolves to exactly one axis and never edits both.
 */
export type DragAxis = 'time' | 'layer'

/**
 * The dead-zone (px) a body 'move' drag must leave before an axis is chosen.
 * Below it the gesture is still ambiguous (a click, or jitter) and no axis is
 * committed.  Kept a touch above `MOVE_DRAG_NOOP_THRESHOLD_PX` so the dominant
 * direction is unambiguous by the time we lock.
 */
export const AXIS_LOCK_THRESHOLD_PX = 4

/**
 * Decide the drag axis from the pointer displacement, or `null` while still in
 * the dead-zone.  The dominant magnitude wins; ties fall to `time` (the legacy
 * axis) so a purely horizontal drag is never misread as a layer move.
 */
export function decideDragAxis(
  dxPx: number,
  dyPx: number,
  thresholdPx: number = AXIS_LOCK_THRESHOLD_PX,
): DragAxis | null {
  if (Math.abs(dxPx) < thresholdPx && Math.abs(dyPx) < thresholdPx) return null
  return Math.abs(dyPx) > Math.abs(dxPx) ? 'layer' : 'time'
}

/**
 * The layer a vertical drag resolves to: one layer step per track-row of
 * vertical travel, added to the source layer and clamped to
 * `[MIN_LAYER, MAX_LAYER]`.  Up (negative `dyPx`) moves toward the FRONT
 * (higher layer) to match the bottom-anchored timeline where layer 0 sits at
 * the bottom (REQ-0397 §3).  `trackHeightPx` is `TRACK_HEIGHT_PX`.
 *
 * Retained from REQ-0399; the REQ-0402 cursor-following drag uses
 * `computeLayerDragVisual` instead (it needs the follow position and the
 * on-screen row too, and it clamps to the RENDERED rows).
 */
export function computeLayerDrag(
  baseLayer: number,
  dyPx: number,
  trackHeightPx: number,
): number {
  const delta = Math.round(-dyPx / trackHeightPx) // up (dy<0) → +layer (front)
  return Math.max(MIN_LAYER, Math.min(MAX_LAYER, baseLayer + delta))
}

export interface LayerDragVisual {
  /**
   * Band-relative top (px) for the FLOATING dragged block — it follows the
   * cursor 1:1, clamped to stay within the rendered rows so the clip never
   * flies off the track area (REQ-0402 §2).
   */
  blockTopPx: number
  /** The row (top = 0) the clip will snap to when released. */
  targetRowIndex: number
  /** The z-order layer that target row represents. */
  targetLayer: number
}

/**
 * REQ-0402 §2 — resolve a vertical (layer-axis) drag into the floating block's
 * follow position AND the track it will snap to.  Unlike `computeLayerDrag`
 * (which just returns a layer), this keeps the block gliding under the cursor
 * (`blockTopPx = baseTop + dyPx`, clamped to the rows) and derives the snap
 * target by rounding that position to the nearest row — so the clip follows the
 * cursor smoothly and snaps to a track on release rather than hopping discretely.
 *
 * The reference frame is the RENDERED rows 0..`maxRow` (bottom-anchored: row 0 =
 * top = layer `maxRow`, row `maxRow` = bottom = layer 0), matching
 * `layoutEntries` (REQ-0402 §1).  `trackHeightPx` = `TRACK_HEIGHT_PX`,
 * `blockPadPx` = `BLOCK_VERTICAL_PAD_PX`.  The target layer is therefore clamped
 * to `[0, maxRow]` — a single drag reaches at most the one spare track above the
 * current max (raising it again reveals the next spare).
 */
export function computeLayerDragVisual(
  baseLayer: number,
  dyPx: number,
  maxRow: number,
  trackHeightPx: number,
  blockPadPx: number,
): LayerDragVisual {
  const h = trackHeightPx
  const baseLayerClamped = Math.max(MIN_LAYER, Math.min(maxRow, baseLayer))
  const baseRowIndex = maxRow - baseLayerClamped
  const baseTopPx = baseRowIndex * h + blockPadPx
  const minTop = blockPadPx
  const maxTop = maxRow * h + blockPadPx
  const blockTopPx = Math.max(minTop, Math.min(maxTop, baseTopPx + dyPx))
  const targetRowIndex = Math.max(0, Math.min(maxRow, Math.round((blockTopPx - blockPadPx) / h)))
  const targetLayer = maxRow - targetRowIndex
  return { blockTopPx, targetRowIndex, targetLayer }
}

export interface MoveCommit {
  /** The pre-drag entry — `undo` restores this (both time and layer). */
  before: SubtitleEntry
  /** The post-drag entry: the final (live-committed) time plus the pending layer. */
  after: SubtitleEntry
}

/**
 * REQ-0403 — build the SINGLE undo step for a 2D clip move.  A move drag writes
 * time to the store live but keeps the layer pending (the block floats), so on
 * release the two axes must be committed together and reverted together.
 *
 * `before` is the pre-drag snapshot; `finalTimeEntry` is the entry as it stands
 * in the store after the live time writes (its layer is still the pre-drag
 * value); `pendingLayer` is where the vertical drag landed.  Returns `null` when
 * NOTHING moved (so the caller pushes no history and skips the re-sort), else a
 * `{before, after}` pair where `after` carries the final time AND the pending
 * layer — so one history op restores both whether the user moved in X, Y or both.
 */
export function buildMoveCommit(
  before: SubtitleEntry,
  finalTimeEntry: SubtitleEntry,
  pendingLayer: number,
): MoveCommit | null {
  const timeChanged =
    finalTimeEntry.startSec !== before.startSec || finalTimeEntry.endSec !== before.endSec
  const layerChanged = pendingLayer !== resolveLayer(before)
  if (!timeChanged && !layerChanged) return null
  return {
    before,
    after: { ...finalTimeEntry, layer: pendingLayer },
  }
}

/**
 * Pure-function form of the drag-patch computation.
 *
 * REQ-085 #1 extracted the drag pipeline out of `timeline-view.tsx`'s
 * applyDragPatch closure so the snap integration could be unit-tested
 * against the EXACT inputs the pointermove handler passes.
 *
 * REQ-0200 / REQ-0201 (v1.3.3) — the pipeline now respects the **Edited
 * axis**.  Before this change, `dxSec = dxPx / pps` (Edited-axis pixel
 * displacement → Edited seconds) was added directly to `snapshot.endSec`
 * (Original seconds).  With no cuts that works because the two axes
 * coincide, but the moment a cut existed the block visually stopped at
 * the cut boundary while the cursor kept moving — until the underlying
 * Original endSec had traversed the entire cut interior, at which
 * point the block "leapt" forward.  See RES-0200 for the trace.
 *
 * Fix shape (translation via `cuts.ts`):
 *   editedSnapshot = origToEdited(snapshot.endSec, cuts)
 *   desiredEdited  = editedSnapshot + dxSec
 *   rawEnd         = editedToOrig(desiredEdited, cuts)
 *
 * Clamp axis (see RES-0201 §2 for rationale):
 *   - `minBlockSec` is a UX floor on **visible** clip width, so it applies
 *     on the Edited axis (min visible width, not min Original-frame count).
 *   - `dur` is a physical property of the source video (Original axis) —
 *     its Edited projection is `editedDuration(dur, cuts)`.  We clamp on
 *     the Edited axis using that projection.
 *   - After conversion to Original, a defensive final clamp against
 *     `floor(dur, cs)` catches numerical drift from origToEdited/editedToOrig
 *     round-trips so `entry.endSec > dur` cannot slip through and light
 *     up `entry-warnings.overDuration`.
 *
 * Snap axis (see RES-0201 §3): `buildSnapTargets` now emits Edited-axis
 * `timeSec` values (translated via `origToEdited` when cuts are non-empty)
 * so the snap distance test compares candidate (Edited) against target
 * (Edited) at the same pps that the timeline is rendered at.  The
 * returned `guideTimeSec` is therefore ALSO on the Edited axis — the
 * caller in `timeline-view.tsx` no longer needs to convert.
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
  /**
   * REQ-0201 — current cut list.  Optional so existing call sites and
   * tests that predate the cut feature (or intentionally exercise the
   * no-cut path) continue to compile and behave identically: when
   * `cuts` is undefined or empty, `origToEdited` / `editedToOrig` are
   * the identity and the entire pipeline is bit-identical to its
   * pre-REQ-0201 output.
   */
  cuts?: CutList
}

export interface DragPatchOutput {
  /** Final Original-axis start time to write into the entry. */
  startSec: number
  /** Final Original-axis end time to write into the entry. */
  endSec: number
  /**
   * REQ-0201 — Edited-axis time of the snap target that won, or null.
   * The caller multiplies this by `pixelsPerSec` directly to place the
   * visual guide line; no further `origToEdited` conversion is needed.
   */
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
    cuts = [],
  } = input

  // Edited seconds — dxPx is measured in Edited-axis timeline pixels
  // because the timeline renders on the Edited axis (REQ-074 §1c).
  const dxSec = dxPx / pps

  // Edited-axis ceiling for the drag.  For no-cut cases editedDuration(dur, [])
  // === dur so this collapses to the pre-REQ-0201 `maxEnd` formula.  For
  // cut cases, it correctly bounds the drag by the visible timeline length.
  // REQ-20260613-012: floor to centiseconds so the post-clamp value survives
  // `roundToCs`'s HALF-UP rounding without exceeding the video duration.
  const editedTotalSec = isFinite(dur) && dur > 0
    ? editedDuration(dur, cuts)
    : Number.MAX_VALUE
  const editedMaxEnd = isFinite(editedTotalSec) && editedTotalSec > 0
    ? Math.floor(editedTotalSec * 100) / 100
    : Number.MAX_VALUE
  // Defensive Original-axis ceiling — used as a final clamp so
  // origToEdited/editedToOrig round-trip drift cannot push entry.endSec
  // above the video's physical length.
  const origMaxEnd = isFinite(dur) && dur > 0
    ? Math.floor(dur * 100) / 100
    : Number.MAX_VALUE

  // Snapshot translated to the Edited axis so we can add the Edited-seconds
  // delta directly.  editedToOrig round-trips back to Original for the
  // return value.
  const editedSnapshotStart = origToEdited(snapshot.startSec, cuts)
  const editedSnapshotEnd = origToEdited(snapshot.endSec, cuts)

  // rawStartEdited / rawEndEdited are the Edited-axis values BEFORE snap.
  let rawStartEdited = editedSnapshotStart
  let rawEndEdited = editedSnapshotEnd
  // REQ-100: even when the move drag is in the sub-3-px click-vs-drag
  // dead zone, compute rawStart/rawEnd so the snap guide reflects what
  // WOULD snap if the user moved further.  The previous early-return
  // at this point left snapGuidePx frozen at a stale value.
  let isNoop = false
  if (kind === 'resize-start') {
    const ceiling = editedSnapshotEnd - minBlockSec
    rawStartEdited = Math.min(ceiling, Math.max(0, editedSnapshotStart + dxSec))
  } else if (kind === 'resize-end') {
    const floor = editedSnapshotStart + minBlockSec
    rawEndEdited = Math.max(floor, Math.min(editedMaxEnd, editedSnapshotEnd + dxSec))
  } else {
    // move — note we no longer early-return here.  isNoop is signalled
    // back to the caller so it can skip the entry write.
    if (Math.abs(dxPx) < MOVE_DRAG_NOOP_THRESHOLD_PX) {
      isNoop = true
    }
    const editedDurationOfClip = editedSnapshotEnd - editedSnapshotStart
    const maxStart = Math.max(0, editedMaxEnd - editedDurationOfClip)
    rawStartEdited = Math.min(maxStart, Math.max(0, editedSnapshotStart + dxSec))
    rawEndEdited = rawStartEdited + editedDurationOfClip
  }

  let finalStartEdited = rawStartEdited
  let finalEndEdited = rawEndEdited
  let guideTimeSec: number | null = null
  let guideKind: SnapKind | null = null

  if (snapEnabled) {
    // Grid step is measured in Edited seconds because the ruler renders
    // its tick labels on the Edited axis (§6.2 in specs/timeline.md).
    const totalForGrid =
      isFinite(editedTotalSec) && editedTotalSec > 0
        ? editedTotalSec
        : Math.max(
            10,
            liveEntries.reduce((m, x) => {
              const editedEnd = origToEdited(x.endSec, cuts)
              return editedEnd > m ? editedEnd : m
            }, 0) * 1.2,
          )
    const targets = buildSnapTargets(
      liveEntries,
      draggingEntryId,
      // Playhead comes in on the Original axis (videoCurrentTimeSec).
      // Project to Edited for a consistent comparison.
      origToEdited(playhead, cuts),
      totalForGrid,
      chooseRulerStepSec(pps),
      cuts,
    )
    const snapped = snapInterval(rawStartEdited, rawEndEdited, kind, targets, pps, SNAP_DISTANCE_PX)
    // Re-clamp after snap — snap targets are vetted for proximity, not
    // legality (= within edited timeline, start+min ≤ end).
    finalStartEdited = Math.max(0, Math.min(editedMaxEnd - minBlockSec, snapped.startSec))
    finalEndEdited = Math.max(finalStartEdited + minBlockSec, Math.min(editedMaxEnd, snapped.endSec))
    if (snapped.guide) {
      // guide.timeSec is Edited (buildSnapTargets emits Edited values in
      // this REQ-0201 shape).  Return it as-is; caller multiplies by pps.
      guideTimeSec = snapped.guide.timeSec
      guideKind = snapped.guide.kind
    }
  }

  // Convert back to Original axis for storage.  With cuts=[] this is
  // the identity and the pipeline is bit-identical to pre-REQ-0201.
  let finalStart = editedToOrig(finalStartEdited, cuts)
  let finalEnd = editedToOrig(finalEndEdited, cuts)

  // Round to cs precision so drag output matches the TimeEditorDialog's
  // roundCs confirm path (REQ-059).
  finalStart = roundToCs(finalStart)
  finalEnd = roundToCs(finalEnd)

  // Defensive Original-axis final clamp against the physical video
  // duration.  editedToOrig can produce a value fractionally above dur
  // when snapshot.endSec was already right at the tail and the round-up
  // in roundToCs promotes it above the cs-floor of dur.  Without this
  // clamp entry.endSec > dur trips overDuration in entry-warnings.
  if (finalEnd > origMaxEnd) finalEnd = origMaxEnd
  if (finalStart < 0) finalStart = 0

  return {
    startSec: finalStart,
    endSec: finalEnd,
    guideTimeSec,
    guideKind,
    isNoop,
  }
}
