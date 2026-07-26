import { describe, expect, it } from 'vitest'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'
import { ASS_MARGIN_LR_PX } from '../../src/shared/constants'

/**
 * REQ-0303 — script-aware auto line break.
 *
 * The pixel budget still decides *how much* fits on a line; REQ-0303 only
 * changes *where* the break lands when the budget would otherwise fall inside
 * a Latin word.  The two headline guarantees are:
 *
 *   1. Latin words are never split at a word-internal position (unless a single
 *      word is longer than a whole line — the unavoidable fallback).
 *   2. Japanese-only text wraps at EXACTLY the same positions as before, so
 *      existing projects look identical (§2, the most important regression).
 *
 * All cases use the character-class fallback (no `font` argument), which is the
 * deterministic width model shared with `overflow-calculator.ts`:
 *   wide (CJK) glyph  = fontSizePx × 0.6906
 *   narrow glyph      = fontSizePx × 0.55 × 0.6906
 * so break indices are exactly predictable without loading opentype.js metrics.
 */

const FALLBACK_LIBASS_SCALE = 0.6906 // mirror of font-metrics.ts

/** Mirror of isWideCp() in auto-line-break.ts / overflow-calculator.ts. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33bf) ||
    (cp >= 0x33ff && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b0ff) ||
    (cp >= 0x1f004 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
}

/**
 * Reference implementation of the PRE-REQ-0303 fallback line-break — pure
 * character-level breaking with no word awareness whatsoever.  Used to pin
 * that Japanese-only text wraps identically after REQ-0303 (§2).
 */
function legacyCharBreak(
  text: string,
  fontSizePx: number,
  outlinePx: number,
  videoWidthPx: number,
): string {
  const eff = videoWidthPx - 2 * ASS_MARGIN_LR_PX - 2 * outlinePx
  return text
    .split('\\N')
    .map((seg) => legacySeg(seg, fontSizePx, eff))
    .join('\\N')
}

function legacySeg(seg: string, fontSizePx: number, eff: number): string {
  if (!seg) return seg
  let cumulative = 0
  let i = 0
  let brk = -1
  for (const ch of seg) {
    const cp = seg.codePointAt(i) ?? 0
    const w = isWide(cp)
      ? fontSizePx * FALLBACK_LIBASS_SCALE
      : fontSizePx * 0.55 * FALLBACK_LIBASS_SCALE
    cumulative += w
    if (cumulative > eff) {
      brk = i
      break
    }
    i += ch.length
  }
  if (brk === -1) return seg
  return seg.slice(0, brk) + '\\N' + legacySeg(seg.slice(brk), fontSizePx, eff)
}

// -----------------------------------------------------------------------
// §2 — Japanese-only text wraps at IDENTICAL positions (the key regression)
// -----------------------------------------------------------------------
describe('REQ-0303 §2 — Japanese-only break positions are unchanged', () => {
  // Realistic preset: 1920px, outline 3, fontSize 50 → effectivePx 1894,
  // 54 wide glyphs per line (54 × 34.53 = 1864.6 ≤ 1894 < 55 × 34.53).
  const FONT = 50
  const OUT = 3
  const W = 1920

  const fixtures: Array<[string, string]> = [
    ['pure hiragana (wraps once)', 'あ'.repeat(60)],
    ['pure hiragana (wraps twice)', 'あ'.repeat(130)],
    [
      'natural kanji + kana sentence long enough to wrap',
      '今日はとてもいい天気ですので公園まで散歩に出かけることにしましたそれからとても静かな午後をゆっくりと過ごしました',
    ],
    ['sentence with full-width punctuation', '「こんにちは、世界」と彼は静かに言った。'.repeat(4)],
  ]

  for (const [label, text] of fixtures) {
    it(`${label}: matches the pre-REQ-0303 character-level break`, () => {
      const actual = applyAutoLineBreak(text, FONT, OUT, W)
      const legacy = legacyCharBreak(text, FONT, OUT, W)
      expect(actual).toBe(legacy)
    })
  }

  it('pins the exact break index for 60 hiragana (break before the 55th char)', () => {
    const text = 'あ'.repeat(60)
    const out = applyAutoLineBreak(text, FONT, OUT, W)
    expect(out).toBe('あ'.repeat(54) + '\\N' + 'あ'.repeat(6))
  })

  it('Japanese with ASCII digits but NO spaces is still unchanged', () => {
    // Digits are WORD_CHARs, but with no whitespace to back off to the break
    // is forced at the pixel position — identical to the legacy behaviour.
    const text = '第2章の内容は約1234文字ほどありますとても長い日本語の説明文がここに続きます'.repeat(3)
    const out = applyAutoLineBreak(text, FONT, OUT, W)
    expect(out).toBe(legacyCharBreak(text, FONT, OUT, W))
  })
})

