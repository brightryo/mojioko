/**
 * REQ-0311 §4 — `\kf` sweep emitter.
 *
 * The headline property under test is the TIMING design the REQ flagged: the
 * `\k` path gives each word `next.start - this.start` so inter-word silence is
 * absorbed, which for a sweep would make the fill crawl through the pause.
 * The sweep path instead sweeps over the word's own speech duration and emits
 * the silence as a separate textless `{\k}` block.
 */
import { describe, it, expect } from 'vitest'
import { buildKaraokeSweepAssText, sweepWordTimings } from '../../src/shared/karaoke-sweep'
import { buildKaraokeAssText } from '../../src/shared/karaoke-ass'
import type { WordSpan } from '../../src/shared/types'

const id = (s: string) => s
const w = (startSec: number, endSec: number, text: string): WordSpan => ({ startSec, endSec, text })

/** Every `{...}` block, so brace enclosure can be asserted structurally. */
function blocks(s: string): string[] {
  return Array.from(s.matchAll(/\{([^}]*)\}/g)).map((m) => m[1])
}

describe('buildKaraokeSweepAssText — timing design', () => {
  it('sweeps each word over its OWN speech duration, not up to the next word', () => {
    // "hello" spoken 0.0-0.5, then 1.0s of silence, then "world" 1.5-2.0.
    const words = [w(0, 0.5, 'hello'), w(1.5, 2.0, ' world')]
    const out = buildKaraokeSweepAssText(words, 0, 2.5, id)
    // 50cs of sweep, 100cs of silence, 50cs of sweep.
    expect(out).toBe('{\\kf50}hello{\\k100}{\\kf50} world')
  })

  it('the `\\k` path absorbs the same gap into the word — the contrast this fixes', () => {
    const words = [w(0, 0.5, 'hello'), w(1.5, 2.0, ' world')]
    const legacy = buildKaraokeAssText(words, 0, 2.5, id)
    // 150cs: the whole silence is folded into "hello".
    expect(legacy).toBe('{\\k150}hello{\\k100} world')
  })

  it('emits a leading silence block when the cue starts before the first word', () => {
    const out = buildKaraokeSweepAssText([w(0.4, 0.9, 'hi')], 0, 1.5, id)
    expect(out).toBe('{\\k40}{\\kf50}hi')
  })

  it('emits no gap block when words are contiguous', () => {
    const out = buildKaraokeSweepAssText([w(0, 0.5, 'a'), w(0.5, 1, 'b')], 0, 1, id)
    expect(out).toBe('{\\kf50}a{\\kf50}b')
  })

  it('does not stretch the last word to the cue end', () => {
    // The `\k` path holds the last word until cueEnd; the sweep must not.
    const out = buildKaraokeSweepAssText([w(0, 0.5, 'a')], 0, 5, id)
    expect(out).toBe('{\\kf50}a')
  })

  it('falls back to the gap-absorbing duration for degenerate (zero-length) timings', () => {
    const out = buildKaraokeSweepAssText([w(0, 0, 'a'), w(1, 1, 'b')], 0, 2, id)
    // a: 0-length speech -> falls back to next.start - this.start = 100cs
    // b: 0-length speech -> falls back to cueEnd - this.start   = 100cs
    expect(out).toBe('{\\kf100}a{\\k100}{\\kf100}b')
  })

  it('rounds to centiseconds and never emits a negative duration', () => {
    const out = buildKaraokeSweepAssText([w(0, 0.004, 'a')], 0, 1, id)
    expect(out).toBe('{\\kf0}a')
    const overlapping = buildKaraokeSweepAssText([w(0, 1, 'a'), w(0.5, 1.5, 'b')], 0, 2, id)
    // Overlapping words produce a negative gap -> no gap block, never `\k-50`.
    expect(overlapping).not.toContain('-')
  })
})

