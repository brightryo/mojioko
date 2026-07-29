import { describe, it, expect } from 'vitest'
import { buildKaraokeAssText, computeKaraokeBreaks } from '../../src/shared/karaoke-ass'
import type { WordSpan } from '../../src/shared/types'

/**
 * REQ-0286 §2 / REQ-0291 — pins the karaoke `\k` tag builder.
 *
 * Every `\k` tag MUST be enclosed in its own `{...}` override block so
 * libass parses it as a tag rather than drawing it as literal text
 * (REQ-0291 regression: pre-fix `buildKaraokeAssText` emitted bare
 * `\k50hello` which libass rendered as the visible string "\k50hello"
 * on the burn-in video).  Every assertion below pins the braced form
 * `{\k<cs>}<text>`.
 *
 * Fixtures cover:
 *   - happy path (no gap, no leading offset)
 *   - leading offset (cue starts before first word)
 *   - trailing offset (cue ends after last word — held highlight)
 *   - inter-word gaps (silence between words absorbed by prior word)
 *   - empty words → empty string
 *   - escaper application (custom escape function invoked per-word)
 *   - single-word cue
 *   - long-cue duration → cs conversion accuracy
 *   - REQ-0291 well-formedness: no bare `\k` outside braces anywhere
 */

// A no-op escaper for tests that don't care about escaping.
const identity = (s: string) => s

describe('REQ-0286 §2 / REQ-0291 — buildKaraokeAssText', () => {
  it('empty words → empty string', () => {
    expect(buildKaraokeAssText([], 0, 1, identity)).toBe('')
  })

  it('single word, no offset, no trailing → `{\\k<duration>}<word>` (REQ-0291 brace-enclosed)', () => {
    // Cue [1.0, 1.5], one word at [1.0, 1.5].
    // Leading offset = 0 → no leading tag.
    // Word's duration = cueEnd - word.startSec = 0.5s = 50cs.
    const words: WordSpan[] = [{ startSec: 1.0, endSec: 1.5, text: 'hello' }]
    expect(buildKaraokeAssText(words, 1.0, 1.5, identity)).toBe('{\\k50}hello')
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
    expect(buildKaraokeAssText(words, 1.0, 3.0, identity)).toBe('{\\k50}hi{\\k150} world')
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
    expect(buildKaraokeAssText(words, 1.0, 3.0, identity)).toBe('{\\k70}hello{\\k130} world')
  })

  it('leading offset (cue starts BEFORE first word): emits leading `{\\k<offset>}`', () => {
    // Cue [1.0, 2.0], first word starts at 1.2 → 0.2s leading offset = 20cs.
    // Word 1 duration = 2.0 - 1.2 = 0.8s = 80cs (last word, holds to cue end).
    // Leading offset tag also brace-enclosed (REQ-0291).
    const words: WordSpan[] = [{ startSec: 1.2, endSec: 1.5, text: 'hi' }]
    expect(buildKaraokeAssText(words, 1.0, 2.0, identity)).toBe('{\\k20}{\\k80}hi')
  })

  it('trailing silence after last word: last-word duration extends to cue end (held highlight)', () => {
    // Cue [0, 5], one word at [0, 1].  Word.endSec = 1, but cue ends at 5.
    // Last word's \k = cueEnd - word.startSec = 5s = 500cs, not word's own
    // duration.  This is the "words[last] stays lit until cue unmounts" case.
    const words: WordSpan[] = [{ startSec: 0, endSec: 1, text: 'held' }]
    expect(buildKaraokeAssText(words, 0, 5, identity)).toBe('{\\k500}held')
  })

  it('escaper is called per-word (round-trip through the caller\'s escapeAssText)', () => {
    // The generator's escaper transforms `{`, `}`, `\`, `\n` etc.  Here we
    // use a marker escaper to prove the invocation happens once per word.
    // The `<...>` marker sits OUTSIDE the `{\k}` override block —
    // proving the escaper is applied to word text, not to the tag syntax.
    const marker = (s: string) => `<${s}>`
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'a' },
      { startSec: 0.5, endSec: 1, text: 'b' },
    ]
    expect(buildKaraokeAssText(words, 0, 1, marker)).toBe('{\\k50}<a>{\\k50}<b>')
  })

  it('centisecond rounding: 0.333s → 33cs (banker\'s / .5 up)', () => {
    // Round-half-to-even isn't used; standard round is (0.5 → 1).  The
    // conversion is Math.round(sec * 100).
    const words: WordSpan[] = [{ startSec: 0, endSec: 1, text: 'x' }]
    // Cue [0, 0.333] → last word duration = 0.333s → 33.3 → rounds to 33
    expect(buildKaraokeAssText(words, 0, 0.333, identity)).toBe('{\\k33}x')
    // Cue [0, 0.335] → 33.5 → rounds to 34
    expect(buildKaraokeAssText(words, 0, 0.335, identity)).toBe('{\\k34}x')
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
    // holds until cueEnd.  Still brace-enclosed.
    const out = buildKaraokeAssText(words, 0, 2, identity)
    expect(out).toContain('{\\k0}later')
  })

  it('long cue: 60-second duration rounds to 6000cs correctly', () => {
    const words: WordSpan[] = [{ startSec: 0, endSec: 60, text: 'long' }]
    expect(buildKaraokeAssText(words, 0, 60, identity)).toBe('{\\k6000}long')
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
    expect(out).toBe('{\\k30}Hello{\\k40} world{\\k30} everyone')
    // Sanity: extracting the text portion (after stripping every
    // `{\k<cs>}` block) reproduces the transcript.
    const textOnly = out.replace(/\{\\k\d+\}/g, '')
    expect(textOnly).toBe('Hello world everyone')
  })
})

