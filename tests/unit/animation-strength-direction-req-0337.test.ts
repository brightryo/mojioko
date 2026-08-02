import { describe, it, expect } from 'vitest'
import {
  ANIMATION_BLUR_MAX_PX,
  ANIMATION_BLUR_MIN_PX,
  ANIMATION_BLUR_STEP_PX,
  ANIMATION_START_SCALE_MAX_PCT,
  ANIMATION_START_SCALE_MIN_PCT,
  ANIMATION_STRENGTH_SCALE_MAX,
  ANIMATION_STRENGTH_SCALE_MIN,
  ANIMATION_STRENGTH_SCALE_STEP,
  BLUR_MAX_PX,
  animationTransformAt,
  resolveAnimation,
  startScalePercentToStrength,
  strengthToStartScalePercent,
  type AnimationSpec,
} from '../../src/shared/cue-animation'

/**
 * REQ-0337 §2 — 「強さ」 must mean the same direction for every type.
 *
 * The owner's report: under ONE label the scale ran backwards between
 * types.  `scale` / `pop` store a START SCALE (0 % = the biggest movement,
 * 100 % = no effect at all); `blur` stores a radius, where bigger is
 * stronger.  Hence "why does an animation happen at start scale 0 %?" and
 * "is strength 0 the same as off?".
 *
 * The fix is a DISPLAY inversion only (§2-3): the stored field keeps its
 * meaning, so there is no migration, the curves are untouched, and the ASS
 * writer emits exactly what it did before.  These tests pin both the new
 * direction and the fact that the stored meaning did not move.
 */

const CUE_START = 0
const CUE_END = 10

/** A cue's visual state at the very start of its entrance ramp. */
function atRampStart(spec: AnimationSpec) {
  return animationTransformAt(spec, CUE_START, CUE_END, CUE_START)
}

/** Resolve a cue authored with a DISPLAYED strength. */
function specForStrength(type: 'scale' | 'pop' | 'blur', strength: number): AnimationSpec {
  return resolveAnimation(
    type === 'blur'
      ? { animationType: type, animationDurationSec: 0.4, animationBlurPx: strength }
      : {
          animationType: type,
          animationDurationSec: 0.4,
          animationStartScalePercent: strengthToStartScalePercent(strength),
        },
  )
}

