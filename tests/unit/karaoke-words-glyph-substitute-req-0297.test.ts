import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import opentype from 'opentype.js'
import { substituteMissingGlyphs, pickTofuSubstitute } from '../../src/shared/glyph-substitute'
import { areWordsValidForText } from '../../src/shared/words-validity'
import type { WordSpan } from '../../src/shared/types'

/**
 * REQ-0297 regression suite — pins the per-word glyph substitution
 * added by burnin.ts + subtitle-overlay so a Latin-only font with
 * JA text produces tofu (□/?) instead of triggering system-font
 * fallback via libass (burn-in) or the browser (preview).
 *
 * Pre-REQ-0297 only `entry.text` was substituted; `entry.words[i].text`
 * reached the karaoke render paths verbatim, and JA codepoints
 * survived through to libass / the browser where system fallback drew
 * them in Yu Gothic / etc.
 *
 * Every test replicates the per-word map + guard used by
 * `services/burnin.ts` (post-REQ-0297) so the logic is pinned even
 * though burnin.ts itself is renderer-owned + IPC-heavy and not
 * directly importable in vitest.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..')

interface RealFontEntry {
  cmapCoverage: Set<number>
  tofuSubstitute: string
}

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

/**
 * Extracted from `services/burnin.ts` post-REQ-0297 — substitute
 * missing glyphs in every word's text and return a new word array
 * only when at least one word actually changed (identity check keeps
 * the hot path allocation-free).
 */
function substituteWords(
  words: readonly WordSpan[],
  cmap: Set<number>,
  tofu: string,
): readonly WordSpan[] {
  let anyChanged = false
  const next = words.map((w) => {
    const s = substituteMissingGlyphs(w.text, cmap, tofu)
    if (s === w.text) return w
    anyChanged = true
    return { ...w, text: s }
  })
  return anyChanged ? next : words
}

describe('REQ-0297 §2 — per-word glyph substitution (Latin-only font + JA text → tofu)', () => {
  it.skipIf(antonEntry === null)('substitutes each word\'s JA characters with the font\'s tofu char (Anton → □)', () => {
    // Anton (Latin-only) + JA words: every JA char should become □
    // in every word's text field.  Startsec/endsec unchanged.
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'こ' },
      { startSec: 0.5, endSec: 1.0, text: 'ん' },
      { startSec: 1.0, endSec: 1.5, text: 'に' },
      { startSec: 1.5, endSec: 2.0, text: 'ち' },
      { startSec: 2.0, endSec: 2.5, text: 'は' },
    ]
    const out = substituteWords(words, antonEntry!.cmapCoverage, antonEntry!.tofuSubstitute)
    expect(out).toHaveLength(5)
    for (const w of out) {
      expect(w.text).toBe('□')
    }
    // Timing preserved (per-word Whisper timing not lost).
    expect(out[0].startSec).toBe(0)
    expect(out[4].endSec).toBe(2.5)
  })

  it.skipIf(notoEntry === null)('leaves JA words UNCHANGED when the font supports them (Noto Sans JP)', () => {
    // Noto Sans JP covers every JA char → identity return (no
    // allocation) → REACT-memo skip.  Same guarantee the plain-text
    // path already had for `substituteMissingGlyphs`.
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'こんにちは' },
      { startSec: 0.5, endSec: 1.0, text: '世界' },
    ]
    const out = substituteWords(words, notoEntry!.cmapCoverage, notoEntry!.tofuSubstitute)
    // Reference identity — hot-path allocation-free.
    expect(out).toBe(words)
  })

  it.skipIf(antonEntry === null)('leaves Latin ASCII words UNCHANGED under a Latin-only font (English cue works)', () => {
    // Anton on Latin text is the normal English-only-caption use
    // case — must NOT trigger any substitution.
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ]
    const out = substituteWords(words, antonEntry!.cmapCoverage, antonEntry!.tofuSubstitute)
    expect(out).toBe(words)
  })

  it.skipIf(antonEntry === null)('mixed cue (Latin words + JA words) — only JA words substituted', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.3, text: 'Hello' },
      { startSec: 0.3, endSec: 0.8, text: ' 世' },
      { startSec: 0.8, endSec: 1.2, text: '界' },
      { startSec: 1.2, endSec: 1.6, text: ' world' },
    ]
    const out = substituteWords(words, antonEntry!.cmapCoverage, antonEntry!.tofuSubstitute)
    // Latin words unchanged (reference identity of the individual
    // WordSpans is preserved for unaffected entries).
    expect(out[0]).toBe(words[0])
    expect(out[3]).toBe(words[3])
    // JA words became tofu — the leading space of ' 世' survives
    // (space is < 0x7F and every font declares it).
    expect(out[1].text).toBe(' □')
    expect(out[2].text).toBe('□')
  })
})

