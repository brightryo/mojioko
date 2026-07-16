import { buildBoundarySet, findPrevBoundary, findNextBoundary } from './timeline-boundaries'
import { origToEdited, type CutList } from '../../shared/cuts'
import type { SubtitleEntry } from '../../shared/types'
import { TIMELINE_PPS_MIN, TIMELINE_PPS_MAX } from '@/stores/ui-store'

/**
 * REQ-0132 §1.3 — pure helper for timeline arrow-key navigation.
 * Given the playhead position (ORIGINAL axis, matches
 * `<video>.currentTime` and ui-store.videoCurrentTimeSec), the
 * current entries + cuts, and the edited-axis total length, decide
 * where the playhead should jump next.  Returns the target as an
 * EDITED-axis time so the caller can hand it straight into the
 * timeline's `handleSeek` (which does the edited → original
 * conversion on the way to `setVideoSeekRequest`).
 *
 * Clamping is at the boundaries of the edited domain — the actions
 * never wrap around (REQ-0132 §1.3 last bullet).  When no boundary
 * exists on the requested side, the target is the near edge of the
 * timeline (0 for prev, editedTotalSec for next) so the shortcut
 * still moves the playhead somewhere useful.
 */
export function computeSeekTargetEdited(
  action: 'prev' | 'next' | 'start' | 'end',
  playheadOrigSec: number,
  entries: readonly SubtitleEntry[],
  cuts: CutList,
  editedTotalSec: number,
): number {
  if (action === 'start') return 0
  if (action === 'end') return editedTotalSec
  const playheadEdited = origToEdited(playheadOrigSec, cuts)
  const boundaries = buildBoundarySet(entries, cuts)
  if (action === 'prev') {
    const prev = findPrevBoundary(playheadEdited, boundaries)
    return prev !== null ? prev : 0
  }
  const next = findNextBoundary(playheadEdited, boundaries)
  return next !== null ? next : editedTotalSec
}

/**
 * REQ-0132 §1.3 — matches the ZoomIn / ZoomOut button step in
 * `timeline-view.tsx` (`ZOOM_STEP_PX = 10`).  Keeping the constant
 * here + a shared clamp helper means the keyboard shortcut and the
 * button always move in lockstep even if the step is later tuned.
 */
export const TIMELINE_ZOOM_STEP_PX = 10

/**
 * Apply a zoom delta and clamp to [TIMELINE_PPS_MIN, TIMELINE_PPS_MAX].
 * Pure — returns the new value; caller writes it to the store.
 */
export function computeZoom(currentPps: number, deltaPps: number): number {
  return Math.max(TIMELINE_PPS_MIN, Math.min(TIMELINE_PPS_MAX, currentPps + deltaPps))
}
