import { describe, it, expect } from 'vitest'
import { shouldFireDialogEnterConfirm } from '../../src/renderer/components/ui/dialog'

/**
 * REQ-0138 §2.2 — pure predicate that decides whether an Enter keydown
 * inside a Dialog should route to the dialog's primary confirm.  The
 * Radix `<DialogContent>` wrapper calls this before invoking
 * `onEnterConfirm`, so the "textarea bail / modifier bail" contract is
 * enforced identically for every dialog that opts in.  Live DOM tests
 * would require a full render tree; keeping the rule pure lets us pin
 * it here without JSDom overhead.
 */

const NO_MOD = { ctrl: false, alt: false, meta: false, shift: false }

describe('REQ-0138 — shouldFireDialogEnterConfirm predicate', () => {
  describe('key gate', () => {
    it('fires on bare Enter with no focused form tag', () => {
      expect(shouldFireDialogEnterConfirm('Enter', NO_MOD, null)).toBe(true)
    })

    it.each(['Escape', 'Tab', 'a', ' ', 'ArrowDown', 'F1'])(
      'does not fire on %j',
      (k) => {
        expect(shouldFireDialogEnterConfirm(k, NO_MOD, null)).toBe(false)
      },
    )
  })

  describe('modifier bail — REQ-0138 §2.2 rule 3', () => {
    it.each([
      { name: 'Ctrl+Enter',  mod: { ...NO_MOD, ctrl: true } },
      { name: 'Alt+Enter',   mod: { ...NO_MOD, alt: true } },
      { name: 'Meta+Enter',  mod: { ...NO_MOD, meta: true } },
      { name: 'Shift+Enter', mod: { ...NO_MOD, shift: true } },
    ])('does not fire on $name (native / newline / future combo)', ({ mod }) => {
      expect(shouldFireDialogEnterConfirm('Enter', mod, null)).toBe(false)
    })
  })

  describe('textarea bail — REQ-0138 §2.2 rule 2', () => {
    it('does not fire when focus is on a textarea (Enter = newline)', () => {
      expect(shouldFireDialogEnterConfirm('Enter', NO_MOD, 'textarea')).toBe(false)
      expect(shouldFireDialogEnterConfirm('Enter', NO_MOD, 'TEXTAREA')).toBe(false)
    })

    it('does fire on Enter inside an <input> — REQ-0128 field commit happens via blur first', () => {
      // Single-line inputs use Enter as a commit trigger (REQ-0128).
      // The DialogContent handler blurs the input BEFORE invoking
      // onEnterConfirm so the field's onBlur commits.  Predicate only
      // decides "was it a valid Enter" — the blur+commit is the
      // handler's responsibility.
      expect(shouldFireDialogEnterConfirm('Enter', NO_MOD, 'input')).toBe(true)
    })

    it('does fire on Enter with body focus (nothing focused)', () => {
      expect(shouldFireDialogEnterConfirm('Enter', NO_MOD, 'body')).toBe(true)
    })

    it('does fire on Enter with focus on a button (Enter would activate; the shared handler overrides)', () => {
      // Native Enter on a focused Button triggers its onClick.  The
      // shared handler still routes to `onEnterConfirm` first
      // (preventDefault stops the native path) so the "primary confirm"
      // always wins.  Consumers who want the focused button's action
      // to differ from the primary confirm should not rely on Enter.
      expect(shouldFireDialogEnterConfirm('Enter', NO_MOD, 'button')).toBe(true)
    })
  })
})
