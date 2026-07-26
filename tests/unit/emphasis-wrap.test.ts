import { describe, it, expect } from 'vitest'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'

/**
 * REQ-0306 §2 — the break finder must measure emphasised keywords at their
 * enlarged size so a cue that overflows only because of emphasis actually
 * wraps (pre-REQ-0306 the wrap button reported "no change").  These use the
 * character-class fallback (no font loaded in the test env), the same
 * deterministic width model as overflow-fallback.test.ts.
 *
 * The most important guarantee: cues WITHOUT emphasis wrap byte-identically to
 * before (REQ-0303 Japanese invariant preserved).
 */

describe('REQ-0306 §2 — emphasis-aware auto line break', () => {
  it('a Latin cue that fits at base size wraps once a keyword is enlarged', () => {
    // 300px / outline 0 → effectivePx 280; narrow glyph ≈ 18.99px.
    // "aaaa bbbb cccc" (14 chars) = ~265.9px → fits on one line at base.
    const text = 'aaaa bbbb cccc'
    const base = applyAutoLineBreak(text, 50, 0, 300)
    expect(base).toBe(text)
    expect(base.includes('\\N')).toBe(false)

    // Emphasise "bbbb" at 160% → the extra width tips it over 280 → wraps.
    const emphasised = applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, {
      keywords: ['bbbb'],
      scale: 1.6,
    })
    expect(emphasised.includes('\\N')).toBe(true)
    // No word was split (REQ-0303 word boundaries still respected).
    expect(emphasised.split(/\\N|\s+/).filter(Boolean)).toEqual(['aaaa', 'bbbb', 'cccc'])
  })

  it('emphasis with a non-matching keyword leaves the wrap unchanged', () => {
    const text = 'aaaa bbbb cccc'
    const base = applyAutoLineBreak(text, 50, 0, 300)
    const noMatch = applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, {
      keywords: ['zzzz'],
      scale: 1.6,
    })
    expect(noMatch).toBe(base)
  })

  it('empty keywords / scale ≤ 1 are byte-identical to no emphasis', () => {
    const text = 'aaaa bbbb cccc dddd eeee'
    const plain = applyAutoLineBreak(text, 50, 0, 300)
    expect(applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, { keywords: [], scale: 1.6 })).toBe(plain)
    expect(applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, { keywords: ['bbbb'], scale: 1 })).toBe(plain)
    expect(applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, undefined)).toBe(plain)
  })

  it('Japanese-only cue wrap is unchanged (REQ-0303 invariant preserved)', () => {
    // realistic preset 1920 / outline 3 / fs 50 → 54 wide glyphs per line.
    const text = 'あ'.repeat(60)
    const expected = 'あ'.repeat(54) + '\\N' + 'あ'.repeat(6)
    expect(applyAutoLineBreak(text, 50, 3, 1920)).toBe(expected)
    // Passing emphasis with a keyword that doesn't occur is still identical.
    expect(applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, { keywords: ['x'], scale: 1.5 })).toBe(expected)
  })

  it('a Japanese emphasised keyword shifts the break earlier (emphasis reflected)', () => {
    // 30 wide chars, keyword "あ" everywhere is degenerate; use a distinct
    // emphasised run.  い×54 fits one line at base; emphasise a leading run so
    // the enlarged glyphs overflow sooner and a break appears earlier.
    const text = 'い'.repeat(54)
    const base = applyAutoLineBreak(text, 50, 3, 1920)
    expect(base).toBe(text) // 54 fit exactly, no break at base
    const emph = applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, {
      keywords: ['い'],
      scale: 1.5,
    })
    // Every glyph is now 1.5× → the line overflows and must break.
    expect(emph.includes('\\N')).toBe(true)
  })
})
