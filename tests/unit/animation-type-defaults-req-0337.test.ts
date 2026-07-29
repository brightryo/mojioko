import { describe, it, expect } from 'vitest'
import {
  ANIMATION_DURATION_MAX_SEC,
  ANIMATION_DURATION_MIN_SEC,
  ANIMATION_DURATION_STEP_SEC,
  ANIMATION_TYPE_DEFAULTS,
  SELECTABLE_ANIMATION_TYPES,
  animationEntryFields,
  animationFieldsForNewCue,
  animationFieldsForTypeChange,
  animationUiValue,
  resolveAnimation,
  strengthToStartScalePercent,
  type AnimationType,
} from '../../src/shared/cue-animation'

/**
 * REQ-0337 §1 — per-type animation defaults.
 *
 * Before this REQ, changing the animation type re-seeded the STRENGTH
 * (REQ-0331) but carried the duration and the two timing switches over
 * unchanged.  One parameter followed the type and the rest did not, which
 * the owner reported as a bug.  The fix is `ANIMATION_TYPE_DEFAULTS` plus
 * a type-change handler that writes every parameter from it.
 *
 * The subtle half is §1-4: the table is the starting point you get when you
 * PICK a type, and it must never overrule a value the user deliberately
 * SAVED as their new-cue default — while a type change made *inside* that
 * same defaults panel must still re-seed.  Both halves are pinned below.
 */
