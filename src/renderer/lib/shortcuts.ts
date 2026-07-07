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

export type ShortcutContext = 'editor' | 'timeline' | 'modal'

export type ShortcutId =
  | 'playPause'
  | 'undo'
  | 'redo'
  | 'delete'
  | 'selectAll'
  | 'clearSel'
  | 'duplicate'
  | 'reset'
  | 'timelinePrevBoundary'
  | 'timelineNextBoundary'
  | 'timelineStart'
  | 'timelineEnd'
  | 'timelineZoomIn'
  | 'timelineZoomOut'
  | 'modalCancel'
  | 'modalConfirm'

export interface ShortcutSpec {
  id: ShortcutId
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
  // Context B — editor screen, no overlay, focus outside any input.
  { id: 'playPause',   keys: ['Space'],                       labelKey: 'shortcuts.playPause',   context: 'editor' },
  { id: 'undo',        keys: ['Ctrl+Z'],                      labelKey: 'shortcuts.undo',        context: 'editor' },
  // REQ-0139 §2 — one operation, one key.  REQ-0132 listed Ctrl+Y as
  // a Windows-native Redo alias and Backspace as a Delete alias; the
  // Settings tab renders each entry as "Ctrl+Shift+Z / Ctrl+Y", which
  // the owner reported reading as a chorded key.  Ctrl+Shift+Z matches
  // DaVinci Resolve; Delete matches the surrounding delete affordances.
  { id: 'redo',        keys: ['Ctrl+Shift+Z'],                labelKey: 'shortcuts.redo',        context: 'editor' },
  { id: 'delete',      keys: ['Delete'],                      labelKey: 'shortcuts.delete',      context: 'editor' },
  { id: 'duplicate',   keys: ['Ctrl+D'],                      labelKey: 'shortcuts.duplicate',   context: 'editor' },
  { id: 'reset',       keys: ['Ctrl+R'],                      labelKey: 'shortcuts.reset',       context: 'editor' },
  { id: 'selectAll',   keys: ['Ctrl+A'],                      labelKey: 'shortcuts.selectAll',   context: 'editor' },
  { id: 'clearSel',    keys: ['Ctrl+Shift+A'],                labelKey: 'shortcuts.clearSel',    context: 'editor' },
  // Context B' — timeline view active, no overlay, focus outside any
  // input.  In the list view these are inert (native arrow-key focus
  // navigation takes over).
  { id: 'timelinePrevBoundary', keys: ['←'],                  labelKey: 'shortcuts.timelinePrevBoundary', context: 'timeline' },
  { id: 'timelineNextBoundary', keys: ['→'],                  labelKey: 'shortcuts.timelineNextBoundary', context: 'timeline' },
  { id: 'timelineStart',        keys: ['Ctrl+←'],             labelKey: 'shortcuts.timelineStart',        context: 'timeline' },
  { id: 'timelineEnd',          keys: ['Ctrl+→'],             labelKey: 'shortcuts.timelineEnd',          context: 'timeline' },
  { id: 'timelineZoomIn',       keys: ['↑'],                  labelKey: 'shortcuts.timelineZoomIn',       context: 'timeline' },
  { id: 'timelineZoomOut',      keys: ['↓'],                  labelKey: 'shortcuts.timelineZoomOut',      context: 'timeline' },
  // Context A — an overlay (dialog / drawer / modal popover) is open.
  // Global shortcuts are suppressed while in this context; only these
  // two fire and they route to the overlay's own OK / Cancel actions.
  // (Enter=OK is currently wired only inside the color picker; every
  // other overlay accepts Enter as a field-level commit trigger per
  // REQ-0128 / REQ-0132 §2.3.)
  { id: 'modalCancel', keys: ['Esc'],                         labelKey: 'shortcuts.modalCancel', context: 'modal' },
  { id: 'modalConfirm',keys: ['Enter'],                       labelKey: 'shortcuts.modalConfirm',context: 'modal' },
] as const

/**
 * REQ-0132 §1.4 / §4.3 — index the registry by id so tooltip
 * annotations can look up the key strings for a given action without
 * scanning `SHORTCUTS` on every render.  Both the tooltip helper and
 * the Settings > Shortcuts tab consume this — they cannot disagree
 * because both read from the same `SHORTCUTS` source above.
 */
export function findShortcut(id: ShortcutId): ShortcutSpec | undefined {
  return SHORTCUTS.find((s) => s.id === id)
}
