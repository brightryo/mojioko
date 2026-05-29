/**
 * Single registry of all keyboard shortcuts.
 * Consumed by react-hotkeys-hook for binding and by the cheatsheet dialog for display.
 */

export type ShortcutScope = 'global' | 'step1' | 'step2' | 'step3'

export interface ShortcutDef {
  id: string
  /** Key combo string accepted by react-hotkeys-hook (e.g. "ctrl+k", "ctrl+z") */
  combo: string
  /** Human-readable display string (e.g. "Ctrl+K") */
  display: string
  /** i18n key for the description label (namespace: commands) */
  descriptionKey: string
  scope: ShortcutScope
}

export const SHORTCUTS: ShortcutDef[] = [
  // Global
  { id: 'openCommandPalette', combo: 'ctrl+k', display: 'Ctrl+K', descriptionKey: 'settings.openSettings', scope: 'global' },
  { id: 'openSettings',       combo: 'ctrl+,', display: 'Ctrl+,', descriptionKey: 'settings.openSettings', scope: 'global' },
  { id: 'showShortcuts',      combo: 'ctrl+/', display: 'Ctrl+/', descriptionKey: 'help.showShortcuts',    scope: 'global' },
  { id: 'openVideo',          combo: 'ctrl+o', display: 'Ctrl+O', descriptionKey: 'file.openVideo',        scope: 'global' },
  { id: 'quit',               combo: 'ctrl+q', display: 'Ctrl+Q', descriptionKey: 'navigation.back',       scope: 'global' },

  // Step 1
  { id: 'startTranscription', combo: 'enter', display: 'Enter', descriptionKey: 'edit.addRow', scope: 'step1' },

  // Step 2
  { id: 'undo',               combo: 'ctrl+z',         display: 'Ctrl+Z',       descriptionKey: 'edit.undo',       scope: 'step2' },
  { id: 'redo',               combo: 'ctrl+y',         display: 'Ctrl+Y',       descriptionKey: 'edit.redo',       scope: 'step2' },
  { id: 'redoAlt',            combo: 'ctrl+shift+z',   display: 'Ctrl+Shift+Z', descriptionKey: 'edit.redo',       scope: 'step2' },
  { id: 'exportText',         combo: 'ctrl+s',         display: 'Ctrl+S',       descriptionKey: 'file.exportText', scope: 'step2' },
  { id: 'addRow',             combo: 'ctrl+n',         display: 'Ctrl+N',       descriptionKey: 'edit.addRow',     scope: 'step2' },
  { id: 'deleteRow',          combo: 'delete',         display: 'Delete',       descriptionKey: 'edit.deleteRow',  scope: 'step2' },
  { id: 'resetRow',           combo: 'ctrl+r',         display: 'Ctrl+R',       descriptionKey: 'edit.resetRow',   scope: 'step2' },
]

export function shortcutsByScope(scope: ShortcutScope): ShortcutDef[] {
  return SHORTCUTS.filter((s) => s.scope === scope)
}
