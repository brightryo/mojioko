import { describe, it, expect } from 'vitest'
import {
  computeKaraokeBreaks,
  splitWordsAtHardBreaks,
  buildKaraokeAssText,
} from '../../src/shared/karaoke-ass'
import { buildFallbackKaraokeUnits } from '../../src/shared/karaoke-fallback'
import { areWordsValidForText, stripAllWhitespace } from '../../src/shared/words-validity'
import type { WordSpan } from '../../src/shared/types'

/**
 * REQ-0308 §1 — a `\N` that lands in the MIDDLE of a karaoke word used to be
 * silently dropped by `computeKaraokeBreaks`, so a karaoke cue rendered with
 * FEWER lines than its own `text` contained: the editor and the table showed
 * the wrapped text while the preview and the burn-in showed the unwrapped one,
 * overflowing the frame.
 *
 * This was never the rare edge case the original REQ-0294 note assumed.
 * REQ-0303 protects **Latin** word boundaries only — a Japanese cue wraps at a
 * character boundary, and Whisper's Japanese "words" are long multi-character
 * chunks, so the auto-inserted break lands mid-word nearly every time.
 *
 * `splitWordsAtHardBreaks` gives every `\N` a unit boundary to attach to.  The
 * invariant these tests defend is the one the owner actually cares about:
 * **the number of rendered lines always equals the number of `\N` in the cue
 * text, plus one.**
 */

const JA_WORDS: WordSpan[] = [
  { startSec: 0, endSec: 1, text: 'あいうえおかきくけこ' },
  { startSec: 1, endSec: 2, text: 'さしすせそたちつてと' },
]
const EN_WORDS: WordSpan[] = [
  { startSec: 0, endSec: 1, text: 'hello' },
  { startSec: 1, endSec: 2, text: ' world' },
  { startSec: 2, endSec: 3, text: ' again' },
]

/** Breaks actually placed, after the split pass the render paths both apply. */
function placedBreaks(text: string, words: readonly WordSpan[]): number {
  return computeKaraokeBreaks(text, splitWordsAtHardBreaks(text, words)).size
}

/** `\N` count in the cue text — the number of breaks that MUST be placed. */
function wantedBreaks(text: string): number {
  return (text.match(/\\N/g) ?? []).length
}

describe('REQ-0308 §1 — every `\\N` survives into the karaoke render', () => {
  it('places a break for a mid-word `\\N` (the Japanese auto-wrap case)', () => {
    // The break splits word 0 in half — pre-REQ-0308 this produced ZERO breaks.
    const text = 'あいうえお\\Nかきくけこさしすせそたちつてと'
    expect(areWordsValidForText(JA_WORDS, text)).toBe(true)
    expect(placedBreaks(text, JA_WORDS)).toBe(wantedBreaks(text))
    // Regression guard on the ORIGINAL (unsplit) units: proves the split is
    // what fixes it, so a future refactor that drops the split call fails here.
    expect(computeKaraokeBreaks(text, JA_WORDS).size).toBe(0)
  })

  it('places both breaks when two `\\N` land inside the same word', () => {
    const text = 'あいう\\Nえおかき\\Nくけこさしすせそたちつてと'
    expect(placedBreaks(text, JA_WORDS)).toBe(2)
  })

  it('handles a mid-word `\\N` in Latin text too', () => {
    const text = 'hel\\Nlo world again'
    expect(placedBreaks(text, EN_WORDS)).toBe(1)
  })

  it('works with the equal-split fallback units (edited cue, no valid words)', () => {
    const text = 'あいうえお\\Nかきくけこ'
    const units = buildFallbackKaraokeUnits(text, 0, 3)
    expect(placedBreaks(text, units)).toBe(1)
  })

  it('a break at a real word boundary is unchanged — SAME array reference', () => {
    // The common Latin case must not be touched at all: identical reference
    // means identical `\k` timing and byte-identical ASS output.
    const text = 'hello\\Nworld again'
    expect(splitWordsAtHardBreaks(text, EN_WORDS)).toBe(EN_WORDS)
    expect(placedBreaks(text, EN_WORDS)).toBe(1)
  })

  it('a cue with no `\\N` at all is unchanged — SAME array reference', () => {
    expect(splitWordsAtHardBreaks('hello world again', EN_WORDS)).toBe(EN_WORDS)
    expect(splitWordsAtHardBreaks('', EN_WORDS)).toBe(EN_WORDS)
  })
})

describe('REQ-0308 §1 — splitting preserves the karaoke invariants', () => {
  const text = 'あいうえお\\Nかきくけこさしすせそたちつてと'
  const split = splitWordsAtHardBreaks(text, JA_WORDS)

  it('keeps the stripped-concat lockstep `areWordsValidForText` relies on', () => {
    expect(stripAllWhitespace(split.map((u) => u.text).join(''))).toBe(
      stripAllWhitespace(JA_WORDS.map((u) => u.text).join('')),
    )
    // Still a valid word list for the same cue text.
    expect(areWordsValidForText(split as WordSpan[], text)).toBe(true)
  })

  it('divides the split word’s time span in proportion to its characters', () => {
    // Word 0 spans [0, 1] and is cut 5 characters into 10 → 0.5 each.
    expect(split.map((u) => [u.startSec, u.endSec])).toEqual([
      [0, 0.5],
      [0.5, 1],
      [1, 2],
    ])
  })

  it('keeps times ascending and inside the original spans', () => {
    for (let i = 0; i < split.length; i++) {
      expect(split[i].endSec).toBeGreaterThanOrEqual(split[i].startSec)
      if (i > 0) expect(split[i].startSec).toBeGreaterThanOrEqual(split[i - 1].startSec)
    }
    expect(split[0].startSec).toBe(JA_WORDS[0].startSec)
    expect(split[split.length - 1].endSec).toBe(JA_WORDS[JA_WORDS.length - 1].endSec)
  })

  it('emits the `\\N` into the ASS body, inside a well-formed `\\k` stream', () => {
    const body = buildKaraokeAssText(split, 0, 3, (s) => s, text)
    expect(body).toBe('{\\k50}あいうえお\\N{\\k50}かきくけこ{\\k200}さしすせそたちつてと')
    // REQ-0291 well-formedness: every `\k` stays brace-enclosed.
    expect(body).not.toMatch(/[^{]\\k/)
    // The visible text still reconstructs the cue (breaks + tags stripped).
    expect(body.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '')).toBe(text.replace(/\\N/g, ''))
  })

  it('degrades gracefully on a zero-length or inverted time span', () => {
    const weird: WordSpan[] = [{ startSec: 5, endSec: 5, text: 'あいうえおかきくけこ' }]
    const out = splitWordsAtHardBreaks('あいうえお\\Nかきくけこ', weird)
    expect(out).toHaveLength(2)
    for (const u of out) {
      expect(Number.isFinite(u.startSec)).toBe(true)
      expect(u.endSec).toBeGreaterThanOrEqual(u.startSec)
    }
  })
})
