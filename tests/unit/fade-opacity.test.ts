import { describe, expect, it } from 'vitest'
import { computeFadeOpacity } from '../../src/renderer/lib/fade-opacity'

/**
 * Contract for the preview-side fade ramp (REQ-20260615-048).
 *
 * The helper must mirror libass `\fad(t1,t2)` so the preview matches
 * the burn-in pixel-for-pixel.  These cases pin the linear interpolation,
 * the disabled / zero-duration short-circuit, the out-of-range guard,
 * and the overlapping-ramp behaviour for captions shorter than 2·N.
 */

describe('computeFadeOpacity', () => {
  const baseEntry = {
    startSec: 1.0,
    endSec: 5.0,
    fadeEnabled: true,
    fadeDurationSec: 0.2,
  }

  describe('disabled / zero short-circuits', () => {
    it('returns 1 when fadeEnabled is false', () => {
      expect(computeFadeOpacity({ ...baseEntry, fadeEnabled: false, currentTimeSec: 1.05 })).toBe(1)
    })

    it('returns 1 when fadeDurationSec is 0', () => {
      expect(computeFadeOpacity({ ...baseEntry, fadeDurationSec: 0, currentTimeSec: 1.05 })).toBe(1)
    })

    it('returns 1 when fadeDurationSec is negative (defensive)', () => {
      expect(computeFadeOpacity({ ...baseEntry, fadeDurationSec: -0.5, currentTimeSec: 1.05 })).toBe(1)
    })
  })

  describe('out-of-range guard', () => {
    it('returns 0 before the dialogue start', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 0.5 })).toBe(0)
    })

    it('returns 0 after the dialogue end', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 5.5 })).toBe(0)
    })
  })

  describe('fade-in ramp (linear)', () => {
    it('at the start time → 0', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 1.0 })).toBe(0)
    })

    it('at midway through fade-in (0.1 s of 0.2) → 0.5', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 1.1 })).toBeCloseTo(0.5, 10)
    })

    it('at fade-in completion → 1', () => {
      // `1.2 - 1.0` is 0.19999...96 in IEEE-754; the ramp lands at
      // ~0.99999...98, identical to 1 for any rendering purpose.
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 1.2 })).toBeCloseTo(1, 10)
    })
  })

  describe('full-alpha plateau', () => {
    it('at mid-dialogue → 1', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 3.0 })).toBe(1)
    })

    it('at the boundary entering fade-out → still 1', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 4.8 })).toBe(1)
    })
  })

  describe('fade-out ramp (linear, mirrors fade-in)', () => {
    it('at 0.1 s before end → 0.5', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 4.9 })).toBeCloseTo(0.5, 10)
    })

    it('at the end time → 0', () => {
      expect(computeFadeOpacity({ ...baseEntry, currentTimeSec: 5.0 })).toBe(0)
    })
  })

  describe('short caption — fade-in and fade-out overlap (duration < 2·N)', () => {
    // Duration = 0.3, fade = 0.2 → ramps overlap and meet at the midpoint (t=1.15).
    // Peak alpha = 0.15 / 0.2 = 0.75.
    const short = { startSec: 1.0, endSec: 1.3, fadeEnabled: true, fadeDurationSec: 0.2 }

    it('at the midpoint reaches the triangular peak (= duration/2 / fade)', () => {
      expect(computeFadeOpacity({ ...short, currentTimeSec: 1.15 })).toBeCloseTo(0.75, 10)
    })

    it('never reaches alpha 1 across the whole span', () => {
      for (let t = short.startSec; t <= short.endSec; t += 0.01) {
        expect(computeFadeOpacity({ ...short, currentTimeSec: t })).toBeLessThanOrEqual(0.75 + 1e-9)
      }
    })
  })

  describe('fade-duration setting changes are reflected', () => {
    it('doubling fadeDurationSec halves the ramp slope', () => {
      const t = 1.1 // 0.1 s into a 5 s clip starting at 1.0
      const a = computeFadeOpacity({ ...baseEntry, fadeDurationSec: 0.2, currentTimeSec: t })
      const b = computeFadeOpacity({ ...baseEntry, fadeDurationSec: 0.4, currentTimeSec: t })
      expect(a).toBeCloseTo(0.5, 10)
      expect(b).toBeCloseTo(0.25, 10)
    })
  })

  describe('non-finite inputs are clamped (defensive)', () => {
    it('NaN current time → 0 (out of range path)', () => {
      // NaN < startSec is false in JS; NaN > endSec is also false.  But
      // elapsed becomes NaN, ramp clamps to 0 via clamp01.
      const a = computeFadeOpacity({ ...baseEntry, currentTimeSec: Number.NaN })
      expect(a).toBe(0)
    })
  })
})
