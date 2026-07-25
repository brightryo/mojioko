import { describe, it, expect } from 'vitest'
import { buildKaraokeAssText } from '../../src/shared/karaoke-ass'
import type { WordSpan } from '../../src/shared/types'

/**
 * REQ-0286 §2 — pins the karaoke `\k` tag builder.  Fixtures cover:
 *   - happy path (no gap, no leading offset)
 *   - leading offset (cue starts before first word)
 *   - trailing offset (cue ends after last word — held highlight)
 *   - inter-word gaps (silence between words absorbed by prior word)
 *   - empty words → empty string
 *   - escaper application (custom escape function invoked per-word)
 *   - single-word cue
 *   - long-cue duration → cs conversion accuracy
 */

// A no-op escaper for tests that don't care about escaping.
const identity = (s: string) => s

describe('REQ-0286 §2 — buildKaraokeAssText', () => {
  it('empty words → empty string', () => {
    expect(buildKaraokeAssText([], 0, 1, identity)).toBe('')
  })

  it('single word, no offset, no trailing → `\\k<duration>{word}`', () => {
    // Cue [1.0, 1.5], one word at [1.0, 1.5].
    // Leading offset = 0 → no leading tag.
    // Word's duration = cueEnd - word.startSec = 0.5s = 50cs.
    const words: WordSpan[] = [{ startSec: 1.0, endSec: 1.5, text: 'hello' }]
    expect(buildKaraokeAssText(words, 1.0, 1.5, identity)).toBe('\\k50hello')
  })

  it('two words, no gap: word[i] duration = words[i+1].start - words[i].start', () => {
    // Cue [1.0, 3.0], words at [1.0, 1.5] and [1.5, 2.5].
    // Word 1 activates at cue start (offset 0, no leading tag).
    // Word 2 activates 0.5s after word 1 → word 1's \k = 50cs.
    // Word 2 holds until cue end (3.0 - 1.5 = 1.5s) → word 2's \k = 150cs.
    const words: WordSpan[] = [
      { startSec: 1.0, endSec: 1.5, text: 'hi' },
      { startSec: 1.5, endSec: 2.5, text: ' world' },
    ]
    expect(buildKaraokeAssText(words, 1.0, 3.0, identity)).toBe('\\k50hi\\k150 world')
  })

  it('two words with inter-word silence gap: gap absorbed into prior word', () => {
    // Cue [1.0, 3.0], words [1.0, 1.5] and [1.7, 2.5] (0.2s gap).
    // Word 1 duration = words[1].start - words[0].start = 1.7 - 1.0 = 0.7s = 70cs.
    // Word 2 duration = cueEnd - words[1].start = 3.0 - 1.7 = 1.3s = 130cs.
    // The 0.2s gap is transparent — it just means word 1 stays highlighted longer.
    const words: WordSpan[] = [
      { startSec: 1.0, endSec: 1.5, text: 'hello' },
      { startSec: 1.7, endSec: 2.5, text: ' world' },
    ]
    expect(buildKaraokeAssText(words, 1.0, 3.0, identity)).toBe('\\k70hello\\k130 world')
  })

  it('leading offset (cue starts BEFORE first word): emits leading `\\k<offset>`', () => {
    // Cue [1.0, 2.0], first word starts at 1.2 → 0.2s leading offset = 20cs.
    // Word 1 duration = 2.0 - 1.2 = 0.8s = 80cs (last word, holds to cue end).
    const words: WordSpan[] = [{ startSec: 1.2, endSec: 1.5, text: 'hi' }]
    expect(buildKaraokeAssText(words, 1.0, 2.0, identity)).toBe('\\k20\\k80hi')
  })

  it('trailing silence after last word: last-word duration extends to cue end (held highlight)', () => {
    // Cue [0, 5], one word at [0, 1].  Word.endSec = 1, but cue ends at 5.
    // Last word's \k = cueEnd - word.startSec = 5s = 500cs, not word's own
    // duration.  This is the "words[last] stays lit until cue unmounts" case.
    const words: WordSpan[] = [{ startSec: 0, endSec: 1, text: 'held' }]
    expect(buildKaraokeAssText(words, 0, 5, identity)).toBe('\\k500held')
  })

  it('escaper is called per-word (round-trip through the caller\'s escapeAssText)', () => {
    // The generator's escaper transforms `{`, `}`, `\`, `\n` etc.  Here we
    // use a marker escaper to prove the invocation happens once per word.
    const marker = (s: string) => `<${s}>`
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'a' },
      { startSec: 0.5, endSec: 1, text: 'b' },
    ]
    expect(buildKaraokeAssText(words, 0, 1, marker)).toBe('\\k50<a>\\k50<b>')
  })

  it('centisecond rounding: 0.333s → 33cs (banker\'s / .5 up)', () => {
    // Round-half-to-even isn't used; standard round is (0.5 → 1).  The
    // conversion is Math.round(sec * 100).
    const words: WordSpan[] = [{ startSec: 0, endSec: 1, text: 'x' }]
    // Cue [0, 0.333] → last word duration = 0.333s → 33.3 → rounds to 33
    expect(buildKaraokeAssText(words, 0, 0.333, identity)).toBe('\\k33x')
    // Cue [0, 0.335] → 33.5 → rounds to 34
    expect(buildKaraokeAssText(words, 0, 0.335, identity)).toBe('\\k34x')
  })

  it('never produces negative durations (defensive clamp to 0)', () => {
    // Unusual but defensive: if words[i].startSec > words[i+1].startSec
    // (should never happen; sidecar sorts), the computed duration would be
    // negative.  The `Math.max(0, ...)` in `toCs` clamps to 0.
    const words: WordSpan[] = [
      { startSec: 1.0, endSec: 1.5, text: 'later' },
      { startSec: 0.5, endSec: 0.9, text: 'earlier' },  // deliberately wrong order
    ]
    // First word's \k should be 0 (max of negative and 0), second word
    // holds until cueEnd.
    const out = buildKaraokeAssText(words, 0, 2, identity)
    expect(out).toContain('\\k0later')  // clamped
  })

  it('long cue: 60-second duration rounds to 6000cs correctly', () => {
    const words: WordSpan[] = [{ startSec: 0, endSec: 60, text: 'long' }]
    expect(buildKaraokeAssText(words, 0, 60, identity)).toBe('\\k6000long')
  })

  it('word text preserves faster-whisper leading spaces (concat = original transcript)', () => {
    // The words as emitted by the sidecar keep leading spaces on all
    // words except the first.  When rendered, the concatenation exactly
    // reproduces the natural transcript "Hello world everyone".
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.3, text: 'Hello' },
      { startSec: 0.3, endSec: 0.7, text: ' world' },
      { startSec: 0.7, endSec: 1.0, text: ' everyone' },
    ]
    const out = buildKaraokeAssText(words, 0, 1.0, identity)
    expect(out).toBe('\\k30Hello\\k40 world\\k30 everyone')
    // Sanity: extracting the text portion (after the \k tags) reproduces
    // the transcript.
    const textOnly = out.replace(/\\k\d+/g, '')
    expect(textOnly).toBe('Hello world everyone')
  })
})
