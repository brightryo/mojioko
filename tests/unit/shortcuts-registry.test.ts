import { describe, it, expect } from 'vitest'
import { SHORTCUTS } from '../../src/renderer/lib/shortcuts'
import jaCommon from '../../src/renderer/locales/ja/common.json'
import enCommon from '../../src/renderer/locales/en/common.json'

/**
 * REQ-0131 §4.2 — the shortcut registry is the single source of truth
 * consumed by both the handler (`useGlobalShortcuts`) and the settings
 * tab (`ShortcutsSettingsTab`).  This test pins the invariants that
 * make the SoT trustworthy:
 *
 *   1. Every id is unique.
 *   2. Every `labelKey` resolves in both locales (no missing i18n).
 *   3. `context` splits into the two rendering groups the UI expects.
 *   4. The handler contract stays honest — every editor-context id
 *      that the hook branches on IS present, and the modal-context
 *      ids stay Esc / Enter (the modal-native keys) since consolidating
 *      those into the shared handler would require a separate
 *      routing table that we intentionally left with the modal.
 */

function resolvePath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object' && k in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[k]
    }
    return undefined
  }, obj)
}

describe('REQ-0131 — SHORTCUTS registry', () => {
  it('every id is unique', () => {
    const ids = SHORTCUTS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every labelKey resolves in the ja common namespace', () => {
    for (const s of SHORTCUTS) {
      const v = resolvePath(jaCommon, s.labelKey)
      expect(v, `ja: ${s.labelKey}`).toBeTypeOf('string')
      expect((v as string).length, `ja: ${s.labelKey} non-empty`).toBeGreaterThan(0)
    }
  })

  it('every labelKey resolves in the en common namespace', () => {
    for (const s of SHORTCUTS) {
      const v = resolvePath(enCommon, s.labelKey)
      expect(v, `en: ${s.labelKey}`).toBeTypeOf('string')
      expect((v as string).length, `en: ${s.labelKey} non-empty`).toBeGreaterThan(0)
    }
  })

  it('every entry has at least one key binding string', () => {
    for (const s of SHORTCUTS) {
      expect(s.keys.length, `${s.id} keys`).toBeGreaterThan(0)
      for (const k of s.keys) {
        expect(k.length, `${s.id} key non-empty`).toBeGreaterThan(0)
      }
    }
  })

  it('splits into editor + modal contexts only', () => {
    for (const s of SHORTCUTS) {
      expect(['editor', 'modal']).toContain(s.context)
    }
    const editor = SHORTCUTS.filter((s) => s.context === 'editor').map((s) => s.id)
    const modal = SHORTCUTS.filter((s) => s.context === 'modal').map((s) => s.id)
    expect(editor).toContain('undo')
    expect(editor).toContain('redo')
    expect(editor).toContain('delete')
    expect(editor).toContain('selectAll')
    expect(editor).toContain('clearSel')
    expect(editor).toContain('playPause')
    expect(modal).toEqual(['modalCancel', 'modalConfirm'])
  })

  it('redo advertises both Ctrl+Shift+Z and Ctrl+Y (REQ-0131 §1.3)', () => {
    const redo = SHORTCUTS.find((s) => s.id === 'redo')
    expect(redo).toBeDefined()
    expect(redo!.keys).toEqual(['Ctrl+Shift+Z', 'Ctrl+Y'])
  })

  it('delete advertises both Delete and Backspace (REQ-0129 / §1.4)', () => {
    const del = SHORTCUTS.find((s) => s.id === 'delete')
    expect(del).toBeDefined()
    expect(del!.keys).toEqual(['Delete', 'Backspace'])
  })
})
