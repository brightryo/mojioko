/**
 * REQ-0131 §4.2 — single source of truth for global keyboard shortcuts.
 *
 * The (a) `useGlobalShortcuts` hook that fires them and (b) the Settings >
 * Shortcuts tab that lists them both read from this registry, so the
 * displayed key and the actual behaviour can never drift.
 *
 * `context` splits the shortcuts into the two rendering groups the
 * Settings tab uses ("editor" = context B, "modal" = context A per
 * REQ-0131 §2).  Context C (typing in a form field) never fires any
 * global shortcut; that's a filter applied by the handler, not a
 * separate group here.
 *
 * `labelKey` points into `common.shortcuts.*` for the operation label.
 * Key strings are UI-only (Ctrl+Z / Ctrl+Shift+Z / etc.); the runtime
 * matches against a normalised `KeyboardEvent` shape in the handler.
 */

export type ShortcutContext = 'editor' | 'modal'

export interface ShortcutSpec {
  id: string
  /** UI-facing key strings shown in the Settings tab.  One key spec per
   *  legitimate binding — e.g. Undo has one entry ("Ctrl+Z"), Redo has
   *  two ("Ctrl+Shift+Z" and "Ctrl+Y" per REQ-0131 §1.3). */
  keys: string[]
  labelKey: string
  context: ShortcutContext
}

/**
 * Registry order = display order in the Settings tab.  Groups by
 * `context` when the tab renders; within a group the order below is
 * preserved so the most frequent operations (Space / Undo / Delete)
 * land at the top.
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  // Context B — editor screen, no modal, focus outside any input.
  { id: 'playPause',   keys: ['Space'],                       labelKey: 'shortcuts.playPause',   context: 'editor' },
  { id: 'undo',        keys: ['Ctrl+Z'],                      labelKey: 'shortcuts.undo',        context: 'editor' },
  { id: 'redo',        keys: ['Ctrl+Shift+Z', 'Ctrl+Y'],      labelKey: 'shortcuts.redo',        context: 'editor' },
  { id: 'delete',      keys: ['Delete', 'Backspace'],         labelKey: 'shortcuts.delete',      context: 'editor' },
  { id: 'selectAll',   keys: ['Ctrl+A'],                      labelKey: 'shortcuts.selectAll',   context: 'editor' },
  { id: 'clearSel',    keys: ['Ctrl+Shift+A'],                labelKey: 'shortcuts.clearSel',    context: 'editor' },
  // Context A — a modal is open.  Global shortcuts are suppressed while
  // in this context; only these two fire and they route to the modal's
  // own OK / Cancel actions.
  { id: 'modalCancel', keys: ['Esc'],                         labelKey: 'shortcuts.modalCancel', context: 'modal' },
  { id: 'modalConfirm',keys: ['Enter'],                       labelKey: 'shortcuts.modalConfirm',context: 'modal' },
] as const
