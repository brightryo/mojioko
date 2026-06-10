import type { SubtitleEntry } from '../../shared/types'

/**
 * Snap helper for timeline drag operations.
 *
 * Three categories of snap targets, in priority order:
 *
 *   1. **Playhead** (current videoCurrentTimeSec) — anchors edits to the
 *      moment the user is auditioning. Highest priority.
 *   2. **Neighbour edges** (startSec / endSec of every non-dragging entry,
 *      regardless of track). Lets the user butt two subtitles flush
 *      against each other or align with the start/end of an adjacent
 *      caption.
 *   3. **Ruler grid** (multiples of the current `stepSec` used by the
 *      ruler labels). Coarse alignment for round-number times.
 *
 * Within a category, the nearest candidate within `snapPx` wins; ties
 * are broken arbitrarily but consistently (first match in iteration
 * order — playhead is unique, neighbour edges are scanned in entry-array
 * order, grid is scanned ascending).
 *
 * Self-edges of the entry being dragged are excluded so a resize-start
 * does not "snap to itself" at the moment the cursor is over the start.
 */

export type SnapKind = 'playhead' | 'edge' | 'grid'

export interface SnapTarget {
  /** Snap target time in seconds. */
  timeSec: number
  /** Category — drives the priority order described above. */
  kind: SnapKind
}

export interface SnapResult {
  /** Snapped time in seconds (= one of the targets' timeSec). */
  timeSec: number
  /** Which target won, for an optional visual guide. */
  kind: SnapKind
  /** Distance from the candidate to the snap target, in pixels. */
  distPx: number
}

/**
 * Build the candidate target list for a drag op.
 *
 * `draggingEntryId` is filtered out (we never snap an edge to itself).
 * `videoCurrentTimeSec` of 0 with no video loaded would still be added —
 * callers that want to suppress this should pass a sentinel like
 * `Number.NaN` (the playhead-NaN target is filtered out below).
 */
export function buildSnapTargets(
  entries: readonly SubtitleEntry[],
  draggingEntryId: string,
  videoCurrentTimeSec: number,
  totalSec: number,
  gridStepSec: number
): SnapTarget[] {
  const out: SnapTarget[] = []

  // Playhead — only when finite & non-negative.
  if (isFinite(videoCurrentTimeSec) && videoCurrentTimeSec >= 0) {
    out.push({ timeSec: videoCurrentTimeSec, kind: 'playhead' })
  }

  // Neighbour edges — every non-deleted entry except the dragging one.
  for (const e of entries) {
    if (e.id === draggingEntryId) continue
    if (e.isDeleted) continue
    out.push({ timeSec: e.startSec, kind: 'edge' })
    out.push({ timeSec: e.endSec,   kind: 'edge' })
  }

  // Ruler grid — multiples of gridStepSec from 0 up to totalSec.
  if (gridStepSec > 0 && isFinite(totalSec) && totalSec > 0) {
    for (let s = 0; s <= totalSec + 1e-6; s += gridStepSec) {
      out.push({ timeSec: s, kind: 'grid' })
    }
  }

  return out
}

const KIND_PRIORITY: Record<SnapKind, number> = {
  playhead: 0,
  edge: 1,
  grid: 2
}

/**
 * Return the best snap target for `candidateSec`, or null if no target sits
 * within `snapPx` (at the current zoom) of the candidate.
 *
 * Priority resolution: pick the target whose `kind` priority is lowest
 * (smaller number = higher priority); within the same priority, pick the
 * one with the smallest pixel distance.
 */
export function findBestSnap(
  candidateSec: number,
  targets: readonly SnapTarget[],
  pixelsPerSec: number,
  snapPx: number
): SnapResult | null {
  let best: SnapResult | null = null
  for (const t of targets) {
    const distPx = Math.abs(t.timeSec - candidateSec) * pixelsPerSec
    if (distPx > snapPx) continue
    if (
      best === null ||
      KIND_PRIORITY[t.kind] < KIND_PRIORITY[best.kind] ||
      (KIND_PRIORITY[t.kind] === KIND_PRIORITY[best.kind] && distPx < best.distPx)
    ) {
      best = { timeSec: t.timeSec, kind: t.kind, distPx }
    }
  }
  return best
}

