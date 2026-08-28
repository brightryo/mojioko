import { describe, it, expect } from 'vitest'
import { computeFixedStackOffsets } from '../../src/shared/stack-offsets'
import type { SubtitleEntry } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-0465 §1 — the sliding-window rewrite of `computeFixedStackOffsets` (O(N²)
 * → O(N×C)) must be BIT-IDENTICAL to the old full-rescan, because the function
 * is shared with the burn path.  This fuzzes the optimized export against a
 * naive reference (a verbatim copy of the pre-REQ-0465 algorithm) on thousands
 * of random, startSec-ascending inputs — the strongest guarantee short of the
 * ASS baseline + pos-parity gates (which also cover it end-to-end).
 */

/** Verbatim copy of the pre-REQ-0465 O(N²) algorithm — the reference. */
function naiveComputeFixedStackOffsets(
  sortedEntries: readonly SubtitleEntry[],
  heightOf: (entry: SubtitleEntry) => number,
): Map<string, number> {
  const positions = new Map<string, number>()
  const heights = new Map<string, number>()
  const groupKey = (e: SubtitleEntry): string => `${e.horizontalPosition}_${e.verticalPosition}`
  const isPinned = (e: SubtitleEntry): boolean => e.posX !== undefined && e.posY !== undefined

  for (let i = 0; i < sortedEntries.length; i++) {
    const e = sortedEntries[i]
    if (isPinned(e)) continue
    const heightE = heightOf(e)
    const marginVe = e.verticalPosition === 'center' ? 0 : e.verticalMarginPx
    const keyE = groupKey(e)
    heights.set(e.id, heightE)
    const activePriors: { base: number; height: number }[] = []
    for (let j = 0; j < i; j++) {
      const p = sortedEntries[j]
      if (isPinned(p)) continue
      if (groupKey(p) !== keyE) continue
      if (p.startSec <= e.startSec && p.endSec > e.startSec) {
        const priorOffset = positions.get(p.id) ?? 0
        const priorMargin = p.verticalPosition === 'center' ? 0 : p.verticalMarginPx
        activePriors.push({ base: priorMargin + priorOffset, height: heights.get(p.id) ?? 0 })
      }
    }
    activePriors.sort((a, b) => a.base - b.base)
    let effectiveBase = marginVe
    for (const p of activePriors) {
      if (p.base >= effectiveBase + heightE) break
      effectiveBase = Math.max(effectiveBase, p.base + p.height)
    }
    positions.set(e.id, effectiveBase - marginVe)
  }
  return positions
}

// Deterministic LCG so the fuzz is reproducible (no Math.random).
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0xffffffff
  }
}

const H_POS = ['left', 'center', 'right'] as const
const V_POS = ['top', 'center', 'bottom'] as const

function randomEntry(id: string, rng: () => number): SubtitleEntry {
  const start = Math.floor(rng() * 100)
  const dur = 1 + Math.floor(rng() * 8)
  const pinned = rng() < 0.15
  const base = {
    startSec: start,
    endSec: start + dur,
    text: id,
    fontSizePx: 64,
    textColorHex: '#ffffff',
    outlineColorHex: '#000000',
    outlineThicknessPx: 2,
    fadeDurationSec: 0,
    ...makeEntryLayoutDefaults(),
    horizontalPosition: H_POS[Math.floor(rng() * H_POS.length)],
    verticalPosition: V_POS[Math.floor(rng() * V_POS.length)],
    verticalMarginPx: Math.floor(rng() * 200),
    ...(pinned ? { posX: Math.floor(rng() * 100), posY: Math.floor(rng() * 100) } : {}),
  }
  return { id, ...base, isDeleted: false, isEdited: false, original: { ...base } }
}

describe('REQ-0465 §1 — computeFixedStackOffsets sliding window ≡ naive rescan', () => {
  it('matches the reference on 400 random startSec-sorted inputs', () => {
    const rng = makeRng(0xC0FFEE)
    for (let trial = 0; trial < 400; trial++) {
      const n = Math.floor(rng() * 40)
      const entries = Array.from({ length: n }, (_, k) => randomEntry(`e${k}`, rng))
      // Contract: ascending startSec (ties keep array order = ASS Dialogue order).
      entries.sort((a, b) => a.startSec - b.startSec)
      // Vary the injected height too — the greedy gap-fill depends on it.
      const heightOf = (e: SubtitleEntry): number => 8 + ((e.id.charCodeAt(1) || 0) % 5) * 6
      const got = computeFixedStackOffsets(entries, heightOf)
      const want = naiveComputeFixedStackOffsets(entries, heightOf)
      expect(got.size).toBe(want.size)
      for (const [id, v] of want) expect(got.get(id)).toBe(v)
    }
  })

  it('matches on a dense all-overlapping cluster (worst-case concurrency)', () => {
    const rng = makeRng(42)
    const entries = Array.from({ length: 60 }, (_, k) => {
      const base = {
        startSec: 0, endSec: 100, text: `e${k}`, fontSizePx: 64,
        textColorHex: '#fff', outlineColorHex: '#000', outlineThicknessPx: 2, fadeDurationSec: 0,
        ...makeEntryLayoutDefaults(),
        verticalPosition: V_POS[Math.floor(rng() * V_POS.length)],
        verticalMarginPx: Math.floor(rng() * 100),
      }
      return { id: `e${k}`, ...base, isDeleted: false, isEdited: false, original: { ...base } }
    })
    const heightOf = (e: SubtitleEntry): number => 10 + (Number(e.id.slice(1)) % 4) * 5
    const got = computeFixedStackOffsets(entries, heightOf)
    const want = naiveComputeFixedStackOffsets(entries, heightOf)
    for (const [id, v] of want) expect(got.get(id)).toBe(v)
    expect(got.size).toBe(want.size)
  })
})
