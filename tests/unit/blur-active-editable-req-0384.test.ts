import { describe, it, expect, afterEach, vi } from 'vitest'
import { blurActiveEditable } from '../../src/renderer/lib/focus'

/**
 * REQ-0384 §B — clicking the timeline playhead-scrub surfaces must release
 * focus from an editable field so Space (play/pause) and Shift+←/→ (frame step)
 * are not swallowed.  `blurActiveEditable` blurs the active element ONLY when it
 * is a text field, leaving buttons and other focusables alone.
 *
 * jsdom is not a dependency, so a minimal fake `document.activeElement` drives
 * the tag-branching logic directly (node env).
 */
type FakeEl = { tagName: string; isContentEditable: boolean; blur: () => void }

function makeEl(tagName: string, isContentEditable = false): FakeEl {
  return { tagName, isContentEditable, blur: vi.fn() }
}

function setActive(el: FakeEl | null): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).document = { activeElement: el }
}

describe('blurActiveEditable (REQ-0384 §B)', () => {
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).document
  })

  it('blurs a focused textarea (the inspector subtitle field)', () => {
    const ta = makeEl('TEXTAREA')
    setActive(ta)
    blurActiveEditable()
    expect(ta.blur).toHaveBeenCalledTimes(1)
  })

  it('blurs a focused input and select', () => {
    const input = makeEl('INPUT')
    setActive(input)
    blurActiveEditable()
    expect(input.blur).toHaveBeenCalledTimes(1)

    const select = makeEl('SELECT')
    setActive(select)
    blurActiveEditable()
    expect(select.blur).toHaveBeenCalledTimes(1)
  })

  it('blurs a focused contentEditable region', () => {
    const div = makeEl('DIV', true)
    setActive(div)
    blurActiveEditable()
    expect(div.blur).toHaveBeenCalledTimes(1)
  })

  it('leaves a focused button alone (clips are buttons; only scrub divs need blur)', () => {
    const btn = makeEl('BUTTON')
    setActive(btn)
    blurActiveEditable()
    expect(btn.blur).not.toHaveBeenCalled()
  })

  it('leaves a plain (non-editable) div alone', () => {
    const div = makeEl('DIV', false)
    setActive(div)
    blurActiveEditable()
    expect(div.blur).not.toHaveBeenCalled()
  })

  it('is a no-op when nothing is focused', () => {
    setActive(null)
    expect(() => blurActiveEditable()).not.toThrow()
  })
})
