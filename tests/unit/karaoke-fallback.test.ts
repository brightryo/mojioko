import { describe, it, expect } from 'vitest'
import {
  splitTextIntoKaraokeUnits,
  buildFallbackKaraokeUnits,
} from '../../src/shared/karaoke-fallback'

/**
 * REQ-0289 §2 / §5 — pins the equal-split karaoke fallback tokeniser
 * and duration formula.  These are the pure-function primitives the
 * ass-generator / subtitle-overlay call when the render-time
 * `areWordsValidForText` check fails; keeping them separately
 * unit-tested lets us pin CJK / Latin / mixed splitting behaviour
 * without dragging the full ASS render pipeline into every case.
 */

describe('REQ-0289 §2 — splitTextIntoKaraokeUnits', () => {
  it('splits Latin text into whitespace-delimited words with leading spaces preserved', () => {
    // faster-whisper convention: non-first words carry their leading
    // space so concat matches the raw transcript.  The fallback
    // splitter mirrors this so both code paths (real words / fallback)
    // feed `buildKaraokeAssText` a comparable shape.
    expect(splitTextIntoKaraokeUnits('Hello world')).toEqual(['Hello', ' world'])
  })

  it('splits CJK text into single-character units (no per-word whitespace to key on)', () => {
    expect(splitTextIntoKaraokeUnits('こんにちは')).toEqual(['こ', 'ん', 'に', 'ち', 'は'])
  })

  it('splits mixed Latin + CJK by run: Latin word, CJK char-by-char', () => {
    // `Hello 世界! Bye`:
    //   - `Hello` — Latin run, one unit
    //   - space, then CJK `世` — space absorbed as leading whitespace
    //     on the CJK unit
    //   - `界` — next CJK, no leading whitespace
    //   - `!` — Latin punctuation (no preceding whitespace) — one unit
    //   - space, then `Bye` — Latin run with leading space
    const units = splitTextIntoKaraokeUnits('Hello 世界! Bye')
    expect(units).toEqual(['Hello', ' 世', '界', '!', ' Bye'])
  })

  it('treats `\\N` (libass hard-break sentinel) as a space for tokenising', () => {
    // Latin `Hello\Nworld` becomes `[Hello, ' world']` so the karaoke
    // render doesn't collapse the two words into `Helloworld` when
    // libass ignores the `\N` (karaoke doesn't respect `\N` per
    // karaoke-ass.ts docstring).
    expect(splitTextIntoKaraokeUnits('Hello\\Nworld')).toEqual(['Hello', ' world'])
  })

  it('drops whitespace-only tokens (no zero-content units)', () => {
    expect(splitTextIntoKaraokeUnits('   ')).toEqual([])
    expect(splitTextIntoKaraokeUnits('\n\t  ')).toEqual([])
    expect(splitTextIntoKaraokeUnits('\\N')).toEqual([])
  })

  it('returns [] for empty input (zero-unit safety anchor)', () => {
    expect(splitTextIntoKaraokeUnits('')).toEqual([])
  })

  it('handles a single CJK character', () => {
    expect(splitTextIntoKaraokeUnits('あ')).toEqual(['あ'])
  })

  it('handles a single Latin word', () => {
    expect(splitTextIntoKaraokeUnits('hello')).toEqual(['hello'])
  })

  it('collapses consecutive Latin punctuation into one Latin run', () => {
    // No whitespace between `Hi` and `!?` → single Latin unit `Hi!?`.
    expect(splitTextIntoKaraokeUnits('Hi!?')).toEqual(['Hi!?'])
  })

  it('multiple consecutive whitespace collapses into a single leading space on the next unit', () => {
    // Whitespace absorption is verbatim — three spaces → three-space
    // lead on `world`.  Faster-whisper never emits multi-space runs
    // so this is a defensive shape; the point is that the splitter
    // is deterministic (not that the exact whitespace is meaningful).
    expect(splitTextIntoKaraokeUnits('Hello   world')).toEqual(['Hello', '   world'])
  })
})

describe('REQ-0289 §1 — buildFallbackKaraokeUnits (equal-split durations)', () => {
  it('assigns cue duration / units.length to every unit', () => {
    // cue [0, 5], 5 units → 1.0 s each.
    const units = buildFallbackKaraokeUnits('こんにちは', 0, 5)
    expect(units).toHaveLength(5)
    expect(units[0]).toEqual({ startSec: 0, endSec: 1, text: 'こ' })
    expect(units[1]).toEqual({ startSec: 1, endSec: 2, text: 'ん' })
    expect(units[2]).toEqual({ startSec: 2, endSec: 3, text: 'に' })
    expect(units[3]).toEqual({ startSec: 3, endSec: 4, text: 'ち' })
    expect(units[4]).toEqual({ startSec: 4, endSec: 5, text: 'は' })
  })

  it('preserves the cue start offset (units start at cueStartSec, not 0)', () => {
    // cue [10, 12], 2 units → 1.0 s each starting at 10.
    const units = buildFallbackKaraokeUnits('Hello world', 10, 12)
    expect(units).toEqual([
      { startSec: 10, endSec: 11, text: 'Hello' },
      { startSec: 11, endSec: 12, text: ' world' },
    ])
  })

  it('returns [] when the text has no units (empty text → karaoke inactive → plain fallback)', () => {
    // Guards the ass-generator / subtitle-overlay `karaokeActive =
    // karaokeWords.length > 0` gate — this must be [] not [{}].
    expect(buildFallbackKaraokeUnits('', 0, 2)).toEqual([])
    expect(buildFallbackKaraokeUnits('   ', 0, 2)).toEqual([])
    expect(buildFallbackKaraokeUnits('\\N', 0, 2)).toEqual([])
  })

  it('returns [] for a zero-duration cue (divide-by-zero safety)', () => {
    // A degenerate cue span shouldn't produce `perUnit = Infinity` or
    // NaN times — collapse to `[]` so the caller treats it as karaoke-
    // inactive and renders plain.
    expect(buildFallbackKaraokeUnits('hello', 5, 5)).toEqual([])
  })

  it('returns [] for a negative-duration cue (defensive against upstream bugs)', () => {
    expect(buildFallbackKaraokeUnits('hello', 5, 4)).toEqual([])
  })

  it('non-integer per-unit duration is preserved as a float (no unwanted rounding here)', () => {
    // Rounding is centralised in buildKaraokeAssText's toCs step so
    // the split itself stays at float precision — a 3-unit / 1-s cue
    // is 0.3333.. per unit.
    const units = buildFallbackKaraokeUnits('abc def ghi', 0, 1)
    expect(units[0].startSec).toBeCloseTo(0)
    expect(units[1].startSec).toBeCloseTo(1 / 3)
    expect(units[2].startSec).toBeCloseTo(2 / 3)
    expect(units[2].endSec).toBeCloseTo(1)
  })
})
