import { describe, it, expect } from 'vitest'
import {
  substituteMissingGlyphs,
  pickTofuSubstitute,
  TOFU_PREFERRED_CODE_POINT,
  TOFU_CANDIDATE_CODE_POINTS,
} from '../../src/shared/glyph-substitute'

/**
 * REQ-0160 — pin the tofu-substitution rules that keep libass rendering
 * and the preview / auto-line-break measurement aligned.  Tests are
 * grouped by the invariant they protect:
 *
 *   1. JA font + JA text — NO substitution ever (the top-priority
 *      regression guard from REQ §3).
 *   2. EN-only font + JP text — substitution fires per missing
 *      code point (the bug this REQ fixes).
 *   3. Control characters, spaces, `\N` — never substituted.
 *   4. Reference-equality fast-path — unchanged strings return
 *      the same reference (drives React memo skip).
 *   5. `pickTofuSubstitute` picks the right candidate for the fonts
 *      whose Step 0 probe results REQ-0160 pinned.
 */

// Helper — build a cmap coverage set from a plain list of code points.
function coverage(codePoints: number[]): Set<number> {
  return new Set(codePoints)
}

// ---------------------------------------------------------------------------
// (1) JA font + JA text — the top-priority regression guard
// ---------------------------------------------------------------------------