// -----------------------------------------------------------------------
// §1 — Latin runs break at word boundaries, never mid-word
// -----------------------------------------------------------------------
describe('REQ-0303 §1 — English wraps at word boundaries', () => {
  // Narrow preset for easy math: 300px, outline 0 → effectivePx 280,
  // narrow glyph = 50 × 0.55 × 0.6906 = 18.9915px → 14 glyphs per line.
  const FONT = 50
  const OUT = 0
  const W = 300

  it('never splits a word (all words shorter than one line)', () => {
    const input = 'the quick brown fox jumps over the lazy dog and runs away'
    const out = applyAutoLineBreak(input, FONT, OUT, W)
    expect(out).toContain('\\N') // it actually wrapped

    // Splitting the output on \N *and* whitespace must recover the exact
    // original word sequence — proving no word was cut and none was lost.
    const outWords = out.split(/\\N|\s+/).filter(Boolean)
    expect(outWords).toEqual(input.split(/\s+/))
  })

  it('differs from the legacy character-level break (feature is active)', () => {
    const input = 'the quick brown fox jumps over the lazy dog and runs away'
    const out = applyAutoLineBreak(input, FONT, OUT, W)
    const legacy = legacyCharBreak(input, FONT, OUT, W)
    expect(out).not.toBe(legacy)
    // The legacy break cuts a word — e.g. it puts a \N between two letters.
    const legacyWords = legacy.split(/\\N|\s+/).filter(Boolean)
    expect(legacyWords).not.toEqual(input.split(/\s+/))
  })

  it('does not wrap a short cue that already fits (REQ-0207 word-subtitle)', () => {
    // 2–3 word cues (the English word-subtitle feature) must not gain
    // spurious breaks.  "go home now" at 300px = 11 glyphs = 208.9px ≤ 280.
    const input = 'go home now'
    expect(applyAutoLineBreak(input, FONT, OUT, W)).toBe(input)
  })

  it('the classic "wonder" case is not split into won / der', () => {
    const input = 'I really wonder what happens next here'
    const out = applyAutoLineBreak(input, FONT, OUT, W)
    const lines = out.split('\\N')
    // Every original word survives whole on exactly one line.
    for (const word of input.split(' ')) {
      expect(lines.some((l) => l.split(/\s+/).includes(word))).toBe(true)
    }
  })
})

// -----------------------------------------------------------------------
// §1 exception — a single word longer than a line falls back to mid-word
// -----------------------------------------------------------------------
describe('REQ-0303 §1 exception — over-long word forced-breaks (no overflow)', () => {
  const FONT = 50
  const OUT = 0
  const W = 300 // 14 glyphs per line

  it('a 40-char single word is force-split every 14 chars, losing no chars', () => {
    const input = 'a'.repeat(40)
    const out = applyAutoLineBreak(input, FONT, OUT, W)
    expect(out).toContain('\\N')
    const lines = out.split('\\N')
    // No whitespace exists, so nothing is consumed — all 40 chars survive.
    expect(lines.join('')).toBe(input)
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(14)
    }
  })

  it('a short word is kept whole while a following over-long word is split', () => {
    const input = 'hi supercalifragilisticexpialidocious'
    const out = applyAutoLineBreak(input, FONT, OUT, W)
    // "hi" moves entirely to line 1; the long word is force-split after it.
    expect(out.startsWith('hi\\N')).toBe(true)
    const lines = out.split('\\N')
    expect(lines[0]).toBe('hi')
    // The long word did get internal breaks (it cannot fit one line).
    expect(lines.length).toBeGreaterThan(2)
  })
})

// -----------------------------------------------------------------------
// §1 — mixed Latin + CJK: Latin at word boundaries, CJK at char boundaries
// -----------------------------------------------------------------------
describe('REQ-0303 §1 — mixed Japanese / English', () => {
  const FONT = 50
  const OUT = 3
  const W = 1920 // 54 wide glyphs / line

  it('keeps Latin words whole while allowing CJK to break by character', () => {
    const input =
      'これはとても長い日本語の説明文ですが途中に wonderful english words world も混ざっています'
    const out = applyAutoLineBreak(input, FONT, OUT, W)
    const lines = out.split('\\N')
    // The embedded English words survive intact on a single line each.
    for (const word of ['wonderful', 'english', 'words', 'world']) {
      expect(lines.some((l) => l.includes(word))).toBe(true)
    }
  })
})

// -----------------------------------------------------------------------
// §1 / constraints — manual \N is preserved verbatim
// -----------------------------------------------------------------------
describe('REQ-0303 — manual \\N breaks are preserved', () => {
  it('a manual \\N between short lines is left untouched (nothing overflows)', () => {
    const input = 'Hello\\Nworld'
    expect(applyAutoLineBreak(input, 50, 0, 1920)).toBe(input)
  })

  it('manual \\N is kept and each side is wrapped independently', () => {
    const input = 'short\\Nthe quick brown fox jumps over the lazy dog and runs away'
    const out = applyAutoLineBreak(input, 50, 0, 300)
    // First manual segment untouched, its boundary intact.
    expect(out.startsWith('short\\N')).toBe(true)
    // The whole thing still recovers to the original word list across the
    // manual break + any auto breaks (no word cut anywhere).
    const outWords = out.split(/\\N|\s+/).filter(Boolean)
    const inWords = input.split(/\\N|\s+/).filter(Boolean)
    expect(outWords).toEqual(inWords)
  })
})

// -----------------------------------------------------------------------
// §3 / §6 — preview and burn-in go through the SAME function; result is
// deterministic and stable, so the \N stored at edit time (preview) is the
// exact \N the burn-in pipeline consumes.
// -----------------------------------------------------------------------
describe('REQ-0303 §3 — single-function determinism (preview == burn-in)', () => {
  const cases = [
    'the quick brown fox jumps over the lazy dog and runs away today',
    'これはとても長い日本語の説明文でありテスト用に用意された文章です',
    'mixed これは wonderful text with 日本語 and english words together',
  ]

  it('is deterministic for identical inputs', () => {
    for (const input of cases) {
      const a = applyAutoLineBreak(input, 50, 0, 300)
      const b = applyAutoLineBreak(input, 50, 0, 300)
      expect(a).toBe(b)
    }
  })

  it('is stable when re-run on already-wrapped text (idempotent \\N positions)', () => {
    // The renderer stores the wrapped text in entry.text; the burn-in path
    // measures that same text.  Re-wrapping must not shift any \N.
    for (const input of cases) {
      const once = applyAutoLineBreak(input, 50, 0, 300)
      const twice = applyAutoLineBreak(once, 50, 0, 300)
      expect(twice).toBe(once)
    }
  })
})