describe('REQ-0291 — no bare `\\k` outside `{...}` (regression pin)', () => {
  // REQ-0291 root cause was `buildKaraokeAssText` emitting `\k50hello`
  // (bare) instead of `{\k50}hello` (brace-enclosed).  libass draws
  // bare override tags as literal text — the exact symptom the owner
  // saw in the MP4 output.  These tests fail if a future change
  // reintroduces bare `\k` anywhere in the output.

  // A "bare \k" is `\k` NOT immediately preceded by `{` and NOT inside
  // a `{...}` block.  We check this by:
  //   1. Stripping every `{\k<digits>}` block → no `\k` should remain.
  //   2. Asserting the input contains NO `\k` outside `{...}`.
  function assertAllKTagsBraceEnclosed(s: string): void {
    // Step 1: strip proper `{\k<cs>}` blocks (may repeat).
    const strippedProper = s.replace(/\{\\k\d+\}/g, '')
    // No `\k` should survive the strip.  If any does, it wasn't inside
    // `{\k<digits>}` → it's a bare tag.
    expect(strippedProper).not.toContain('\\k')
  }

  it('happy path (single word) — every `\\k` is brace-enclosed', () => {
    const out = buildKaraokeAssText(
      [{ startSec: 0, endSec: 1, text: 'hello' }],
      0, 1, identity,
    )
    assertAllKTagsBraceEnclosed(out)
  })

  it('multi-word with inter-word gap and trailing hold — every `\\k` is brace-enclosed', () => {
    const out = buildKaraokeAssText(
      [
        { startSec: 0, endSec: 0.5, text: 'a' },
        { startSec: 0.7, endSec: 1.2, text: ' b' },
        { startSec: 1.5, endSec: 1.9, text: ' c' },
      ],
      0, 3, identity,
    )
    assertAllKTagsBraceEnclosed(out)
  })

  it('leading offset — the `{\\k<offset>}` silent tag is ALSO brace-enclosed', () => {
    const out = buildKaraokeAssText(
      [{ startSec: 0.5, endSec: 1, text: 'delayed' }],
      0, 1, identity,
    )
    // Both the leading `{\k50}` and the word's `{\k50}delayed` must be
    // brace-enclosed.  If the leading offset regressed we'd see a bare
    // `\k50` at the very start of the output.
    assertAllKTagsBraceEnclosed(out)
    expect(out.startsWith('{\\k50}')).toBe(true)
  })

  it('escaper output does not leak into the tag syntax (word text with `{` / `}` / `\\` stays outside braces)', () => {
    // Words containing `{` / `}` / `\` would collide with tag syntax if
    // the escaper failed to escape them.  Use the real escaper shape
    // here (matching `escapeAssText`) so the pin catches escaper
    // regressions too.  A word with an embedded backslash MUST NOT
    // create a spurious `\k` sequence in the emitted string.
    const escapeAss = (s: string): string => s
      .replace(/\\N/g, '\n')
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N')
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'plain' },
      { startSec: 0.5, endSec: 1, text: ' {brace}' },
      { startSec: 1, endSec: 1.5, text: ' back\\slash' },
    ]
    const out = buildKaraokeAssText(words, 0, 1.5, escapeAss)
    // Strip real karaoke tags — what remains is escaped text that MUST
    // NOT contain any `\k` sequences (i.e. no bare karaoke tags mixed
    // into the escaped body).
    const strippedProper = out.replace(/\{\\k\d+\}/g, '')
    expect(strippedProper).not.toContain('\\k')
    // And the escaper's `\\{` / `\\}` escapes ARE present in the stripped
    // body, proving braces in word text survived as escaped literals
    // rather than being interpreted as tag delimiters.
    expect(strippedProper).toContain('\\{brace\\}')
  })
})