describe('REQ-0337 §1 — per-type animation defaults', () => {
  describe('§1-2 — the table matches the owner-specified values', () => {
    it('fade = 0.2s, both ends on', () => {
      expect(ANIMATION_TYPE_DEFAULTS.fade.durationSec).toBeCloseTo(0.2, 6)
      expect(ANIMATION_TYPE_DEFAULTS.fade.inEnabled).toBe(true)
      expect(ANIMATION_TYPE_DEFAULTS.fade.outEnabled).toBe(true)
    })

    it('scale = 0.4s, strength 30 → start scale 70 %', () => {
      expect(ANIMATION_TYPE_DEFAULTS.scale.durationSec).toBeCloseTo(0.4, 6)
      expect(ANIMATION_TYPE_DEFAULTS.scale.strength).toBe(30)
      expect(animationFieldsForTypeChange('scale').startScalePercent).toBe(70)
    })

    it('pop = 0.4s, strength 100 → start scale 0 % (grows from nothing)', () => {
      expect(ANIMATION_TYPE_DEFAULTS.pop.durationSec).toBeCloseTo(0.4, 6)
      expect(ANIMATION_TYPE_DEFAULTS.pop.strength).toBe(100)
      expect(animationFieldsForTypeChange('pop').startScalePercent).toBe(0)
    })

    it('blur = 0.8s, strength 30 px', () => {
      expect(ANIMATION_TYPE_DEFAULTS.blur.durationSec).toBeCloseTo(0.8, 6)
      expect(ANIMATION_TYPE_DEFAULTS.blur.strength).toBe(30)
      expect(animationFieldsForTypeChange('blur').blurPx).toBe(30)
    })

    it('every seeded duration is reachable by the duration slider', () => {
      for (const type of SELECTABLE_ANIMATION_TYPES) {
        const d = ANIMATION_TYPE_DEFAULTS[type].durationSec
        expect(d).toBeGreaterThanOrEqual(ANIMATION_DURATION_MIN_SEC)
        expect(d).toBeLessThanOrEqual(ANIMATION_DURATION_MAX_SEC)
        // The slider's draft is an integer step index; a default that is not
        // on a step boundary would snap the moment the user touched it.
        const steps = d / ANIMATION_DURATION_STEP_SEC
        expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9)
      }
    })

    /**
     * ★ §1-3 — the compile-time half of this is the `-?` mapped type on
     * `ANIMATION_TYPE_DEFAULTS`; adding a member to `AnimationType` without
     * defaults fails `tsc` (verified by probe in RES-0337).  This is the
     * runtime companion: a type present in the union but seeded with a
     * placeholder object would still pass `tsc`.
     */
    it('★ every animation type has usable defaults, not placeholder holes', () => {
      const all = Object.keys(ANIMATION_TYPE_DEFAULTS) as AnimationType[]
      expect(all.length).toBeGreaterThan(0)
      for (const type of all) {
        const seed = animationFieldsForTypeChange(type)
        expect(seed.type).toBe(type)
        expect(Number.isFinite(seed.durationSec)).toBe(true)
        expect(seed.durationSec).toBeGreaterThan(0)
        expect(Number.isFinite(seed.startScalePercent)).toBe(true)
        expect(Number.isFinite(seed.blurPx)).toBe(true)
      }
    })
  })

  describe('§1 — changing the type writes ALL parameters', () => {
    /**
     * The complaint in one test: a cue set up as a long, entrance-only
     * scale, switched to pop.  Before this REQ it kept 0.9 s and kept the
     * exit switch off; now it takes pop's whole row.
     */
    it('★ duration and timing follow the type, as the strength already did', () => {
      const current = {
        type: 'scale' as const,
        inEnabled: true,
        outEnabled: false,
        durationSec: 0.9,
        startScalePercent: 70,
        blurPx: 30,
      }
      const written = animationEntryFields(current, animationFieldsForTypeChange('pop'))
      expect(written.animationType).toBe('pop')
      expect(written.animationDurationSec).toBeCloseTo(0.4, 6)
      expect(written.animationInEnabled).toBe(true)
      // The carried-over `outEnabled: false` is what made the old behaviour
      // inconsistent; the seed overwrites it.
      expect(written.animationOutEnabled).toBe(true)
      expect(written.animationStartScalePercent).toBe(0)
    })

    it('a partial patch (dragging one slider) still leaves the rest alone', () => {
      const current = {
        type: 'blur' as const,
        inEnabled: false,
        outEnabled: true,
        durationSec: 0.7,
        startScalePercent: 70,
        blurPx: 25,
      }
      const written = animationEntryFields(current, { blurPx: 33 })
      expect(written.animationBlurPx).toBe(33)
      expect(written.animationType).toBe('blur')
      expect(written.animationDurationSec).toBeCloseTo(0.7, 6)
      expect(written.animationInEnabled).toBe(false)
    })
  })

  /**
   * ★ §1-4 — the two halves that pull in opposite directions.
   */
  describe('§1-4 — the table vs. the saved TranscriptionDefaults', () => {
    // The owner's own example: blur saved with a 0.5 s duration, which is
    // NOT blur's table default of 0.8 s.
    const saved = {
      animationType: 'blur' as const,
      animationInEnabled: true,
      animationOutEnabled: false,
      animationDurationSec: 0.5,
      animationStartScalePercent: 70,
      animationBlurPx: 24,
    }

    it('★ half 1 — a NEW cue takes the saved defaults VERBATIM, not the table', () => {
      const fields = animationFieldsForNewCue(saved)
      expect(fields.animationType).toBe('blur')
      // 0.5, not ANIMATION_TYPE_DEFAULTS.blur.durationSec (0.8).
      expect(fields.animationDurationSec).toBeCloseTo(0.5, 6)
      expect(fields.animationDurationSec)
        .not.toBeCloseTo(ANIMATION_TYPE_DEFAULTS.blur.durationSec, 6)
      expect(fields.animationOutEnabled).toBe(false)
      expect(fields.animationBlurPx).toBe(24)
    })

    it('half 1 — and the resolved cue really does animate for 0.5 s', () => {
      const spec = resolveAnimation({ fadeDurationSec: 0, ...animationFieldsForNewCue(saved) })
      expect(spec.type).toBe('blur')
      expect(spec.durationSec).toBeCloseTo(0.5, 6)
      expect(spec.outEnabled).toBe(false)
    })

    it('★ half 2 — changing the TYPE inside the defaults panel re-seeds everything', () => {
      // Exactly what `DefaultStyleControls` computes: the resolved saved
      // defaults as the control's value, patched by the control's own
      // type-change seed, written back through the shared mapper.
      const current = animationUiValue(resolveAnimation(saved))
      expect(current.durationSec).toBeCloseTo(0.5, 6)

      const written = animationEntryFields(current, animationFieldsForTypeChange('pop'))
      expect(written.animationType).toBe('pop')
      expect(written.animationDurationSec).toBeCloseTo(0.4, 6)
      expect(written.animationOutEnabled).toBe(true)
      expect(written.animationStartScalePercent).toBe(0)
    })

    it('half 2 — the defaults panel and the inspector re-seed identically', () => {
      // The two surfaces render the same control and call the same mapper,
      // so "identical" is structural; this pins that nothing reintroduces a
      // surface-specific seed.
      const inspectorCurrent = animationUiValue(resolveAnimation({
        animationType: 'scale',
        animationDurationSec: 0.9,
        animationOutEnabled: false,
      }))
      const defaultsCurrent = animationUiValue(resolveAnimation(saved))
      for (const type of SELECTABLE_ANIMATION_TYPES) {
        const seed = animationFieldsForTypeChange(type)
        expect(animationEntryFields(inspectorCurrent, seed))
          .toEqual(animationEntryFields(defaultsCurrent, seed))
      }
    })
  })

  describe('§1-5 — no migration; existing cues are untouched', () => {
    it('a legacy fade-only cue still resolves exactly as before', () => {
      const spec = resolveAnimation({ fadeDurationSec: 0.3 })
      expect(spec.type).toBe('fade')
      expect(spec.durationSec).toBeCloseTo(0.3, 6)
    })

    it('★ an explicit fade with no stored duration keeps 0.4s, NOT the table 0.2s', () => {
      // `resolveAnimation` describes data that already exists, so it must
      // not re-point absent fields at the new table — that would silently
      // change how shipped projects look.
      const spec = resolveAnimation({ animationType: 'fade' })
      expect(spec.durationSec).toBeCloseTo(0.4, 6)
      expect(ANIMATION_TYPE_DEFAULTS.fade.durationSec).toBeCloseTo(0.2, 6)
    })

    it('an explicit scale/pop with no stored strength keeps its old start scale', () => {
      expect(resolveAnimation({ animationType: 'scale' }).startScale).toBeCloseTo(0.7, 6)
      expect(resolveAnimation({ animationType: 'pop' }).startScale).toBeCloseTo(0, 6)
    })
  })

  describe('strength ↔ start scale conversion', () => {
    it('is an involution, so a UI round-trip cannot drift', () => {
      for (const s of [0, 10, 30, 55, 70, 100]) {
        expect(strengthToStartScalePercent(strengthToStartScalePercent(s))).toBe(s)
      }
    })
  })
})
