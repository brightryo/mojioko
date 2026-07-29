import { describe, it, expect } from 'vitest'
import { areWordsValidForText, normaliseWhitespace } from '../../src/shared/words-validity'
import type { WordSpan } from '../../src/shared/types'

/**
 * REQ-0285 §4 — pins the two-layer defence for words↔text
 * invalidation.  Layer 1 (proactive clear on text edit) is wired at
 * `commit-text-edit.ts`; Layer 2 is this defensive predicate, which
 * Phase B visual features will call before rendering per-word
 * animations.
 *
 * The tests below cover:
 *   - the happy path (fresh transcribe: words concatenate to text)
 *   - the after-edit path (text changed, words stale → invalid)
 *   - the null / empty path (no words data → invalid)
 *   - the auto-line-break tolerance (words don't have `\N`, cue text does)
 *   - the leading-space tolerance (faster-whisper produces " word")
 */

function makeWord(start: number, end: number, text: string): WordSpan {
  return { startSec: start, endSec: end, text }
}

describe('REQ-0285 §4 — areWordsValidForText', () => {
  describe('happy path (fresh transcribe)', () => {
    it('single-word cue: words match text exactly', () => {
      const words = [makeWord(0, 1, 'hello')]
      expect(areWordsValidForText(words, 'hello')).toBe(true)
    })

    it('multi-word cue with faster-whisper leading spaces: matches after normalisation', () => {
      // faster-whisper yields `["Hello", " world", " everyone"]` for
      // "Hello world everyone".  The `.text` field keeps that leading
      // space intentionally (the sidecar `_serialize_words` preserves
      // it).  Concatenating word.text reproduces "Hello world everyone".
      const words = [
        makeWord(0, 0.5, 'Hello'),
        makeWord(0.5, 1.0, ' world'),
        makeWord(1.0, 1.5, ' everyone'),
      ]
      expect(areWordsValidForText(words, 'Hello world everyone')).toBe(true)
    })

    it('cue text with trailing whitespace tolerated', () => {
      const words = [makeWord(0, 1, 'hi'), makeWord(1, 2, ' there')]
      expect(areWordsValidForText(words, 'hi there   ')).toBe(true)
    })
  })

  describe('after-edit path (Layer 2 defensive check)', () => {
    it('word replaced in text → invalid', () => {
      const words = [makeWord(0, 1, 'hello'), makeWord(1, 2, ' world')]
      expect(areWordsValidForText(words, 'hello there')).toBe(false)
    })

    it('word inserted in text → invalid', () => {
      const words = [makeWord(0, 1, 'hello'), makeWord(1, 2, ' world')]
      expect(areWordsValidForText(words, 'hello big world')).toBe(false)
    })

    it('word deleted in text → invalid', () => {
      const words = [
        makeWord(0, 0.5, 'hello'),
        makeWord(0.5, 1.0, ' big'),
        makeWord(1.0, 1.5, ' world'),
      ]
      expect(areWordsValidForText(words, 'hello world')).toBe(false)
    })

    it('punctuation added → invalid (per REQ §4 — no fuzzy match)', () => {
      const words = [makeWord(0, 1, 'hello')]
      expect(areWordsValidForText(words, 'hello.')).toBe(false)
    })

    it('case change → invalid (per REQ §4 — case is a display-only effect, text should never be case-changed in store)', () => {
      const words = [makeWord(0, 1, 'hello')]
      expect(areWordsValidForText(words, 'HELLO')).toBe(false)
    })
  })

  describe('null / empty path (no data)', () => {
    it('undefined words → invalid (short-circuit)', () => {
      expect(areWordsValidForText(undefined, 'anything')).toBe(false)
    })

    it('empty words array → invalid (short-circuit)', () => {
      expect(areWordsValidForText([], 'anything')).toBe(false)
    })

    it('undefined words and empty text → still invalid', () => {
      expect(areWordsValidForText(undefined, '')).toBe(false)
    })
  })

  describe('auto-line-break tolerance (REQ-0285 §4 explicit case)', () => {
    it('cue text has libass \\N hard-break, words do not → still valid', () => {
      // applyAutoLineBreak inserts `\N` into `entry.text` at line boundaries,
      // but the underlying words never carry `\N`.  normaliseWhitespace
      // treats `\N` as a space so the two normalise to the same value.
      const words = [
        makeWord(0, 0.5, 'The'),
        makeWord(0.5, 1.0, ' quick'),
        makeWord(1.0, 1.5, ' brown'),
        makeWord(1.5, 2.0, ' fox'),
      ]
      expect(areWordsValidForText(words, 'The quick\\Nbrown fox')).toBe(true)
    })

    it('multi-line \\N break in the middle → still valid', () => {
      const words = [
        makeWord(0, 0.5, 'one'),
        makeWord(0.5, 1.0, ' two'),
        makeWord(1.0, 1.5, ' three'),
      ]
      expect(areWordsValidForText(words, 'one\\Ntwo three')).toBe(true)
    })
  })

  // -------------------------------------------------------------------
  // REQ-0287 §1-D — Japanese (no-leading-space) transcripts.  Owner-
  // reported that karaoke never activated after re-transcription; the
  // probe showed the pre-REQ-0287 collapse-to-space normaliser turned
  // cue-text `\N` into a space that CJK word.text (no leading spaces)
  // had no counterpart for, so every JA cue with auto-line-break fell
  // to plain rendering.  These tests pin the strip-all-whitespace fix.
  // -------------------------------------------------------------------
  describe('REQ-0287 §1-D — CJK (Japanese) words match with strip-all normaliser', () => {
    it('JA cue with NO \\N and no-space words: matches (baseline)', () => {
      const words = [
        { startSec: 0, endSec: 0.5, text: 'こんにちは' },
        { startSec: 0.5, endSec: 1.0, text: '世界' },
      ]
      expect(areWordsValidForText(words, 'こんにちは世界')).toBe(true)
    })

    it('JA cue WITH \\N inserted mid-text: matches (the REQ-0287 fix)', () => {
      // The failure the REQ was raised to fix.  Pre-REQ-0287 this
      // returned false → every JA karaoke cue fell back to plain.
      const words = [
        { startSec: 0, endSec: 0.5, text: 'こんにちは' },
        { startSec: 0.5, endSec: 1.0, text: '世界' },
      ]
      expect(areWordsValidForText(words, 'こんにちは\\N世界')).toBe(true)
    })

    it('JA cue with multiple \\N breaks (long sentence): still matches', () => {
      const words = [
        { startSec: 0, endSec: 0.3, text: '今日' },
        { startSec: 0.3, endSec: 0.6, text: 'は' },
        { startSec: 0.6, endSec: 0.9, text: '天気' },
        { startSec: 0.9, endSec: 1.2, text: 'が' },
        { startSec: 1.2, endSec: 1.5, text: 'いい' },
      ]
      expect(areWordsValidForText(words, '今日は\\N天気が\\Nいい')).toBe(true)
    })

    it('JA edit detection still works: one word changed → invalid', () => {
      const words = [
        { startSec: 0, endSec: 0.5, text: 'こんにちは' },
        { startSec: 0.5, endSec: 1.0, text: '世界' },
      ]
      // "世界" replaced with "皆" — text differs on non-whitespace
      // chars, so stripping whitespace still leaves a mismatch.
      expect(areWordsValidForText(words, 'こんにちは皆')).toBe(false)
    })

    it('mixed JA + EN cue: matches (leading spaces on EN words + no spaces on JA)', () => {
      // "Hello 世界" typical mixed-language snippet
      const words = [
        { startSec: 0, endSec: 0.5, text: 'Hello' },
        { startSec: 0.5, endSec: 1.0, text: ' 世界' },  // whisper puts space before switching scripts
      ]
      expect(areWordsValidForText(words, 'Hello 世界')).toBe(true)
      expect(areWordsValidForText(words, 'Hello\\N世界')).toBe(true)
    })
  })
})

