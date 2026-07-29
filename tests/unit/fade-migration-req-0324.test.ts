import { describe, expect, it } from 'vitest'
import { resolveAnimation, animationTransformAt } from '../../src/shared/cue-animation'

/**
 * Contract for the preview-side fade ramp (REQ-20260615-048).
 *
 * The helper must mirror libass `\fad(t1,t2)` so the preview matches
 * the burn-in pixel-for-pixel.  These cases pin the linear interpolation,
 * the disabled / zero-duration short-circuit, the out-of-range guard,
 * and the overlapping-ramp behaviour for captions shorter than 2·N.
 */


/**
 * REQ-0324 §1 — these 15 cases are the ORIGINAL `computeFadeOpacity` suite,
 * carried over verbatim when REQ-0323 replaced that module with the shared
 * `cue-animation.ts`.  They are kept (rather than deleted as redundant)
 * because they are the only record of the fade semantics as the owner
 * originally specified them, and they now double as a migration test: the
 * inputs go in as a LEGACY cue (`fadeDurationSec` only, no `animation*`
 * fields), so every one of them also proves the migration path returns the
 * pre-REQ-0323 numbers.
 */
function computeFadeOpacity(args: {
  currentTimeSec: number
  startSec: number
  endSec: number
  fadeDurationSec: number
}): number {
  const { currentTimeSec, startSec, endSec, fadeDurationSec } = args
  const spec = resolveAnimation({ fadeDurationSec })
  // The old helper returned 0 outside the cue; the new one describes only
  // the animation and leaves visibility to the caller (REQ-0195 §2), so the
  // range check that the caller now owns is applied here.
  if (!(currentTimeSec >= startSec && currentTimeSec <= endSec)) return 0
  return animationTransformAt(spec, startSec, endSec, currentTimeSec).opacity
}

describe('computeFadeOpacity', () => {
  const baseEntry = {
    startSec: 1.0,
    endSec: 5.0,
    fadeDurationSec: 0.2,
  }

  describe('zero / negative duration short-circuits', () => {
    // REQ-20260615-050 — the legacy `fadeEnabled` boolean was retired in
    // favour of treating `fadeDurationSec === 0` as "no fade".  The
    // helper must still short-circuit defensively on negative input in
    // case a caller forgets to clamp.

    it('returns 1 when fadeDurationSec is 0 (= REQ-050 OFF)', () => {
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

  describe('short caption — the requested windows do not fit (duration < 2·N)', () => {
    // Duration = 0.3, fade = 0.2 → 0.4 s of ramp requested inside a 0.3 s
    // cue.  REQ-0333 §4 shrinks both windows by the same factor to 0.15 s
    // each, instead of the pre-REQ-0333 `min()` triangle that peaked at
    // 0.75 and never settled.
    //
    // The triangle was not a behaviour worth preserving: it was never what
    // the MP4 showed.  `\fad(200,200)` on a 300 ms event gives libass a t2
    // of 200 past a t3 of 100, its control points cross, and its alpha
    // reaches 1 and then JUMPS.  Preview and burn disagreed; now both
    // describe the same 0.15 + 0.15 pair.
    const short = { startSec: 1.0, endSec: 1.3, fadeDurationSec: 0.2 }

    it('★ settles exactly at the midpoint, where the two windows meet', () => {
      expect(computeFadeOpacity({ ...short, currentTimeSec: 1.15 })).toBeCloseTo(1, 10)
    })

    it('★ the two ramps are symmetric about that midpoint', () => {
      for (const d of [0.15, 0.10, 0.05, 0]) {
        expect(computeFadeOpacity({ ...short, currentTimeSec: 1.15 - d }))
          .toBeCloseTo(computeFadeOpacity({ ...short, currentTimeSec: 1.15 + d }), 10)
      }
      // Half-way up each shrunk window.
      expect(computeFadeOpacity({ ...short, currentTimeSec: 1.075 })).toBeCloseTo(0.5, 10)
    })

    it('still starts and ends fully transparent', () => {
      expect(computeFadeOpacity({ ...short, currentTimeSec: 1.0 })).toBeCloseTo(0, 10)
      expect(computeFadeOpacity({ ...short, currentTimeSec: 1.3 })).toBeCloseTo(0, 10)
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
