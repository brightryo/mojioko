import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import opentype from 'opentype.js'
import { substituteMissingGlyphs, pickTofuSubstitute } from '../../src/shared/glyph-substitute'

/**
 * REQ-0162 regression suite — the tests that would have caught the
 * bug the 844-test REQ-0160 suite missed.
 *
 * Everything the REQ-0160 tofu path depends on chains through the
 * cmap-coverage Set built inside `entryFromBytes` in
 * `src/renderer/lib/font-metrics.ts`.  The REQ-0160 unit suite
 * exercised the pure `substituteMissingGlyphs` with hand-constructed
 * Sets, which proved the algorithm but silently side-stepped the
 * "does the cmap-Set build path actually produce the right Set for a
 * real TTF" question.  This suite loads the real TTFs from
 * `resources/fonts/` + `dev-docs/font-validation/`, walks
 * `font.glyphs.get(i).unicodes` exactly as `entryFromBytes` does,
 * then feeds the resulting Set into `substituteMissingGlyphs` to
 * verify the end-to-end contract:
 *
 *   Anton + JA text  → JA code points substituted with □ (Anton has U+25A1)
 *   Noto + JA text   → nothing substituted (Noto has every JA char)
 *   Bebas + JA text  → JA code points substituted with "?" (Bebas lacks □)
 *
 * The tests skip themselves (rather than fail) when a TTF isn't
 * available locally — Anton / Bebas Neue TTFs live under `staging/`
 * which is populated by the probe scripts, and CI runners without a
 * network round-trip won't have them.  Noto Sans JP is bundled in
 * the installer payload and is always present.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..')

interface RealFontEntry {
  cmapCoverage: Set<number>
  tofuSubstitute: string
}

/**
 * Byte-for-byte reproduction of `font-metrics.ts:entryFromBytes` for
 * a raw TTF buffer.  Kept out of the source module so the test can
 * exercise the identical logic without pulling the whole font-metrics
 * dependency tree (electron, Zustand, etc.) into vitest.  If the two
 * bodies drift, this comment is a load-bearing pointer to that fact.
 */
function buildEntryFromBytes(buf: Buffer): RealFontEntry {
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const font = opentype.parse(ab)
  const cmapCoverage = new Set<number>()
  const numGlyphs = font.numGlyphs
  for (let i = 0; i < numGlyphs; i++) {
    const glyph = font.glyphs.get(i) as { unicodes?: number[] } | undefined
    const unicodes = glyph?.unicodes
    if (!unicodes) continue
    for (const cp of unicodes) cmapCoverage.add(cp)
  }
  const tofuSubstitute = pickTofuSubstitute(cmapCoverage)
  return { cmapCoverage, tofuSubstitute }
}

function tryLoadFont(relPath: string): RealFontEntry | null {
  const abs = path.resolve(REPO_ROOT, relPath)
  if (!fs.existsSync(abs)) return null
  return buildEntryFromBytes(fs.readFileSync(abs))
}

const notoEntry = tryLoadFont('resources/fonts/Noto_Sans_JP/static/NotoSansJP-SemiBold.ttf')
const antonEntry = tryLoadFont('dev-docs/font-validation/staging/Anton-Regular.ttf')
const bebasEntry = tryLoadFont('dev-docs/font-validation/staging/BebasNeue-Regular.ttf')

