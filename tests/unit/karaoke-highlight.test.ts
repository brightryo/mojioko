import { describe, it, expect } from 'vitest'
import { activeWordCountAtTime } from '../../src/renderer/lib/karaoke-highlight'
import type { WordSpan } from '../../src/shared/types'

/**
 * REQ-0286 §3 — pins the pure "which word is highlighted at time T"
 * resolver used by the subtitle-overlay's karaoke rAF loop.
 */

const words: WordSpan[] = [
  { startSec: 1.0, endSec: 1.4, text: 'hello' },
  { startSec: 1.5, endSec: 2.0, text: ' world' },
  { startSec: 2.0, endSec: 2.5, text: ' now' },
]

describe('REQ-0286 §3 — activeWordCountAtTime', () => {
  it('empty words → 0 regardless of currentTime', () => {
    expect(activeWordCountAtTime([], 0)).toBe(0)
    expect(activeWordCountAtTime([], 999)).toBe(0)
  })

  it('t before every word.startSec → 0 (nothing lit)', () => {
    expect(activeWordCountAtTime(words, 0)).toBe(0)
    expect(activeWordCountAtTime(words, 0.999)).toBe(0)
  })

  it('t at exactly word[0].startSec → 1 (word 0 is lit — inclusive threshold)', () => {
    expect(activeWordCountAtTime(words, 1.0)).toBe(1)
  })

  it('t between word[0].startSec and word[1].startSec → 1', () => {
    expect(activeWordCountAtTime(words, 1.2)).toBe(1)
    expect(activeWordCountAtTime(words, 1.4999)).toBe(1)
  })

  it('t at word[1].startSec → 2 (both lit)', () => {
    expect(activeWordCountAtTime(words, 1.5)).toBe(2)
  })

  it('t past all words → words.length (all lit — sticky highlight)', () => {
    expect(activeWordCountAtTime(words, 3.0)).toBe(3)
    expect(activeWordCountAtTime(words, 999)).toBe(3)
  })

  it('sticky highlight: t past word[i].endSec still keeps word[i] active', () => {
    // words[0] ends at 1.4 but is still lit at t=1.45 (before word 1 activates)
    expect(activeWordCountAtTime(words, 1.45)).toBe(1)
  })

  it('single-word cue', () => {
    const single: WordSpan[] = [{ startSec: 5, endSec: 6, text: 'hi' }]
    expect(activeWordCountAtTime(single, 4.9)).toBe(0)
    expect(activeWordCountAtTime(single, 5)).toBe(1)
    expect(activeWordCountAtTime(single, 999)).toBe(1)
  })
})