describe('REQ-0297 §2 — post-substitution word/text pair stays valid (Whisper timing preserved)', () => {
  it.skipIf(antonEntry === null)('when BOTH `text` and `words[]` are substituted, `areWordsValidForText` still holds', () => {
    // The critical invariant: burnin.ts must substitute BOTH sides
    // consistently.  If only `text` were substituted (pre-REQ-0297),
    // `areWordsValidForText(rawWords, substitutedText)` returns false
    // → ass-generator drops through to REQ-0289 equal-split fallback
    // → per-word Whisper timing is LOST.  Substituting both keeps
    // the predicate true and Whisper timing survives.
    const cue = 'こんにちは'
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'こ' },
      { startSec: 0.5, endSec: 1.0, text: 'ん' },
      { startSec: 1.0, endSec: 1.5, text: 'に' },
      { startSec: 1.5, endSec: 2.0, text: 'ち' },
      { startSec: 2.0, endSec: 2.5, text: 'は' },
    ]
    const cmap = antonEntry!.cmapCoverage
    const tofu = antonEntry!.tofuSubstitute
    const substitutedText = substituteMissingGlyphs(cue, cmap, tofu)
    const substitutedWords = substituteWords(words, cmap, tofu)

    expect(substitutedText).toBe('□□□□□')
    expect(substitutedWords.map((w) => w.text).join('')).toBe('□□□□□')

    // Whisper timing preserved: 5 words still, each keeping its
    // original startSec/endSec.
    expect(substitutedWords).toHaveLength(5)
    expect(substitutedWords[2].startSec).toBe(1.0)
    expect(substitutedWords[4].endSec).toBe(2.5)

    // And the words-validity predicate now holds after substitution
    // → ass-generator's karaoke branch selects the Whisper path,
    // NOT the equal-split fallback.
    expect(areWordsValidForText(substitutedWords, substitutedText)).toBe(true)
  })

  it.skipIf(antonEntry === null)('if only `text` is substituted (pre-REQ-0297 shape), `areWordsValidForText` FAILS (this is the bug pre-REQ-0297 shipped)', () => {
    // Negative pin: documents why substituting only one side broke
    // per-word timing.  If a future change reintroduces the
    // one-sided substitution, this test still passes but the
    // "BOTH substituted" test above becomes the meaningful
    // canary.
    const cue = 'こんにちは'
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'こ' },
      { startSec: 0.5, endSec: 1.0, text: 'ん' },
      { startSec: 1.0, endSec: 1.5, text: 'に' },
      { startSec: 1.5, endSec: 2.0, text: 'ち' },
      { startSec: 2.0, endSec: 2.5, text: 'は' },
    ]
    const cmap = antonEntry!.cmapCoverage
    const tofu = antonEntry!.tofuSubstitute
    const substitutedText = substituteMissingGlyphs(cue, cmap, tofu)
    // words NOT substituted:
    expect(areWordsValidForText(words, substitutedText)).toBe(false)
  })
})