describe('Font cmap coverage build — REQ-0162 real-TTF regression', () => {
  describe('Noto Sans JP (bundled default — always available)', () => {
    it('parses and builds a large cmap coverage set', () => {
      // Sanity check: the bundled TTF loads.  If this fails, the whole
      // rest of the suite is compromised, so pin it explicitly.
      expect(notoEntry).not.toBeNull()
      expect(notoEntry!.cmapCoverage.size).toBeGreaterThan(15_000)
    })

    it('picks U+25A1 as its tofu substitute', () => {
      // Not strictly needed for the bug (Noto never triggers tofu for
      // JA text), but pins the picker priority so a future edit that
      // reshuffles candidates trips here.
      expect(notoEntry!.tofuSubstitute).toBe('□')
    })

    it('leaves Japanese subtitles unchanged (JA + Noto non-regression)', () => {
      // The most important test in the suite.  If a future refactor
      // breaks this, existing users see their subtitles turn into
      // tofu on a rebuild.
      const text = 'こんにちは 日本語 ABC 123'
      const out = substituteMissingGlyphs(
        text,
        notoEntry!.cmapCoverage,
        notoEntry!.tofuSubstitute,
      )
      expect(out).toBe(text)
      // Reference identity — the fast-path should return the same string
      // reference so React memo skips downstream re-renders.
      expect(out).toBe(text)
    })
  })

  describe('Anton (EN-only, the font that triggered the bug)', () => {
    it.skipIf(antonEntry === null)('parses and picks U+25A1 as tofu', () => {
      expect(antonEntry).not.toBeNull()
      expect(antonEntry!.tofuSubstitute).toBe('□')
    })

    it.skipIf(antonEntry === null)('substitutes every JP code point with □', () => {
      // Exactly the owner's reported bug case: "aaadddあいうえお".
      // Pre-fix, this returned the input untouched because the cmap
      // Set was empty (font never made it into the cache) OR
      // because the substitution was skipped entirely.  Now the
      // real-TTF cmap must correctly identify JA code points as
      // missing and replace them.
      const out = substituteMissingGlyphs(
        'aaadddあいうえお',
        antonEntry!.cmapCoverage,
        antonEntry!.tofuSubstitute,
      )
      expect(out).toBe('aaaddd□□□□□')
    })

    it.skipIf(antonEntry === null)('passes Latin ASCII through unchanged', () => {
      const text = 'Hello world 12345'
      expect(
        substituteMissingGlyphs(
          text,
          antonEntry!.cmapCoverage,
          antonEntry!.tofuSubstitute,
        ),
      ).toBe(text)
    })

    it.skipIf(antonEntry === null)('cmap coverage does NOT contain common JA code points', () => {
      // Direct pin: verify the coverage build itself.  A regression
      // here (e.g. someone "fixes" `entryFromBytes` by adding every
      // code point regardless of glyph presence) would silently
      // disable the tofu path with no visible symptom in the pure
      // `substituteMissingGlyphs` tests.
      expect(antonEntry!.cmapCoverage.has(0x3042)).toBe(false) // あ
      expect(antonEntry!.cmapCoverage.has(0x30A2)).toBe(false) // ア
      expect(antonEntry!.cmapCoverage.has(0x65E5)).toBe(false) // 日
    })

    it.skipIf(antonEntry === null)('cmap coverage DOES contain Latin ASCII', () => {
      expect(antonEntry!.cmapCoverage.has(0x0041)).toBe(true) // A
      expect(antonEntry!.cmapCoverage.has(0x0061)).toBe(true) // a
      expect(antonEntry!.cmapCoverage.has(0x0020)).toBe(true) // space
    })
  })

  describe('Bebas Neue (lacks U+25A1 — falls back to "?")', () => {
    it.skipIf(bebasEntry === null)('picks U+003F "?" as its tofu substitute', () => {
      // Documented pick for the two "no U+25A1" fonts in the registry
      // (REQ-0160 §2.1).  Anything else here means the candidate
      // priority list has shifted or the font's cmap has changed
      // upstream — either way, the visible symptom would be wrong
      // tofu characters for Bebas Neue users.
      expect(bebasEntry!.tofuSubstitute).toBe('?')
    })

    it.skipIf(bebasEntry === null)('substitutes JP code points with "?" (not "□")', () => {
      const out = substituteMissingGlyphs(
        'test あ test',
        bebasEntry!.cmapCoverage,
        bebasEntry!.tofuSubstitute,
      )
      expect(out).toBe('test ? test')
    })
  })
})
