import { describe, it, expect } from 'vitest'
import {
  shouldGlobalShortcutFire,
  shouldTimelineDeleteFire,
} from '../../src/renderer/lib/entry-row-actions'

/**
 * REQ-0131 §4.3 — `shouldGlobalShortcutFire` implements the 3-context
 * predicate the shared shortcut handler + the preview panels' Space
 * bindings both consume.  It answers "is this keydown allowed to fire
 * as a global shortcut at all?" — the caller then adds a key/modifier
 * check on top.
 *
 *   A: any overlay open        → false  (route to modal's Esc/Enter)
 *   B: neither of the above  → true   (fire the shortcut)
 *   C: typing in a form field → false (native character-input)
 *
 * The existing REQ-0130 tests still guard the DEL/Backspace-specific
 * `shouldTimelineDeleteFire` (extended below with the modal-open
 * parameter so the two predicates stay coherent).
 */

describe('REQ-0131 — shouldGlobalShortcutFire predicate', () => {
  describe('context B — allowed to fire', () => {
    it('returns true when no modal and no focused input', () => {
      expect(shouldGlobalShortcutFire(null, false, false)).toBe(true)
    })

    it.each(['body', 'div', 'BUTTON', 'span', ''])(
      'returns true for non-form focused tag %j',
      (tag) => {
        expect(shouldGlobalShortcutFire(tag, false, false)).toBe(true)
      },
    )
  })

  describe('context A — overlay open suppresses', () => {
    it('returns false when a modal is open, even with no focused input', () => {
      expect(shouldGlobalShortcutFire(null, false, true)).toBe(false)
    })

    it('returns false when a modal is open AND the user is typing', () => {
      expect(shouldGlobalShortcutFire('input', false, true)).toBe(false)
      expect(shouldGlobalShortcutFire('textarea', false, true)).toBe(false)
      expect(shouldGlobalShortcutFire('div', true, true)).toBe(false)
    })
  })

  describe('context C — typing in form field suppresses', () => {
    it.each(['input', 'INPUT', 'textarea', 'TEXTAREA', 'select', 'SELECT'])(
      'returns false when active element is <%s>',
      (tag) => {
        expect(shouldGlobalShortcutFire(tag, false, false)).toBe(false)
      },
    )

    it('returns false for a contentEditable region regardless of tag', () => {
      expect(shouldGlobalShortcutFire('div', true, false)).toBe(false)
      expect(shouldGlobalShortcutFire('span', true, false)).toBe(false)
    })
  })
})

/**
 * REQ-0130 → REQ-0131 extension: `shouldTimelineDeleteFire` now takes
 * an optional `isAnyModalOpen` param that layers on top of the same
 * form-tag + contentEditable rules.  The default (`false`) preserves
 * the REQ-0130 fixtures so the existing test file continues to pass.
 */
const NO_MOD = { ctrl: false, alt: false, meta: false, shift: false }

describe('REQ-0131 — shouldTimelineDeleteFire modal-open extension', () => {
  it('returns true for bare Delete when no modal is open (REQ-0130 baseline)', () => {
    expect(shouldTimelineDeleteFire('Delete', NO_MOD, null, false, false)).toBe(true)
  })

  it('returns false for bare Delete when a modal is open (context A suppresses)', () => {
    expect(shouldTimelineDeleteFire('Delete', NO_MOD, null, false, true)).toBe(false)
    expect(shouldTimelineDeleteFire('Backspace', NO_MOD, null, false, true)).toBe(false)
  })

  it('modal-open guard overrides the "not typing" branch', () => {
    // Body focused (typically "clip delete") but a modal is up → suppress.
    expect(shouldTimelineDeleteFire('Delete', NO_MOD, 'body', false, true)).toBe(false)
  })

  it('the 5th arg defaults to false so old callers keep the original behaviour', () => {
    // 4-arg signature (pre-REQ-0131) still fires when appropriate.
    expect(shouldTimelineDeleteFire('Delete', NO_MOD, null, false)).toBe(true)
  })
})
