import { useProjectStore } from '@/stores/project-store'
import { useUiStore } from '@/stores/ui-store'

/**
 * Side-effect bundle fired after any user-initiated time edit that may have
 * changed the row's chronological position:
 *
 *   1. Re-sort `entries` by `startSec` ascending (stable).
 *   2. Set `selectedEntryId` so the row keeps its green highlight (the
 *      user-selection marker) after the sort moves it.  REQ-20260614-001
 *      Phase 3 — pre-Phase-3 this called `setFocusedRowId`, but after the
 *      split that store slice tracks playback only.  Time-edit is a
 *      user action → user-selection slice is the right target.
 *   3. Fire the one-shot `scrollToRowId` signal so SubtitleTable centres the
 *      row in the viewport after framer-motion's layout animation settles.
 *
 * Callers:
 *   - `step2.tsx` `handleEditorConfirm` (TimeEditorDialog confirm in edit mode)
 *   - `subtitle-table.tsx` SubtitleRow `handleStartChange` / `handleEndChange`
 *     (inline TimeInput commit on blur / Enter)
 *   - `subtitle-table.tsx` SubtitleRow `handleReset` (reset may restore the
 *     original startSec which had been edited away, shifting the row's
 *     sorted position)
 *
 * Uses `getState()` rather than hooks so it can be called from anywhere —
 * event handlers, history undo/redo callbacks, etc.
 */
export function commitTimeEdit(editedId: string): void {
  useProjectStore.getState().sortByStartSec()
  useUiStore.getState().setSelectedEntryId(editedId)
  useUiStore.getState().setScrollToRowId(editedId)
}
