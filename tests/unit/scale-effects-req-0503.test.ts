import { describe, it, expect } from 'vitest'
import { scaleEntries, contentScaleFactor } from '../../src/main/cli/scale-video'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0503 §1 — downscaling must not delete a requested effect.
 *
 * `scaleEntries` shipped with a `px()` helper that floors at 1, wired to
 * `fontSizePx` alone (REQ-0447 Phase 2b). Outline and shadow used plain
 * rounding, so at 4K → shorts (factor 0.28) `--outline 1` became 0: the outline
 * vanished, and the background box vanished with it, because libass draws the
 * box AS the border. That contradicts the function's own contract ("so its
 * apparent size is preserved").
 *
 * The fix cannot be "use px() everywhere": `outlineThicknessPx: 0` and
 * `shadowDepth: 0` are legitimate values meaning "off", and flooring them would
 * write a value the caller never asked for — the mirror-image failure. Hence a
 * conditional floor, and hence this test asserting BOTH halves.
 */

const e = (over: Partial<SubtitleEntry> = {}): SubtitleEntry =>
  ({
    id: 'x', startSec: 0, endSec: 1, text: 't', isDeleted: false, isEdited: false,
    fontSizePx: 100, outlineThicknessPx: 4, verticalMarginPx: 40, ...over,
  }) as SubtitleEntry

/** 3840×2160 → 1080×1920 ("shorts"), the case that motivated the fix. */
const F_4K_SHORTS = contentScaleFactor(3840, 2160, 1080, 1920)

describe('REQ-0503 §1 — a requested effect survives downscaling', () => {
  it('the 4K → shorts factor really is small enough to round 1 away', () => {
    // Guards the premise: if this stopped being < 0.5 the test below would pass
    // for the wrong reason.
    expect(F_4K_SHORTS).toBeCloseTo(0.28125, 5)
    expect(Math.round(1 * F_4K_SHORTS)).toBe(0)
  })

  it('outline 1 survives as 1 instead of rounding to 0', () => {
    const [out] = scaleEntries([e({ outlineThicknessPx: 1 })], F_4K_SHORTS)
    expect(out.outlineThicknessPx).toBe(1)
  })

  it('shadow 1 survives as 1', () => {
    const [out] = scaleEntries([e({ shadowDepth: 1 })], F_4K_SHORTS)
    expect(out.shadowDepth).toBe(1)
  })

  // ---- the other half: an explicit zero must stay zero --------------------
  it('outline 0 stays 0 (never pushed up to 1)', () => {
    const [out] = scaleEntries([e({ outlineThicknessPx: 0 })], F_4K_SHORTS)
    expect(out.outlineThicknessPx).toBe(0)
  })

  it('shadow 0 stays 0', () => {
    const [out] = scaleEntries([e({ shadowDepth: 0 })], F_4K_SHORTS)
    expect(out.shadowDepth).toBe(0)
  })

  it('normal values are unaffected — the floor only catches the round-to-zero case', () => {
    const [out] = scaleEntries([e({ outlineThicknessPx: 10, shadowDepth: 8 })], 0.5)
    expect(out.outlineThicknessPx).toBe(5)
    expect(out.shadowDepth).toBe(4)
  })

  it('upscaling is untouched', () => {
    const [out] = scaleEntries([e({ outlineThicknessPx: 2, shadowDepth: 3 })], 2)
    expect(out.outlineThicknessPx).toBe(4)
    expect(out.shadowDepth).toBe(6)
  })
})

describe('REQ-0503 §1 — positions are NOT floored (they are coordinates, not effects)', () => {
  // Flooring a coordinate would move a cue somewhere it was never asked to be,
  // and a margin that scales to 0 is genuinely at the edge.
  it('verticalMarginPx may legitimately reach 0', () => {
    const [out] = scaleEntries([e({ verticalMarginPx: 1 })], F_4K_SHORTS)
    expect(out.verticalMarginPx).toBe(0)
  })

  it('posX / posY may legitimately reach 0', () => {
    const [out] = scaleEntries([e({ posX: 1, posY: 1 })], F_4K_SHORTS)
    expect(out.posX).toBe(0)
    expect(out.posY).toBe(0)
  })

  it('fontSizePx keeps its unconditional floor (0 is never a size)', () => {
    const [out] = scaleEntries([e({ fontSizePx: 1 })], 0.1)
    expect(out.fontSizePx).toBe(1)
  })
})

/**
 * The exact blast radius, pinned so the report in RES-0503 §1.4 cannot drift
 * from the code. Output changes only for a value of 1 at factors below 0.5;
 * every common preset path is untouched.
 */
describe('REQ-0503 §1-4 — which inputs actually change', () => {
  const oldRound = (v: number, f: number): number => Math.round(v * f)
  const changedValues = (f: number): number[] => {
    const changed: number[] = []
    for (let v = 0; v <= 50; v++) {
      const [out] = scaleEntries([e({ outlineThicknessPx: v })], f)
      if (out.outlineThicknessPx !== oldRound(v, f)) changed.push(v)
    }
    return changed
  }

  it.each([
    ['3840x2160 → shorts', contentScaleFactor(3840, 2160, 1080, 1920), [1]],
    ['3840x2160 → 720p', contentScaleFactor(3840, 2160, 1280, 720), [1]],
    ['2560x1440 → shorts', contentScaleFactor(2560, 1440, 1080, 1920), [1]],
    // At factors ≥ 0.5, round(1 × f) is already ≥ 1, so nothing changes.
    ['1920x1080 → shorts', contentScaleFactor(1920, 1080, 1080, 1920), []],
    ['1920x1080 → 720p', contentScaleFactor(1920, 1080, 1280, 720), []],
    ['1920x1080 → square', contentScaleFactor(1920, 1080, 1080, 1080), []],
  ])('%s changes only these inputs', (_name, f, expected) => {
    expect(changedValues(f)).toEqual(expected)
  })

  it('0 is never among the changed values, at any factor', () => {
    for (const f of [0.1, 0.28125, 0.4, 0.5, 0.5625, 1, 2]) {
      expect(changedValues(f)).not.toContain(0)
    }
  })
})
