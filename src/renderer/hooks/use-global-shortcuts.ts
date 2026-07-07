import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useHistoryStore } from '@/stores/history-store'
import { useProjectStore } from '@/stores/project-store'
import { useUiStore, isAnyModalOpen } from '@/stores/ui-store'
import {
  deleteEntryById,
  shouldGlobalShortcutFire,
} from '@/lib/entry-row-actions'

/**
 * REQ-0131 §4.1 — single capture-phase document `keydown` handler that
 * owns every global editor shortcut (Undo / Redo / Delete / SelectAll /
 * ClearSelection).  Same in-house pattern App.tsx's `useSuppressTabFocus`
 * and the preview panels' Space bindings use — no `react-hotkeys-hook`
 * (removed in REQ-0130 due to a duplicate-React runtime crash).
 *
 * Design notes:
 *   - The predicate (`shouldGlobalShortcutFire`) implements the
 *     REQ-0131 §2 3-context model.  Every branch below runs it first;
 *     modal-cancel / modal-confirm intentionally bypass because they
 *     are context-A shortcuts and are wired at the modal level, not
 *     here.
 *   - Modifier + key dispatch is inline (no registry lookup) so
 *     TypeScript can prove exhaustiveness and the hot-path stays
 *     branch-predictor-friendly.  The Settings > Shortcuts tab reads
 *     from `src/renderer/lib/shortcuts.ts` for its display strings —
 *     the two sources are kept in sync by the unit test in
 *     `tests/unit/shortcuts-registry.test.ts`.
 *   - Store reads happen inside the handler (`useHistoryStore.getState()`,
 *     `useUiStore.getState()`) rather than closure-captured selectors,
 *     so the listener attaches once at mount and does not re-subscribe
 *     every time undo depth or selection changes.  `t()` labels are
 *     resolved inside the handler for the same reason.
 */
export function useGlobalShortcuts(): void {
  const { t } = useTranslation(['step2', 'common'])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null
      const modalOpen = isAnyModalOpen(useUiStore.getState())
      // Context filter (A: modal → bail so modal handles Esc/Enter;
      // C: typing → bail so field-native keys work).  Only context B
      // proceeds.
      if (
        !shouldGlobalShortcutFire(
          active?.tagName ?? null,
          active?.isContentEditable ?? false,
          modalOpen,
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

      // Delete / Backspace — same soft-delete + history toggle path
      // REQ-0129 / REQ-0130 wired at the timeline surface.  The DEL
      // handler previously lived in `timeline-view.tsx`; consolidating
      // here means the shortcut works from any screen where a row is
      // selected (currently just Step 2 — Step 1 has no `selectedEntryId`
      // so `deleteEntryById` no-ops).
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
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [t])
}
