import { describe, it, expect } from 'vitest'
import { SHORTCUTS, findShortcut, type ShortcutId } from '../../src/renderer/lib/shortcuts'
import { shortcutHint } from '../../src/renderer/lib/shortcut-hint'
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

  it('splits into editor / timeline / modal contexts only', () => {
    for (const s of SHORTCUTS) {
      expect(['editor', 'timeline', 'modal']).toContain(s.context)
    }
    const editor = SHORTCUTS.filter((s) => s.context === 'editor').map((s) => s.id)
    const timeline = SHORTCUTS.filter((s) => s.context === 'timeline').map((s) => s.id)
    const modal = SHORTCUTS.filter((s) => s.context === 'modal').map((s) => s.id)
    expect(editor).toContain('undo')
    expect(editor).toContain('redo')
    expect(editor).toContain('delete')
    expect(editor).toContain('selectAll')
    expect(editor).toContain('clearSel')
    expect(editor).toContain('playPause')
    expect(editor).toContain('duplicate')       // REQ-0132 §1.2
    expect(editor).toContain('reset')           // REQ-0132 §1.2
    expect(timeline).toEqual([
      'timelinePrevBoundary',
      'timelineNextBoundary',
      'timelineStart',
      'timelineEnd',
      'timelineZoomIn',
      'timelineZoomOut',
    ])
    expect(modal).toEqual(['modalCancel', 'modalConfirm'])
  })

  it('findShortcut returns the SoT entry by id (REQ-0132 §4.3)', () => {
    expect(findShortcut('duplicate')?.keys).toEqual(['Ctrl+D'])
    expect(findShortcut('reset')?.keys).toEqual(['Ctrl+R'])
    expect(findShortcut('timelinePrevBoundary')?.keys).toEqual(['←'])
    expect(findShortcut('nope' as ShortcutId)).toBeUndefined()
  })

  it('shortcutHint produces a parenthesised suffix for known ids (REQ-0132 §1.4)', () => {
    expect(shortcutHint('duplicate')).toBe(' (Ctrl+D)')
    expect(shortcutHint('reset')).toBe(' (Ctrl+R)')
    expect(shortcutHint('redo')).toBe(' (Ctrl+Shift+Z)') // first key = canonical
    expect(shortcutHint('nope' as ShortcutId)).toBe('')
  })

  it('REQ-0139 §2 — redo has exactly one key: Ctrl+Shift+Z (Ctrl+Y removed)', () => {
    const redo = SHORTCUTS.find((s) => s.id === 'redo')
    expect(redo).toBeDefined()
    expect(redo!.keys).toEqual(['Ctrl+Shift+Z'])
  })

  it('REQ-0139 §2 — delete has exactly one key: Delete (Backspace removed)', () => {
    const del = SHORTCUTS.find((s) => s.id === 'delete')
    expect(del).toBeDefined()
    expect(del!.keys).toEqual(['Delete'])
  })

  it('REQ-0139 §2 — no shortcut anywhere in the registry advertises Backspace or Ctrl+Y', () => {
    // Guard against silent regressions that add these back for a
    // different id.  If a future REQ genuinely wants them, this test
    // is the tripwire that forces a spec update alongside the change.
    for (const s of SHORTCUTS) {
      for (const k of s.keys) {
        expect(k, `${s.id} has forbidden key ${k}`).not.toBe('Backspace')
        expect(k, `${s.id} has forbidden key ${k}`).not.toBe('Ctrl+Y')
      }
    }
  })
})