describe('REQ-0294 — computeKaraokeBreaks (\\N → word-index mapping)', () => {
  it('no `\\N` in cueText → empty set (single-line cue, no wraps)', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
    ]
    expect(Array.from(computeKaraokeBreaks('hello world', words))).toEqual([])
  })

  it('EN 2-word cue with `\\N` between words → break before word 1', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
    ]
    expect(Array.from(computeKaraokeBreaks('hello\\Nworld', words))).toEqual([1])
  })

  it('JA 2-word cue with `\\N` between words → break before word 1', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'こんにちは' },
      { startSec: 0.5, endSec: 1, text: '世界' },
    ]
    expect(Array.from(computeKaraokeBreaks('こんにちは\\N世界', words))).toEqual([1])
  })

  it('JA per-character (fallback) cue with `\\N` mid-string → break at the exact char boundary', () => {
    // Simulates the fallback splitter output for "テストです\Nこんにちは":
    // 10 single-char units, with \N between position 4 (す) and 5 (こ).
    const chars = ['テ', 'ス', 'ト', 'で', 'す', 'こ', 'ん', 'に', 'ち', 'は']
    const words: WordSpan[] = chars.map((text, i) => ({
      startSec: i * 0.1, endSec: (i + 1) * 0.1, text,
    }))
    expect(Array.from(computeKaraokeBreaks('テストです\\Nこんにちは', words))).toEqual([5])
  })

  it('multiple `\\N` breaks in one cue → break set for each following word', () => {
    // 3-line cue: "hello\Nworld\Nagain" with 3 whisper words.
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
      { startSec: 1, endSec: 1.5, text: ' again' },
    ]
    expect(Array.from(computeKaraokeBreaks('hello\\Nworld\\Nagain', words))).toEqual([1, 2])
  })

  it('leading `\\N` in cueText → no break added (degenerate case, no chars before to bind to)', () => {
    const words: WordSpan[] = [{ startSec: 0, endSec: 1, text: 'hello' }]
    expect(Array.from(computeKaraokeBreaks('\\Nhello', words))).toEqual([])
  })

  it('trailing `\\N` in cueText → no break added (no word follows the break)', () => {
    const words: WordSpan[] = [{ startSec: 0, endSec: 1, text: 'hello' }]
    expect(Array.from(computeKaraokeBreaks('hello\\N', words))).toEqual([])
  })

  it('mid-word `\\N` (uncommon, user hand-edit) → silently drops the break', () => {
    // Cue "hel\Nlo world" — `\N` sits BETWEEN two chars of word[0].
    // computeKaraokeBreaks only checks the first char of each word,
    // so a mid-word `\N` doesn't mark any word.  Documented edge case.
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
    ]
    expect(Array.from(computeKaraokeBreaks('hel\\Nlo world', words))).toEqual([])
  })
})

describe('REQ-0294 — buildKaraokeAssText with cueText emits `\\N` in-body', () => {
  it('EN 2-line: `hello\\Nworld` → `{\\k50}hello\\N{\\k150}world` (space stripped from " world" after break)', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
    ]
    const out = buildKaraokeAssText(words, 0, 2, identity, 'hello\\Nworld')
    expect(out).toBe('{\\k50}hello\\N{\\k150}world')
  })

  it('JA 2-line: `こんにちは\\N世界` → `{\\k50}こんにちは\\N{\\k150}世界`', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'こんにちは' },
      { startSec: 0.5, endSec: 1, text: '世界' },
    ]
    const out = buildKaraokeAssText(words, 0, 2, identity, 'こんにちは\\N世界')
    expect(out).toBe('{\\k50}こんにちは\\N{\\k150}世界')
  })

  it('single-line cue: cueText without `\\N` → output identical to no-cueText call (regression pin)', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
    ]
    const withCue = buildKaraokeAssText(words, 0, 2, identity, 'hello world')
    const noCue = buildKaraokeAssText(words, 0, 2, identity)
    expect(withCue).toBe(noCue)
    expect(withCue).toBe('{\\k50}hello{\\k150} world')
  })

  it('cueText omitted → pre-REQ-0294 single-line output preserved (backward compat)', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
    ]
    // Even if cue text WOULD contain \N, callers that don't pass it
    // get the legacy no-break behaviour — no regressions in old
    // test fixtures that use the 4-arg call.
    const out = buildKaraokeAssText(words, 0, 2, identity)
    expect(out).not.toContain('\\N')
  })

  it('3-line cue: two breaks emit two `\\N` in-body', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
      { startSec: 1, endSec: 1.5, text: ' again' },
    ]
    const out = buildKaraokeAssText(words, 0, 2, identity, 'hello\\Nworld\\Nagain')
    expect(out).toBe('{\\k50}hello\\N{\\k50}world\\N{\\k100}again')
  })

  it('every `\\k` remains brace-enclosed even with `\\N` interleaved (REQ-0291 well-formedness preserved)', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1, text: ' world' },
    ]
    const out = buildKaraokeAssText(words, 0, 2, identity, 'hello\\Nworld')
    // Strip proper `{\k<cs>}` blocks AND the `\N` line-break literal.
    // What remains should be pure word text — no `\k` residue.
    const strippedProper = out.replace(/\{\\k\d+\}/g, '').replace(/\\N/g, '')
    expect(strippedProper).not.toContain('\\k')
  })
})
