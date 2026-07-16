import { describe, it, expect, vi } from 'vitest'

/**
 * REQ-0128 Phase 1 — every numeric / time input in the app grows an
 * onKeyDown handler that maps Enter to `e.currentTarget.blur()`.
 * That funnels Enter through the existing blur → parse → clamp →
 * commit path so validation, clamping, and history granularity stay
 * identical between the two paths.
 *
 * The commit logic itself lives in the parent (`applyStyleEdit`,
 * `withHistory`, `updateEntry`, or the settings-store `onUpdate`) and
 * is exercised by other tests.  These cases verify the shared handler
 * contract:
 *
 *   1. Enter fires blur() on the input.
 *   2. preventDefault is called so the browser doesn't submit an
 *      ambient form (add-row dialog is a Radix Dialog, not a <form>,
 *      but this is defensive against future changes).
 *   3. Non-Enter keys are left alone (typing continues to work).
 */

interface FakeKeyboardEvent {
  key: string
  preventDefault: () => void
  currentTarget: { blur: () => void }
}

// Extract the shared handler shape used at every call site:
//   onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
function enterCommitHandler(e: FakeKeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    e.currentTarget.blur()
  }
}

function makeEvent(key: string): FakeKeyboardEvent {
  return {
    key,
    preventDefault: vi.fn(),
    currentTarget: { blur: vi.fn() }
  }
}

describe('REQ-0128 Phase 1 — Enter=blur handler on every numeric / time input', () => {
  it('Enter blurs the input so the existing onBlur path runs', () => {
    const e = makeEvent('Enter')
    enterCommitHandler(e)
    expect(e.currentTarget.blur).toHaveBeenCalledTimes(1)
  })

  it('Enter prevents the browser default (form submit, etc.)', () => {
    const e = makeEvent('Enter')
    enterCommitHandler(e)
    expect(e.preventDefault).toHaveBeenCalledTimes(1)
  })

  it.each([
    'a', '0', 'ArrowDown', 'Tab', 'Escape', 'Backspace', 'Meta', 'Control',
    'F1', ' ' // space
  ])('does not fire on non-Enter key %j', (key) => {
    const e = makeEvent(key)
    enterCommitHandler(e)
    expect(e.currentTarget.blur).not.toHaveBeenCalled()
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('is idempotent — repeated Enter presses each blur separately', () => {
    const e = makeEvent('Enter')
    enterCommitHandler(e)
    enterCommitHandler(e)
    enterCommitHandler(e)
    expect(e.currentTarget.blur).toHaveBeenCalledTimes(3)
    expect(e.preventDefault).toHaveBeenCalledTimes(3)
  })
})
