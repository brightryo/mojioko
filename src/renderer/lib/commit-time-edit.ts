import { useProjectStore } from '@/stores/project-store'
import { useUiStore } from '@/stores/ui-store'

/**
 * Side-effect bundle fired after any user-initiated time edit that may have
 * changed the row's chronological position:
 *
 *   1. Re-sort `entries` by `startSec` ascending (stable).
 *   2. Set `focusedRowId` so the row keeps its green highlight after the
 *      sort moves it.
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
  useUiStore.getState().setFocusedRowId(editedId)
  useUiStore.getState().setScrollToRowId(editedId)
}