describe('substituteMissingGlyphs — JA font + JA text (top regression guard)', () => {
  // Noto Sans JP declares Hiragana, Katakana, common Kanji, ASCII, and
  // U+25A1.  A representative subset is enough to prove the fast-path
  // "everything is covered" branch keeps the text byte-identical.
  const notoCoverage = coverage([
    0x3042, 0x3044, 0x3046, // あいう
    0x30A2, 0x30A4, 0x30A6, // アイウ
    0x65E5, 0x672C,          // 日本
    0x4E00,                  // 一
    0x3001, 0x3002,          // 、。
    0x0041, 0x0061, 0x0030, 0x0039, // Aa09
    0x0020,                  // space
    0x0057, 0x0068, 0x0079,  // Why (just some ASCII)
    0x25A1,                  // □ (the substitute itself)
  ])

  it('returns byte-identical text for pure Japanese sentence', () => {
    const text = 'こんにちは日本'
    // Extend coverage with the specific chars in the test
    const cov = new Set([...notoCoverage, ...text].map((x) => typeof x === 'number' ? x : x.codePointAt(0)!))
    expect(substituteMissingGlyphs(text, cov, '□')).toBe(text)
  })

  it('returns byte-identical text for mixed JP + ASCII (Noto includes Latin subset)', () => {
    const text = 'ABC あいう 123'
    const cov = new Set([...notoCoverage, ...text].map((x) => typeof x === 'number' ? x : x.codePointAt(0)!))
    expect(substituteMissingGlyphs(text, cov, '□')).toBe(text)
  })

  it('returns THE SAME REFERENCE for fully covered text (React memo fast-path)', () => {
    const text = 'あいう'
    const cov = coverage([0x3042, 0x3044, 0x3046])
    // Same reference — not just deep-equal — so upstream `useMemo` /
    // `React.memo` comparators skip re-renders on the JA-only path.
    expect(substituteMissingGlyphs(text, cov, '□')).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// (2) EN-only font + JP text — the scenario REQ-0160 fixes
// ---------------------------------------------------------------------------

describe('substituteMissingGlyphs — EN-only font + JP text (REQ-0160 target)', () => {
  // A stub Anton-style coverage: basic ASCII + U+25A1 + Latin
  // Extended-A, but NO CJK code points.
  const antonCoverage = coverage([
    ...Array.from({ length: 95 }, (_, i) => 0x20 + i), // U+0020 – U+007E
    0x25A1, // □
  ])

  it('replaces every JP code point with the tofu substitute', () => {
    const text = 'Hello 世界'
    // 'H','e','l','l','o',' ' pass; '世','界' → □□
    expect(substituteMissingGlyphs(text, antonCoverage, '□')).toBe('Hello □□')
  })

  it('mixes tofu and passthrough in a single line', () => {
    const text = 'ABC あ DEF い GHI'
    expect(substituteMissingGlyphs(text, antonCoverage, '□')).toBe('ABC □ DEF □ GHI')
  })

  it('honours a font-specific tofu substitute (e.g. Bebas Neue picks ?)', () => {
    const bebasCoverage = coverage([
      ...Array.from({ length: 95 }, (_, i) => 0x20 + i), // basic ASCII only
      // no U+25A1
    ])
    const text = 'Bebas あ Neue'
    expect(substituteMissingGlyphs(text, bebasCoverage, '?')).toBe('Bebas ? Neue')
  })

  it('handles supplementary-plane code points (surrogate pair rare Kanji)', () => {
    // 𠮷 (U+20BB7) is a supplementary-plane code point often used in
    // Japanese proper nouns.  substituteMissingGlyphs iterates by
    // code point (`for-of`), so it treats the surrogate pair as one
    // character and substitutes exactly once.
    const text = 'X𠮷Y'
    expect(substituteMissingGlyphs(text, antonCoverage, '□')).toBe('X□Y')
  })
})

// ---------------------------------------------------------------------------
// (3) Control chars / space / `\N` — never substituted
// ---------------------------------------------------------------------------

describe('substituteMissingGlyphs — control chars and structural markers preserved', () => {
  // A degenerate "font" whose coverage is empty — every character
  // becomes a candidate for substitution.  Anything that comes
  // through unchanged proves the character was skipped.
  const emptyCoverage = coverage([])

  it('preserves ASCII space even if not in coverage', () => {
    expect(substituteMissingGlyphs('a b', emptyCoverage, '□')).toBe('□ □')
  })

  it('preserves ASCII control characters even if not in coverage', () => {
    // U+000A LF, U+0009 TAB.  ASS `\N` is stripped to `\n` upstream
    // (in overflow-calculator / SubtitleOverlay); this test guards
    // that the LF character itself is not tofu'd.
    expect(substituteMissingGlyphs('a\nb\tc', emptyCoverage, '□')).toBe('□\n□\t□')
  })

  it('preserves the literal ASS `\\N` marker (backslash + N are ASCII)', () => {
    // With basic ASCII coverage (which every registered font has),
    // the literal two characters `\` and `N` pass through unchanged.
    const asciiCoverage = coverage(Array.from({ length: 95 }, (_, i) => 0x20 + i))
    expect(substituteMissingGlyphs('foo\\Nbar', asciiCoverage, '□')).toBe('foo\\Nbar')
  })
})

// ---------------------------------------------------------------------------
// (4) `pickTofuSubstitute` per-font picker
// ---------------------------------------------------------------------------

describe('pickTofuSubstitute — per-font tofu selection', () => {
  it('picks U+25A1 when the font has it (default case, 10/13 fonts)', () => {
    const cov = coverage([TOFU_PREFERRED_CODE_POINT, 0x0041])
    expect(pickTofuSubstitute(cov)).toBe('□')
  })

  it('picks U+FFFD when U+25A1 is missing but U+FFFD is present (Mochiy Pop One case)', () => {
    // Simulate the Step 0 probe result for Mochiy Pop One:
    // U+25A1 absent, U+FFFD present.
    const cov = coverage([0xFFFD, 0x0041])
    expect(pickTofuSubstitute(cov)).toBe('�')
  })

  it('picks U+003F "?" as the guaranteed fallback (Bebas Neue / Poppins case)', () => {
    // Bebas Neue + Poppins have NONE of the first seven candidates.
    // Basic ASCII is the last-resort lifeline.
    const cov = coverage([0x003F, 0x0041, 0x0042])
    expect(pickTofuSubstitute(cov)).toBe('?')
  })

  it('picks candidates in the documented priority order', () => {
    // If BOTH U+25A1 and U+FFFD are in coverage, U+25A1 wins.
    const cov = coverage([0x25A1, 0xFFFD])
    expect(pickTofuSubstitute(cov)).toBe('□')
    // If U+FFFD present but not U+25A1, and U+2610 also present,
    // U+2610 still comes before U+FFFD in the candidate list — pin
    // that priority.
    const cov2 = coverage([0xFFFD, 0x2610])
    expect(pickTofuSubstitute(cov2)).toBe('☐')
  })

  it('falls back to "?" when NONE of the candidates are covered', () => {
    // Very rare theoretical case — every registered font declares
    // basic ASCII, so this branch is unreachable in practice.  Pin
    // the safe-default behaviour anyway.
    expect(pickTofuSubstitute(coverage([0x3042]))).toBe('?')
  })

  it('candidate list has the exact size and preferred head expected by Step 0 probe', () => {
    // Regression guard for the ordering.  If a future edit reshuffles
    // candidates or drops one, this test flags it.
    expect(TOFU_CANDIDATE_CODE_POINTS.length).toBe(8)
    expect(TOFU_CANDIDATE_CODE_POINTS[0]).toBe(TOFU_PREFERRED_CODE_POINT)
    expect(TOFU_CANDIDATE_CODE_POINTS[TOFU_CANDIDATE_CODE_POINTS.length - 1]).toBe(0x003F)
  })
})