describe('REQ-0337 §2 — strength runs the same way for every type', () => {
  describe('§2-2 — larger strength is always MORE effect', () => {
    it('★ scale: raising the strength moves the cue further from natural size', () => {
      let previous = -Infinity
      for (let s = ANIMATION_STRENGTH_SCALE_MIN; s <= ANIMATION_STRENGTH_SCALE_MAX; s += 10) {
        const travel = Math.abs(1 - atRampStart(specForStrength('scale', s)).scale)
        expect(travel).toBeGreaterThan(previous)
        previous = travel
      }
    })

    it('★ pop: same direction', () => {
      let previous = -Infinity
      for (let s = ANIMATION_STRENGTH_SCALE_MIN; s <= ANIMATION_STRENGTH_SCALE_MAX; s += 10) {
        const travel = Math.abs(1 - atRampStart(specForStrength('pop', s)).scale)
        expect(travel).toBeGreaterThan(previous)
        previous = travel
      }
    })

    it('★ blur: same direction (it always ran this way; now it agrees)', () => {
      let previous = -Infinity
      for (let s = ANIMATION_BLUR_MIN_PX; s <= ANIMATION_BLUR_MAX_PX; s += 5) {
        const blur = atRampStart(specForStrength('blur', s)).blurPx
        expect(blur).toBeGreaterThan(previous)
        previous = blur
      }
    })

    it('the owner-visible anchors: strength 30 → 70 % start, strength 100 → 0 %', () => {
      expect(strengthToStartScalePercent(30)).toBe(70)
      expect(strengthToStartScalePercent(100)).toBe(0)
      expect(startScalePercentToStrength(70)).toBe(30)
    })
  })

  /**
   * ★ §2-3 is a hard constraint: the stored value keeps its old meaning.
   */
  describe('§2-3 — the STORED value is still a start scale', () => {
    it('★ animationStartScalePercent 70 still resolves to startScale 0.7', () => {
      const spec = resolveAnimation({ animationType: 'scale', animationStartScalePercent: 70 })
      expect(spec.startScale).toBeCloseTo(0.7, 6)
      // …and the curve really does begin there, i.e. the inversion did not
      // leak into the shared model.
      expect(atRampStart(spec).scale).toBeCloseTo(0.7, 6)
    })

    it('★ a smaller stored number is a BIGGER effect (unchanged semantics)', () => {
      const shallow = resolveAnimation({ animationType: 'scale', animationStartScalePercent: 80 })
      const deep = resolveAnimation({ animationType: 'scale', animationStartScalePercent: 20 })
      expect(deep.startScale).toBeLessThan(shallow.startScale)
    })

    it('pop still stores 0 for "grow from nothing"', () => {
      expect(resolveAnimation({ animationType: 'pop' }).startScale).toBeCloseTo(0, 6)
    })
  })

  describe('§2-4 — the ranges the owner specified', () => {
    // REQ-0377 §B raised the ceiling 40 → 80 (parity measured safe to ~100 by
    // scripts/verify-blur-parity).  Min/step/default are unchanged, so existing
    // cues are byte-identical.
    it('blur is 20–80 px, step 1, default 30', () => {
      expect(ANIMATION_BLUR_MIN_PX).toBe(20)
      expect(ANIMATION_BLUR_MAX_PX).toBe(80)
      expect(ANIMATION_BLUR_STEP_PX).toBe(1)
      expect(BLUR_MAX_PX).toBe(30)
    })

    it('scale/pop strength is 10–100, step 5', () => {
      expect(ANIMATION_STRENGTH_SCALE_MIN).toBe(10)
      expect(ANIMATION_STRENGTH_SCALE_MAX).toBe(100)
      expect(ANIMATION_STRENGTH_SCALE_STEP).toBe(5)
    })

    it('the stored start-scale bounds are DERIVED, so they cannot drift', () => {
      expect(ANIMATION_START_SCALE_MIN_PCT)
        .toBe(strengthToStartScalePercent(ANIMATION_STRENGTH_SCALE_MAX))
      expect(ANIMATION_START_SCALE_MAX_PCT)
        .toBe(strengthToStartScalePercent(ANIMATION_STRENGTH_SCALE_MIN))
      expect(ANIMATION_START_SCALE_MIN_PCT).toBe(0)
      expect(ANIMATION_START_SCALE_MAX_PCT).toBe(90)
    })
  })

  /**
   * ★ §2-5 — the clamp lives in the SHARED resolver, so the preview and
   * the burn-in can never see different numbers.  A UI-side clamp would
   * leave the ASS writer emitting the stale value.
   */
  describe('§2-5 — old out-of-range values are clamped in resolveAnimation', () => {
    it('★ a cue holding the old 8 px blur default is raised to the new floor', () => {
      const spec = resolveAnimation({ animationType: 'blur', animationBlurPx: 8 })
      expect(spec.blurMaxPx).toBe(ANIMATION_BLUR_MIN_PX)
      // The clamped value is what the CURVE sees — this is the property
      // that makes preview and burn agree, since both read this spec.
      expect(atRampStart(spec).blurPx).toBeCloseTo(ANIMATION_BLUR_MIN_PX, 6)
    })

    it('a blur above the new ceiling is capped', () => {
      expect(resolveAnimation({ animationType: 'blur', animationBlurPx: 999 }).blurMaxPx)
        .toBe(ANIMATION_BLUR_MAX_PX)
    })

    it('★ a 100 % start scale (= no movement at all) is pulled down to 90 %', () => {
      const spec = resolveAnimation({ animationType: 'scale', animationStartScalePercent: 100 })
      expect(spec.startScale).toBeCloseTo(0.9, 6)
      // The point of the floor: the cue still visibly scales.
      expect(atRampStart(spec).scale).toBeLessThan(1)
    })

    it('a negative start scale is floored at 0', () => {
      expect(resolveAnimation({ animationType: 'scale', animationStartScalePercent: -50 }).startScale)
        .toBeCloseTo(0, 6)
    })
  })

  /**
   * ★ §2-6 — the reason the floors are above zero.  If someone later
   * "fixes" the ranges down to 0, this fails and says why.
   */
  describe('§2-6 — minimum strength is not "off", and must not degenerate', () => {
    it('★ at minimum strength a scale still scales (it does not become a fade)', () => {
      const spec = specForStrength('scale', ANIMATION_STRENGTH_SCALE_MIN)
      expect(atRampStart(spec).scale).toBeLessThan(1)
    })

    it('★ at minimum strength a blur still blurs', () => {
      const spec = specForStrength('blur', ANIMATION_BLUR_MIN_PX)
      expect(atRampStart(spec).blurPx).toBeGreaterThan(0)
    })

    it('every non-fade type carries an opacity ramp, so "weakest" still fades', () => {
      for (const type of ['scale', 'pop', 'blur'] as const) {
        const spec = specForStrength(
          type,
          type === 'blur' ? ANIMATION_BLUR_MIN_PX : ANIMATION_STRENGTH_SCALE_MIN,
        )
        expect(atRampStart(spec).opacity).toBe(0)
      }
    })
  })
})
