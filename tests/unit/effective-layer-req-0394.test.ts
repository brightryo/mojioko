import { describe, it, expect } from 'vitest'
import { computeEffectiveLayers } from '../../src/shared/effective-layer'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0394 — effective z-order layers: the single derivation the timeline rows,
 * preview z-index, and burn ASS Layer column all read.  Overlapping cues always
 * get distinct layers (rows never collide); the stored `layer` acts as a floor
 * (z-order intent).
 */

// Minimal entry — only the fields computeEffectiveLayers reads.
function cue(id: string, startSec: number, endSec: number, layer?: number): SubtitleEntry {
  return { id, startSec, endSec, ...(layer !== undefined ? { layer } : {}) } as unknown as SubtitleEntry
}

const eff = (entries: SubtitleEntry[]) => computeEffectiveLayers(entries)

describe('REQ-0394 — computeEffectiveLayers', () => {
  it('empty input → empty map', () => {
    expect(eff([]).size).toBe(0)
  })

  it('non-overlapping cues all share layer 0 (the common sequential case)', () => {
    const m = eff([cue('a', 0, 1), cue('b', 1, 2), cue('c', 2, 3)])
    expect(m.get('a')).toBe(0)
    expect(m.get('b')).toBe(0)
    expect(m.get('c')).toBe(0)
  })

  it('contact (A.end === B.start) is NOT an overlap → same layer', () => {
    const m = eff([cue('a', 0, 2), cue('b', 2, 4)])
    expect(m.get('a')).toBe(0)
    expect(m.get('b')).toBe(0)
  })

  it('two time-overlapping cues get distinct layers (later = front)', () => {
    const m = eff([cue('a', 0, 2), cue('b', 1, 3)])
    expect(m.get('a')).toBe(0)
    expect(m.get('b')).toBe(1)
  })

  it('three mutually overlapping cues climb 0/1/2', () => {
    const m = eff([cue('a', 0, 3), cue('b', 1, 4), cue('c', 2, 5)])
    expect(m.get('a')).toBe(0)
    expect(m.get('b')).toBe(1)
    expect(m.get('c')).toBe(2)
  })

  it('a non-overlapping neighbour reuses the freed layer 0', () => {
    // a & b overlap; c is later and overlaps no one.
    const m = eff([cue('a', 0, 2), cue('b', 1, 3), cue('c', 5, 7)])
    expect(m.get('a')).toBe(0)
    expect(m.get('b')).toBe(1)
    expect(m.get('c')).toBe(0)
  })

  it('stored layer is a floor: a brought-to-front cue sits at least that high', () => {
    const m = eff([cue('a', 0, 2), cue('front', 0, 2, 5)])
    // both overlap; `front` has floor 5, `a` floor 0 → a=0, front=5.
    expect(m.get('a')).toBe(0)
    expect(m.get('front')).toBe(5)
  })

  it('send-to-back (negative intent) resolves to a negative effective layer', () => {
    const m = eff([cue('a', 0, 2), cue('back', 0, 2, -1)])
    expect(m.get('back')).toBe(-1)
    expect(m.get('a')).toBe(0)
  })

  it('a floor collides with an overlapping cue → bumped above it', () => {
    // both floor 2 and overlapping → 2 and 3.
    const m = eff([cue('a', 0, 2, 2), cue('b', 1, 3, 2)])
    expect(m.get('a')).toBe(2)
    expect(m.get('b')).toBe(3)
  })

  it('times override pins a cue\'s overlap (drag): snapshot times decide its layer', () => {
    // Live: a(0-2) and b(1.5-3) overlap → b would be 1.  With b pinned to a
    // pre-drag snapshot (5-7, no overlap) b stays at layer 0.
    const entries = [cue('a', 0, 2), cue('b', 1.5, 3)]
    const override = new Map([['b', { startSec: 5, endSec: 7 }]])
    const m = computeEffectiveLayers(entries, override)
    expect(m.get('a')).toBe(0)
    expect(m.get('b')).toBe(0)
  })
})