/**
 * Compute the snapped (startSec, endSec) pair for a drag op.
 *
 * - `resize-start` snaps only the start; `endSec` passes through.
 * - `resize-end` snaps only the end; `startSec` passes through.
 * - `move` snaps the edge whose candidate is closer to a target; the
 *   opposite edge follows by the original duration so a body drag keeps
 *   its length even after snapping.
 *
 * Returns the (possibly-snapped) interval along with the guide info so the
 * caller can render a visual indicator. `guide` is null when no snap
 * occurred.
 */
export interface SnappedInterval {
  startSec: number
  endSec: number
  guide: SnapResult | null
}

export function snapInterval(
  rawStartSec: number,
  rawEndSec: number,
  kind: 'resize-start' | 'resize-end' | 'move',
  targets: readonly SnapTarget[],
  pixelsPerSec: number,
  snapPx: number
): SnappedInterval {
  if (kind === 'resize-start') {
    const r = findBestSnap(rawStartSec, targets, pixelsPerSec, snapPx)
    if (!r) return { startSec: rawStartSec, endSec: rawEndSec, guide: null }
    return { startSec: r.timeSec, endSec: rawEndSec, guide: r }
  }
  if (kind === 'resize-end') {
    const r = findBestSnap(rawEndSec, targets, pixelsPerSec, snapPx)
    if (!r) return { startSec: rawStartSec, endSec: rawEndSec, guide: null }
    return { startSec: rawStartSec, endSec: r.timeSec, guide: r }
  }
  // 'move' — pick whichever edge snaps best.
  const rs = findBestSnap(rawStartSec, targets, pixelsPerSec, snapPx)
  const re = findBestSnap(rawEndSec,   targets, pixelsPerSec, snapPx)
  // Choose the one with better priority, tie-broken by smaller distance.
  let pick: 'start' | 'end' | null = null
  if (rs && re) {
    if (KIND_PRIORITY[rs.kind] < KIND_PRIORITY[re.kind]) pick = 'start'
    else if (KIND_PRIORITY[re.kind] < KIND_PRIORITY[rs.kind]) pick = 'end'
    else pick = rs.distPx <= re.distPx ? 'start' : 'end'
  } else if (rs) pick = 'start'
  else if (re)   pick = 'end'

  if (pick === null) {
    return { startSec: rawStartSec, endSec: rawEndSec, guide: null }
  }
  const duration = rawEndSec - rawStartSec
  if (pick === 'start' && rs) {
    return { startSec: rs.timeSec, endSec: rs.timeSec + duration, guide: rs }
  }
  if (pick === 'end' && re) {
    return { startSec: re.timeSec - duration, endSec: re.timeSec, guide: re }
  }
  return { startSec: rawStartSec, endSec: rawEndSec, guide: null }
}

/**
 * Snap target distance window in CSS pixels.
 *
 * REQ-084 #1: bumped from the original 6 px (spec §7.1) to 12 px after
 * the owner reported snap "完全に機能していない".  Investigation found
 * the snap algorithm itself was sound — verified by the 12 unit tests
 * in `tests/unit/timeline-snap.test.ts` — but at the default 50 px/sec
 * zoom the 6 px threshold gave a snap window of only 0.12 sec, which is
 * below typical mouse drag precision.  The user perceived this as "no
 * snap" because the cursor essentially never landed inside the window
 * unless they aimed extremely deliberately.
 *
 * 12 px = 0.24 sec window at default zoom — matches the Premiere /
 * Resolve magnetic-snap convention (~10–12 px) and makes snap usable
 * without feeling sticky.  At maximum zoom (400 px/sec) the window
 * shrinks to 0.03 sec, which is the right behaviour: when zoomed in,
 * the user expects finer control.
 */
export const SNAP_DISTANCE_PX = 12
