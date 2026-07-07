import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useHistoryStore } from '@/stores/history-store'
import { useProjectStore } from '@/stores/project-store'
import { useUiStore, isAnyOverlayOpen } from '@/stores/ui-store'
import {
  deleteEntryById,
  duplicateRow,
  resetRow,
  shouldGlobalShortcutFire,
} from '@/lib/entry-row-actions'
import {
  computeSeekTargetEdited,
  computeZoom,
  TIMELINE_ZOOM_STEP_PX,
} from '@/lib/timeline-nav'
import { editedDuration, editedToOrig } from '../../shared/cuts'

/**
 * REQ-0131 §4.1 / REQ-0132 §4.1 — single capture-phase document
 * `keydown` handler that owns every global editor shortcut.  Same
 * in-house pattern App.tsx's `useSuppressTabFocus` and the preview
 * panels' Space bindings use — no `react-hotkeys-hook` (removed in
 * REQ-0130 due to a duplicate-React runtime crash).
 *
 * REQ-0132 extensions on top of REQ-0131's original branches:
 *   - Ctrl+D duplicates the selected entry (same store call the
 *     inspector's CopyPlus button uses).
 *   - Ctrl+R resets the selected entry.  The `preventDefault()` +
 *     `stopPropagation()` block Chromium's built-in reload keystroke
 *     before the accelerator layer sees it; the main process's
 *     `before-input-event` guard (see `src/main/index.ts`) is the
 *     belt-and-braces backup.
 *   - Arrow keys navigate boundaries + start/end + zoom, but only
 *     while `editorViewMode === 'timeline'`.  In list view the arrow
 *     keys fall through to their native focus-navigation behaviour.
 *   - Esc is intentionally NOT touched by this handler — REQ-0132
 *     §2.2 root-cause fix removed the Dialog/Sheet `onEscapeKeyDown`
 *     preventDefault so Radix's built-in Esc-to-close routes through
 *     each overlay's `onOpenChange(false)` directly.  Adding an Esc
 *     branch here would fire twice.
 *
 * Store reads happen inside the handler so the listener attaches
 * once at mount and does not re-subscribe on every state change.
 */