describe('REQ-0287 §1-D — normaliseWhitespace / stripAllWhitespace (unit helper)', () => {
  it('strips whitespace runs entirely (was: collapsed to single space pre-REQ-0287)', () => {
    // Post-REQ-0287 semantics: every whitespace char removed.  This
    // reflects the "compare glyph identity, ignore layout whitespace"
    // rule that lets CJK match after auto-line-break.
    expect(normaliseWhitespace('a  b   c')).toBe('abc')
    expect(normaliseWhitespace('a\tb\nc')).toBe('abc')
  })

  it('trims leading and trailing whitespace (implicit — strip-all also strips ends)', () => {
    expect(normaliseWhitespace('  hello  ')).toBe('hello')
  })

  it('strips \\N (literal backslash-N) — was collapse-to-space pre-REQ-0287', () => {
    expect(normaliseWhitespace('a\\Nb')).toBe('ab')
    expect(normaliseWhitespace('a\\N\\Nb')).toBe('ab')
    expect(normaliseWhitespace('a \\Nb')).toBe('ab')
  })

  it('empty string yields empty string', () => {
    expect(normaliseWhitespace('')).toBe('')
    expect(normaliseWhitespace('   ')).toBe('')
    expect(normaliseWhitespace('\\N\\N')).toBe('')
  })
})
