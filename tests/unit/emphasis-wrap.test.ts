import { describe, it, expect } from 'vitest'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'
import { computeOverflowSync } from '../../src/renderer/lib/overflow-calculator'
import {
  resolveEmphasisRanges,
  mapRangesAcrossBreakCollapse,
  type EmphasisRange,
} from '../../src/shared/emphasis'

/**
 * REQ-0306 §2 (kept live by REQ-0307) — the break finder must measure
 * emphasised text at its enlarged size so a cue that overflows only because of
 * emphasis actually wraps (pre-REQ-0306 the wrap button reported "no change").
 * These use the character-class fallback (no font loaded in the test env), the
 * same deterministic width model as overflow-fallback.test.ts.
 *
 * REQ-0307 moved range resolution out of the measurement helpers and into
 * `shared/emphasis.ts`, so these tests now feed ranges directly — which also
 * documents the coordinate contract (ORIGINAL text, `\N` = two code units).
 *
 * The most important guarantee: cues WITHOUT emphasis wrap byte-identically to
 * before (REQ-0303 Japanese invariant preserved).
 */

/** Ranges for every occurrence of `needle` — a test shorthand, not app code. */
function rangesOf(text: string, needle: string): EmphasisRange[] {
  const out: EmphasisRange[] = []
  let from = 0
  for (;;) {
    const i = text.indexOf(needle, from)
    if (i === -1) break
    out.push([i, i + needle.length])
    from = i + needle.length
  }
  return out
}

describe('REQ-0306 §2 / REQ-0307 — emphasis-aware auto line break', () => {
  it('a Latin cue that fits at base size wraps once a span is enlarged', () => {
    // 300px / outline 0 → effectivePx 280; narrow glyph ≈ 18.99px.
    // "aaaa bbbb cccc" (14 chars) = ~265.9px → fits on one line at base.
    const text = 'aaaa bbbb cccc'
    const base = applyAutoLineBreak(text, 50, 0, 300)
    expect(base).toBe(text)
    expect(base.includes('\\N')).toBe(false)

    // Emphasise "bbbb" at 160% → the extra width tips it over 280 → wraps.
    const emphasised = applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, {
      ranges: rangesOf(text, 'bbbb'),
      scale: 1.6,
    })
    expect(emphasised.includes('\\N')).toBe(true)
    // No word was split (REQ-0303 word boundaries still respected).
    expect(emphasised.split(/\\N|\s+/).filter(Boolean)).toEqual(['aaaa', 'bbbb', 'cccc'])
  })

  it('empty ranges / scale ≤ 1 are byte-identical to no emphasis', () => {
    const text = 'aaaa bbbb cccc dddd eeee'
    const plain = applyAutoLineBreak(text, 50, 0, 300)
    expect(applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, { ranges: [], scale: 1.6 })).toBe(plain)
    expect(
      applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, { ranges: rangesOf(text, 'bbbb'), scale: 1 }),
    ).toBe(plain)
    expect(applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, undefined)).toBe(plain)
  })

  it('Japanese-only cue wrap is unchanged (REQ-0303 invariant preserved)', () => {
    // realistic preset 1920 / outline 3 / fs 50 → 54 wide glyphs per line.
    const text = 'あ'.repeat(60)
    const expected = 'あ'.repeat(54) + '\\N' + 'あ'.repeat(6)
    expect(applyAutoLineBreak(text, 50, 3, 1920)).toBe(expected)
    // Passing an emphasis descriptor with no surviving range is still identical.
    expect(applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, { ranges: [], scale: 1.5 })).toBe(expected)
  })

  it('an emphasised Japanese run shifts the break earlier (emphasis reflected)', () => {
    const text = 'い'.repeat(54)
    const base = applyAutoLineBreak(text, 50, 3, 1920)
    expect(base).toBe(text) // 54 fit exactly, no break at base
    const emph = applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, {
      ranges: [[0, 54]],
      scale: 1.5,
    })
    // Every glyph is now 1.5× → the line overflows and must break.
    expect(emph.includes('\\N')).toBe(true)
  })

  it('REQ-0307 — ranges use ORIGINAL-text coordinates across a `\\N`', () => {
    // The cue already has a hard break.  A span on line 2 must inflate line 2's
    // glyphs, NOT line 1's — i.e. the `\N` offset must be honoured.  Line 1 is
    // deliberately left just under the budget so any leakage would show up as a
    // spurious break on line 1.
    const text = 'aaaa aaaa\\Nbbbb bbbb'
    expect(applyAutoLineBreak(text, 50, 0, 300)).toBe(text)
    const line2Start = text.indexOf('\\N') + 2
    const wrapped = applyAutoLineBreak(text, 50, 0, 300, undefined, undefined, {
      ranges: [[line2Start, text.length]],
      scale: 2,
    })
    const [line1, ...rest] = wrapped.split('\\N')
    expect(line1).toBe('aaaa aaaa')       // untouched
    expect(rest.join('\\N')).not.toBe('bbbb bbbb')  // line 2 wrapped
  })
})