describe('buildKaraokeSweepAssText — structural invariants', () => {
  const words = [w(0, 0.5, 'hello'), w(0.6, 1.1, ' world')]

  it('wraps every override in braces (REQ-0291)', () => {
    const out = buildKaraokeSweepAssText(words, 0, 1.5, id)
    // No backslash tag may appear outside a `{...}` block, except the `\N`
    // line-break sentinel which is a literal in the text field.
    const withoutBlocks = out.replace(/\{[^}]*\}/g, '')
    expect(withoutBlocks.replace(/\\N/g, '')).not.toContain('\\')
    for (const b of blocks(out)) expect(b.startsWith('\\k')).toBe(true)
  })

  it('returns empty for no words', () => {
    expect(buildKaraokeSweepAssText([], 0, 1, id)).toBe('')
  })

  it('routes word text through the caller escaper', () => {
    const out = buildKaraokeSweepAssText([w(0, 1, 'a{b}c')], 0, 1, (s) =>
      s.replace(/([{}\\])/g, '\\$1'),
    )
    expect(out).toBe('{\\kf100}a\\{b\\}c')
  })
})

describe('buildKaraokeSweepAssText — line breaks (行またぎ)', () => {
  it('inserts `\\N` before the word that starts a new line and strips its indent', () => {
    const words = [w(0, 0.5, 'hello'), w(0.5, 1, ' world')]
    const out = buildKaraokeSweepAssText(words, 0, 1, id, 'hello\\Nworld')
    expect(out).toBe('{\\kf50}hello\\N{\\kf50}world')
  })

  it('keeps the same break positions as the `\\k` path', () => {
    const words = [w(0, 0.5, 'hello'), w(0.5, 1, ' world')]
    const cue = 'hello\\Nworld'
    const sweepBreaks = (buildKaraokeSweepAssText(words, 0, 1, id, cue).match(/\\N/g) ?? []).length
    const switchBreaks = (buildKaraokeAssText(words, 0, 1, id, cue).match(/\\N/g) ?? []).length
    expect(sweepBreaks).toBe(switchBreaks)
  })
})

describe('buildKaraokeSweepAssText — keyword emphasis', () => {
  const emphasis = {
    ranges: new Map([[0, [[0, 2] as readonly [number, number]]]]),
    openTag: '\\fs150\\c&H00FFFF&',
    closeTag: '\\fs100\\c&H39FFB4&',
  }

  it('folds the open tag into the `\\kf` block and closes before the next run', () => {
    const out = buildKaraokeSweepAssText([w(0, 1, 'abcd')], 0, 1, id, undefined, emphasis)
    expect(out).toBe('{\\kf100\\fs150\\c&H00FFFF&}ab{\\fs100\\c&H39FFB4&}cd')
  })

  it('emits exactly ONE `\\kf` per word so the fill crosses runs continuously', () => {
    const out = buildKaraokeSweepAssText([w(0, 1, 'abcd')], 0, 1, id, undefined, emphasis)
    expect((out.match(/\\kf/g) ?? []).length).toBe(1)
  })

  it('keeps timing identical whether or not the word is emphasised', () => {
    const plain = buildKaraokeSweepAssText([w(0, 0.7, 'abcd')], 0, 1, id)
    const emph = buildKaraokeSweepAssText([w(0, 0.7, 'abcd')], 0, 1, id, undefined, emphasis)
    expect(plain).toContain('\\kf70')
    expect(emph).toContain('\\kf70')
  })
})

describe('sweepWordTimings — preview mirrors the emitter', () => {
  it('matches the durations the emitter writes', () => {
    const words = [w(0, 0.5, 'hello'), w(1.5, 2.0, ' world')]
    const timings = sweepWordTimings(words, 0, 2.5)
    expect(timings).toEqual([
      { startSec: 0, durationSec: 0.5 },
      { startSec: 1.5, durationSec: 0.5 },
    ])
    // and the emitter agrees, in centiseconds
    const out = buildKaraokeSweepAssText(words, 0, 2.5, id)
    for (const t of timings) expect(out).toContain(`\\kf${Math.round(t.durationSec * 100)}`)
  })

  it('applies the same degenerate-timing fallback as the emitter', () => {
    expect(sweepWordTimings([w(0, 0, 'a')], 0, 2)).toEqual([
      { startSec: 0, durationSec: 2 },
    ])
  })
})
