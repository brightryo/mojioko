import { describe, it, expect } from 'vitest'
import { shouldTimelineDeleteFire } from '../../src/renderer/lib/entry-row-actions'

/**
 * REQ-0130 — the DEL / Backspace keydown guard is a pure predicate so
 * the "typing = character-delete, empty focus = clip-delete" contract
 * is testable without spinning up a React tree.
 *
 * The runtime handler in `timeline-view.tsx` reads
 * `document.activeElement` and `KeyboardEvent` modifiers, hands them
 * to this function, and only intercepts when it returns `true`.  The
 * store-level delete behaviour is exercised by
 * `delete-entry-by-id.test.ts`; this file locks the intercept rule.
 */

const NO_MOD = { ctrl: false, alt: false, meta: false, shift: false }

describe('REQ-0130 — shouldTimelineDeleteFire predicate', () => {
  describe('key filtering', () => {
    it('returns true for Delete with no focused input', () => {
      expect(shouldTimelineDeleteFire('Delete', NO_MOD, null, false)).toBe(true)
    })

    it('returns true for Backspace with no focused input', () => {
      expect(shouldTimelineDeleteFire('Backspace', NO_MOD, null, false)).toBe(true)
    })

    it.each(['a', 'Enter', 'Escape', 'Tab', ' ', 'ArrowDown', 'F1', 'Del', 'BackSpace'])(
      'returns false for non-target key %j',
      (key) => {
        expect(shouldTimelineDeleteFire(key, NO_MOD, null, false)).toBe(false)
      },
    )
  })

  describe('modifier filtering — bare-key only', () => {
    it.each([
      { name: 'Ctrl+Delete', mod: { ...NO_MOD, ctrl: true } },
      { name: 'Alt+Delete', mod: { ...NO_MOD, alt: true } },
      { name: 'Meta+Delete', mod: { ...NO_MOD, meta: true } },
      { name: 'Shift+Delete', mod: { ...NO_MOD, shift: true } },
      { name: 'Ctrl+Backspace', mod: { ...NO_MOD, ctrl: true } },
    ])('returns false for $name so shortcuts stay untouched', ({ mod }) => {
      expect(shouldTimelineDeleteFire('Delete', mod, null, false)).toBe(false)
      expect(shouldTimelineDeleteFire('Backspace', mod, null, false)).toBe(false)
    })
  })

  describe('form-tag guard — typing = character-delete', () => {
    it.each(['input', 'INPUT', 'textarea', 'TEXTAREA', 'select', 'SELECT'])(
      'returns false when active element is <%s>',
      (tag) => {
        expect(shouldTimelineDeleteFire('Delete', NO_MOD, tag, false)).toBe(false)
        expect(shouldTimelineDeleteFire('Backspace', NO_MOD, tag, false)).toBe(false)
      },
    )

    it('returns true when active element is a non-form tag (e.g. body / div / button)', () => {
      for (const tag of ['body', 'div', 'BUTTON', 'span']) {
        expect(shouldTimelineDeleteFire('Delete', NO_MOD, tag, false)).toBe(true)
      }
    })

    it('returns false when active element is contentEditable, regardless of tag', () => {
      expect(shouldTimelineDeleteFire('Delete', NO_MOD, 'div', true)).toBe(false)
      expect(shouldTimelineDeleteFire('Backspace', NO_MOD, 'span', true)).toBe(false)
    })

    it('handles null activeTagName (no focused element) → treats as "not typing"', () => {
      expect(shouldTimelineDeleteFire('Delete', NO_MOD, null, false)).toBe(true)
    })

    it('handles empty string activeTagName → also "not typing"', () => {
      expect(shouldTimelineDeleteFire('Delete', NO_MOD, '', false)).toBe(true)
    })
  })

  describe('combined guards — order-of-checks does not matter', () => {
    it('Ctrl+Delete on a textarea is still false', () => {
      expect(shouldTimelineDeleteFire(
        'Delete',
        { ...NO_MOD, ctrl: true },
        'textarea',
        false,
      )).toBe(false)
    })

    it('Delete on a contentEditable div is false', () => {
      expect(shouldTimelineDeleteFire('Delete', NO_MOD, 'div', true)).toBe(false)
    })
  })
})