describe('REQ-0307 — overflow measurement maps ranges across `\\N` collapse', () => {
  it('an emphasised span on line 2 is measured on line 2, not line 1', () => {
    // computeOverflowSync measures `text.replace(/\\N/g, '\n')`, so a stored
    // offset drifts by one per preceding break unless it is re-mapped.  With a
    // huge scale the emphasised line must be the one flagged.
    const text = 'ああああ\\Nいいいい'
    const line2Start = text.indexOf('\\N') + 2
    const r = computeOverflowSync({
      text,
      fontFamily: 'MOJIOKO Noto Sans JP',
      fontSizePx: 50,
      outlineThicknessPx: 0,
      videoWidthPx: 300,
      emphasisRanges: [[line2Start, text.length]],
      emphasisScale: 4,
    })
    // The reported index is into the NORMALISED text ("ああああ\nいいいい"):
    // line 1 (4 wide glyphs ≈ 138px) fits in 280px, so the first overflow must
    // land on line 2, i.e. at or after the newline at index 4.
    expect(r.overflowStartIndex).toBeGreaterThan(4)
  })

  it('with no emphasis the same cue does not overflow at all', () => {
    const r = computeOverflowSync({
      text: 'ああああ\\Nいいいい',
      fontFamily: 'MOJIOKO Noto Sans JP',
      fontSizePx: 50,
      outlineThicknessPx: 0,
      videoWidthPx: 300,
    })
    expect(r.overflowStartIndex).toBe(-1)
  })
})

describe('REQ-0307 — mapRangesAcrossBreakCollapse', () => {
  const text = 'abc\\Ndef\\Nghi'

  it('shifts by one per preceding break when `\\N` → "\\n" (overflow path)', () => {
    // "ghi" sits at 10 in the original, 8 in the normalised string.
    expect(mapRangesAcrossBreakCollapse(text, [[10, 13]], 1)).toEqual([[8, 11]])
    // "abc" precedes every break, so it is untouched.
    expect(mapRangesAcrossBreakCollapse(text, [[0, 3]], 1)).toEqual([[0, 3]])
  })

  it('shifts by two per preceding break when `\\N` → "" (pack-wrap path)', () => {
    expect(mapRangesAcrossBreakCollapse(text, [[10, 13]], 0)).toEqual([[6, 9]])
    expect(mapRangesAcrossBreakCollapse(text, [[5, 8]], 0)).toEqual([[3, 6]])
  })

  it('is a no-op on text with no breaks, and on an empty range list', () => {
    expect(mapRangesAcrossBreakCollapse('abcdef', [[2, 4]], 1)).toEqual([[2, 4]])
    expect(mapRangesAcrossBreakCollapse(text, [], 1)).toEqual([])
  })
})

describe('REQ-0307 §3 — width measurement needs no `words`', () => {
  it('resolveEmphasisRanges works off spans alone, on an edited cue', () => {
    // `words` deliberately disagrees with `text` (the user fixed a mis-hearing).
    const ranges = resolveEmphasisRanges({
      text: 'the quick brown fox',
      emphasisSpans: [{ start: 4, end: 9, text: 'quick' }],
      words: [{ startSec: 0, endSec: 1, text: 'the sick brown fox' }],
    })
    expect(ranges).toEqual([[4, 9]])
  })
})
