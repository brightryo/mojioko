import type { SubtitleEntry } from '../../shared/types'
import {
  buildSnapTargets,
  snapInterval,
  SNAP_DISTANCE_PX,
  type SnapKind,
} from './timeline-snap'
import { chooseRulerStepSec } from './timeline-layout'
import { roundToCs } from './entry-edits'
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