export function useGlobalShortcuts(): void {
  const { t } = useTranslation(['step2', 'common'])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null
      const overlayOpen = isAnyOverlayOpen(useUiStore.getState())
      // Context filter (A: overlay → bail so overlay handles Esc/Enter;
      // C: typing → bail so field-native keys work).  Only context B / B'
      // proceeds.
      if (
        !shouldGlobalShortcutFire(
          active?.tagName ?? null,
          active?.isContentEditable ?? false,
          overlayOpen,
        )
      ) {
        return
      }

      const { key, ctrlKey, altKey, metaKey, shiftKey } = e

      // Ctrl+Z → Undo.  Bail on Shift so Ctrl+Shift+Z falls through to
      // the Redo branch immediately below.  Alt / Meta bail so browser
      // and OS gestures stay untouched.
      if ((ctrlKey || metaKey) && !altKey && !shiftKey && (key === 'z' || key === 'Z')) {
        useHistoryStore.getState().undo()
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // Redo: Ctrl+Shift+Z OR Ctrl+Y.  Two bindings, one branch — Ctrl+Y
      // is the Windows-native default the owner asked for (REQ-0131 §1.3).
      if (
        (ctrlKey || metaKey) &&
        !altKey &&
        ((shiftKey && (key === 'z' || key === 'Z')) ||
          (!shiftKey && (key === 'y' || key === 'Y')))
      ) {
        useHistoryStore.getState().redo()
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // Ctrl+A / Ctrl+Shift+A — bulk-selection ops on the row-checkbox
      // set.  Ctrl+A selects every entry (deleted or not); the bulk-edit
      // bar itself already handles the deleted-row filter so we pass the
      // full id set through without pre-filtering.  Ctrl+Shift+A clears.
      if ((ctrlKey || metaKey) && !altKey && (key === 'a' || key === 'A')) {
        const ui = useUiStore.getState()
        if (shiftKey) {
          ui.clearRowSelection()
        } else {
          const allIds = new Set(useProjectStore.getState().entries.map((x) => x.id))
          ui.setRowSelection(allIds)
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // Ctrl+D — duplicate the currently-selected entry.  Same store
      // call the inspector's CopyPlus button uses.  Guarded on
      // selection so unselected state is a silent no-op.
      if ((ctrlKey || metaKey) && !altKey && !shiftKey && (key === 'd' || key === 'D')) {
        const selectedId = useUiStore.getState().selectedEntryId
        if (selectedId) {
          const entry = useProjectStore.getState().entries.find((x) => x.id === selectedId)
          if (entry) {
            duplicateRow(entry, {
              history: t('history.duplicateRow', { ns: 'step2' }),
              successToast: t('toast.rowDuplicated', { ns: 'step2' }),
            })
          }
        }
        // Always preventDefault — some browsers use Ctrl+D for "add
        // bookmark" and Electron will happily fire that dialog.
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // Ctrl+R — reset the selected entry.  MUST preventDefault
      // regardless of whether the reset actually fired: Chromium
      // (dev mode) and Electron accelerators both route Ctrl+R to
      // `webContents.reload()`, wiping the entire edit session.  The
      // main-process `before-input-event` guard is the second line of
      // defence; this preventDefault is the first.
      if ((ctrlKey || metaKey) && !altKey && !shiftKey && (key === 'r' || key === 'R')) {
        const selectedId = useUiStore.getState().selectedEntryId
        if (selectedId) {
          const entry = useProjectStore.getState().entries.find((x) => x.id === selectedId)
          if (entry) {
            resetRow(entry, { reset: t('history.resetRow', { ns: 'step2' }) })
          }
        }
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // Delete / Backspace — same soft-delete + history toggle path
      // REQ-0129 / REQ-0130 wired at the timeline surface.  Now works
      // from any screen where a row is selected.
      if (!ctrlKey && !altKey && !metaKey && !shiftKey && (key === 'Delete' || key === 'Backspace')) {
        const currentSelection = useUiStore.getState().selectedEntryId
        if (currentSelection) {
          const fired = deleteEntryById(currentSelection, {
            delete: t('history.deleteRow', { ns: 'step2' }),
            restore: t('history.restoreRow', { ns: 'step2' }),
          })
          if (fired) {
            e.preventDefault()
            e.stopPropagation()
          }
        }
        return
      }

      // REQ-0132 §1.3 — timeline-view-only arrow shortcuts.  Bail out
      // early when the list view is active so the arrows revert to
      // native focus navigation.  Bail on Alt / Meta so future
      // combos remain available; Shift is intentionally ignored (kept
      // for future range-select style semantics if we add them).
      const isTimeline = useUiStore.getState().editorViewMode === 'timeline'
      if (!isTimeline || altKey || metaKey) return

      // Ctrl+← / Ctrl+→ — jump playhead to start / end.
      // Bare ← / → — jump to prev / next block-edge boundary.
      const isArrowLeft = key === 'ArrowLeft'
      const isArrowRight = key === 'ArrowRight'
      if (isArrowLeft || isArrowRight) {
        const proj = useProjectStore.getState()
        if (!proj.video) return
        const editedTotalSec = editedDuration(proj.video.durationSec, proj.cuts)
        const playhead = useUiStore.getState().videoCurrentTimeSec
        const action = ctrlKey
          ? (isArrowLeft ? 'start' : 'end')
          : (isArrowLeft ? 'prev' : 'next')
        const targetEdited = computeSeekTargetEdited(
          action,
          playhead,
          proj.entries,
          proj.cuts,
          editedTotalSec,
        )
        // Convert edited → original for the video element seek — same
        // pattern the timeline's Ruler pointer scrub uses.
        useUiStore.getState().setVideoSeekRequest(editedToOrig(targetEdited, proj.cuts))
        e.preventDefault()
        e.stopPropagation()
        return
      }

      // ↑ / ↓ — zoom in / out on the timeline.  Only fire when Ctrl is
      // NOT held so a future Ctrl+↑↓ combo stays available.
      if (!ctrlKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
        const ui = useUiStore.getState()
        const delta = key === 'ArrowUp' ? TIMELINE_ZOOM_STEP_PX : -TIMELINE_ZOOM_STEP_PX
        ui.setTimelinePixelsPerSec(computeZoom(ui.timelinePixelsPerSec, delta))
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [t])
}
