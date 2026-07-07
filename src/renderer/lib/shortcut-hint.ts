import { findShortcut, type ShortcutId } from './shortcuts'

/**
 * REQ-0132 §1.4 / §4.3 — return the primary key string for a shortcut
 * id, wrapped in parentheses ready for tooltip suffixing.  The first
 * key in the SoT is the "primary" (e.g. `Ctrl+Shift+Z` for Redo, not
 * the equivalent `Ctrl+Y`) because the SoT lists the canonical binding
 * first.  Returns an empty string when the id is not registered so
 * callers can unconditionally concatenate.
 *
 * Callers use the pattern:
 *   title={`${t('action.duplicateRowHelp')}${shortcutHint('duplicate')}`}
 *
 * The tooltip becomes e.g. "Duplicate row (Ctrl+D)".  Localisation
 * lives in the base label; the shortcut suffix is intentionally
 * language-agnostic (keyboards emit the same key names in every
 * locale).
 */
export function shortcutHint(id: ShortcutId): string {
  const spec = findShortcut(id)
  if (!spec || spec.keys.length === 0) return ''
  return ` (${spec.keys[0]})`
}
