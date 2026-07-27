import { describe, it, expect } from 'vitest'
import {
  resolveAnimation,
  animationTransformAt,
  animationKeyframes,
  animationWindows,
  animationFadeMs,
  isAnimationInert,
  NEUTRAL_TRANSFORM,
  SCALE_START,
  POP_OVERSHOOT,
  POP_PEAK_PROGRESS,
  POP_START_SCALE,
  BLUR_MAX_PX,
  BLUR_EASE_POWER,
  ANIMATION_OPACITY_RAMP_FRACTION,
  ANIMATION_SAMPLE_TOLERANCE,
  ANIMATION_DURATION_DEFAULT_SEC,
  type AnimationSpec,
} from '../../src/shared/cue-animation'
import { buildAnimationTags } from '../../src/shared/cue-animation-ass'

const BS = String.fromCharCode(92)

function spec(patch: Partial<AnimationSpec> = {}): AnimationSpec {
  return {
    type: 'fade', inEnabled: true, outEnabled: true,
    durationSec: 0.4, direction: 'down', distancePx: 50,
    // REQ-0331 §1-3 — the strength fields.  Defaults chosen to reproduce
    // the pre-REQ-0331 hardcoded constants, which is what lets the curve
    // assertions below stay written in terms of the exported constants.
    startScale: SCALE_START, blurMaxPx: BLUR_MAX_PX,
    ...patch,
  }
}

/** `pop` resolves to a start scale of 0, unlike `scale`'s 0.7. */
function popSpec(patch: Partial<AnimationSpec> = {}): AnimationSpec {
  return spec({ type: 'pop', startScale: POP_START_SCALE, ...patch })
}

/** The legacy fade ramp, transcribed from the pre-REQ-0323 helper. */
function legacyFadeOpacity(t: number, start: number, end: number, fadeSec: number): number {
  if (fadeSec <= 0) return 1
  if (t < start || t > end) return 0
  const c = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n)
  return Math.min(c((t - start) / fadeSec), c((end - t) / fadeSec))
}

describe('REQ-0323 §2-1 — the curves', () => {
  it('fade ramps 0→1 in, 1→0 out, linearly', () => {
    const s = spec({ type: 'fade', durationSec: 1 })
    const at = (t: number) => animationTransformAt(s, 0, 4, t).opacity
    expect(at(0)).toBeCloseTo(0, 6)
    expect(at(0.25)).toBeCloseTo(0.25, 6)
    expect(at(0.5)).toBeCloseTo(0.5, 6)
    expect(at(1)).toBeCloseTo(1, 6)
    expect(at(2)).toBeCloseTo(1, 6)   // plateau
    expect(at(3.5)).toBeCloseTo(0.5, 6)
    expect(at(4)).toBeCloseTo(0, 6)
  })

  it('scale goes startScale→1, decelerating (REQ-0331 §2-3)', () => {
    const s = spec({ type: 'scale', durationSec: 1 })
    const at = (t: number) => animationTransformAt(s, 0, 4, t).scale
    expect(at(0)).toBeCloseTo(SCALE_START, 6)
    expect(at(1)).toBeCloseTo(1, 6)
    // Ease-OUT on the way in: already past the halfway point of the
    // distance by the halfway point of the time.
    expect(at(0.5)).toBeGreaterThan((SCALE_START + 1) / 2)
    // Monotone, and by symmetry ease-IN on the way out.
    expect(at(0.25)).toBeLessThan(at(0.5))
    expect(at(3.5)).toBeGreaterThan(at(3.75))
  })

  it('pop overshoots past 1 and settles back — the two-segment shape', () => {
    const s = popSpec({ durationSec: 1 })
    const at = (t: number) => animationTransformAt(s, 0, 4, t).scale
    expect(at(0)).toBeCloseTo(0, 6)
    expect(at(POP_PEAK_PROGRESS)).toBeCloseTo(POP_OVERSHOOT, 6)
    expect(at(1)).toBeCloseTo(1, 6)
    // strictly overshoots somewhere in between (that IS the pop)
    expect(at(POP_PEAK_PROGRESS)).toBeGreaterThan(1)
    // monotone up to the peak, monotone down after it
    expect(at(0.3)).toBeGreaterThan(at(0.1))
    expect(at(0.8)).toBeLessThan(at(POP_PEAK_PROGRESS))
  })

  it('blur starts at its peak radius and sharpens to 0, front-loaded', () => {
    const s = spec({ type: 'blur', durationSec: 1 })
    const at = (t: number) => animationTransformAt(s, 0, 4, t).blurPx
    expect(at(0)).toBeCloseTo(BLUR_MAX_PX, 6)
    expect(at(1)).toBeCloseTo(0, 6)
    // REQ-0331 §2-3 — the whole point: at mid-ramp the radius must ALREADY
    // be far below half, or the cue is an unreadable smear for most of the
    // ramp and then snaps sharp (RES-0323 §7).
    expect(at(0.5)).toBeLessThan(BLUR_MAX_PX / 3)
    expect(at(0.5)).toBeCloseTo(BLUR_MAX_PX * Math.pow(0.5, BLUR_EASE_POWER), 6)
  })

  it('the per-cue strength fields drive the curves (REQ-0331 §1-3)', () => {
    const weak = spec({ type: 'scale', durationSec: 1, startScale: 0.95 })
    expect(animationTransformAt(weak, 0, 4, 0).scale).toBeCloseTo(0.95, 6)
    const heavy = spec({ type: 'blur', durationSec: 1, blurMaxPx: 20 })
    expect(animationTransformAt(heavy, 0, 4, 0).blurPx).toBeCloseTo(20, 6)
  })

  it('★ every non-fade type carries its own opacity ramp (REQ-0331 §2-3)', () => {
    for (const s of [
      spec({ type: 'scale', durationSec: 1 }),
      popSpec({ durationSec: 1 }),
      spec({ type: 'blur', durationSec: 1 }),
    ]) {
      const at = (t: number) => animationTransformAt(s, 0, 4, t).opacity
      expect(at(0)).toBeCloseTo(0, 6)
      // Reaches full opacity at `fraction` of the ramp, then holds.
      expect(at(ANIMATION_OPACITY_RAMP_FRACTION)).toBeCloseTo(1, 6)
      expect(at(ANIMATION_OPACITY_RAMP_FRACTION / 2)).toBeCloseTo(0.5, 6)
      expect(at(0.9)).toBeCloseTo(1, 6)
    }
  })

  it('a disabled end does not ramp there', () => {
    const s = spec({ type: 'fade', durationSec: 1, outEnabled: false })
    expect(animationTransformAt(s, 0, 4, 0.5).opacity).toBeCloseTo(0.5, 6)
    expect(animationTransformAt(s, 0, 4, 3.5).opacity).toBeCloseTo(1, 6) // no fade-out
  })

  it('★ REQ-0333 §4 — windows that would overlap are shrunk to fit the cue', () => {
    // 0.4 s cue, 1 s of ramp requested at EACH end.  Pre-REQ-0333 this
    // produced `min(pIn, pOut)`, a triangle peaking at 0.2 — a shape
    // libass's `\fade` does not draw when its control points cross.
    const s = spec({ type: 'fade', durationSec: 1 })
    const w = animationWindows(s, 0, 0.4)
    expect(w.inSec).toBeCloseTo(0.2, 9)
    expect(w.outSec).toBeCloseTo(0.2, 9)
    // The cue now settles exactly once, at the midpoint, and the ramps
    // are symmetric about it.
    expect(animationTransformAt(s, 0, 0.4, 0.2).opacity).toBeCloseTo(1, 6)
    expect(animationTransformAt(s, 0, 0.4, 0.1).opacity).toBeCloseTo(0.5, 6)
    expect(animationTransformAt(s, 0, 0.4, 0.3).opacity).toBeCloseTo(0.5, 6)
    // ...and the emitted `\fad` can no longer cross: in + out === the
    // cue length, so libass's t2 and t3 coincide instead of inverting.
    expect(buildAnimationTags(s, 0, 0.4)).toBe(BS + 'fad(200,200)')
  })

  it('★ REQ-0333 §4 — the shrink is proportional, so one enabled end keeps the whole cue', () => {
    const s = spec({ type: 'fade', durationSec: 1, outEnabled: false })
    const w = animationWindows(s, 0, 0.4)
    expect(w.inSec).toBeCloseTo(0.4, 9)
    expect(w.outSec).toBe(0)
    expect(animationTransformAt(s, 0, 0.4, 0.4).opacity).toBeCloseTo(1, 6)
  })

  it('★ REQ-0333 §4 — a cue whose windows FIT keeps the requested value untouched', () => {
    // Not "close to": the same number, so no ordinary cue can pick up a
    // floating-point difference and change an emitted byte.
    for (const [d, start, end] of [[0.4, 0, 4], [1, 0, 2], [0.3, 10, 11]]) {
      const s = spec({ type: 'fade', durationSec: d })
      expect(animationWindows(s, start, end)).toEqual({ inSec: d, outSec: d })
    }
  })

  it('an inert spec is exactly neutral', () => {
    for (const s of [spec({ type: 'none' }), spec({ durationSec: 0 }),
                     spec({ inEnabled: false, outEnabled: false })]) {
      expect(isAnimationInert(s)).toBe(true)
      expect(animationTransformAt(s, 0, 4, 2)).toEqual(NEUTRAL_TRANSFORM)
      expect(animationKeyframes(s, 0, 4)).toEqual([])
      expect(buildAnimationTags(s, 0, 4)).toBe('')
    }
  })
})

describe('REQ-0323 §1-1 — ★ the anti-drift guarantee', () => {
  // This is the property that structurally prevents the preview and the
  // burn-in from disagreeing: the keyframes the ASS writer transcribes
  // must be exactly what the preview would paint at those instants.
  const cases: AnimationSpec[] = [
    spec({ type: 'fade', durationSec: 0.4 }),
    spec({ type: 'scale', durationSec: 0.4 }),
    popSpec({ durationSec: 0.4 }),
    spec({ type: 'blur', durationSec: 0.4 }),
    popSpec({ durationSec: 1, inEnabled: false }),
    spec({ type: 'scale', durationSec: 1, outEnabled: false }),
    spec({ type: 'blur', durationSec: 1 }),   // ramps overlap on a 1.5s cue
  ]
  for (const s of cases) {
    it(`keyframes match the continuous curve — ${s.type} in=${s.inEnabled} out=${s.outEnabled} d=${s.durationSec}`, () => {
      for (const [start, end] of [[0, 4], [2, 3.5], [10, 11.5]]) {
        for (const k of animationKeyframes(s, start, end)) {
          expect(animationTransformAt(s, start, end, k.atSec)).toEqual(k.transform)
        }
      }
    })
  }

  it('keyframes are ordered, de-duplicated and inside the cue', () => {
    const keys = animationKeyframes(popSpec({ durationSec: 1 }), 0, 1.2)
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i].atSec).toBeGreaterThan(keys[i - 1].atSec)
    }
    expect(keys[0].atSec).toBeGreaterThanOrEqual(0)
    expect(keys[keys.length - 1].atSec).toBeLessThanOrEqual(1.2)
  })
})

describe('REQ-0323 §1-6 — ★ the fadeDurationSec migration', () => {
  it('a legacy cue with fadeDurationSec > 0 still fades, at the same length', () => {
    const legacy = { fadeDurationSec: 0.3 } // no animation* fields at all
    const s = resolveAnimation(legacy)
    expect(s.type).toBe('fade')
    expect(s.durationSec).toBeCloseTo(0.3, 6)
    expect(s.inEnabled).toBe(true)
    expect(s.outEnabled).toBe(true)
  })

  it('★ the migrated ramp is numerically identical to the pre-REQ-0323 helper', () => {
    // If this drifts, every existing project silently changes how it fades.
    //
    // REQ-0333 §4 narrowed this to cues whose two windows FIT
    // (`2 × fadeSec <= end - start`).  On a cue too short for both, the
    // legacy helper's `min()` triangle was never what libass drew — its
    // `\fade` control points crossed — so reproducing it was reproducing a
    // preview/burn mismatch.  The clamped behaviour is asserted separately
    // in the §4 tests above.
    for (const fadeSec of [0.1, 0.2, 0.3, 0.5]) {
      const s = resolveAnimation({ fadeDurationSec: fadeSec })
      for (const [start, end] of [[0, 4], [1.5, 2.6], [10, 11]]) {
        expect(2 * fadeSec).toBeLessThanOrEqual(end - start)
        for (let t = start; t <= end; t += (end - start) / 20) {
          expect(animationTransformAt(s, start, end, t).opacity)
            .toBeCloseTo(legacyFadeOpacity(t, start, end, fadeSec), 10)
        }
      }
    }
  })

  it('★ REQ-0333 §4 — a legacy fade on a SHORT cue emits a fitting \\fad', () => {
    // 0.3 s cue with a 0.4 s fade at each end: pre-REQ-0333 this emitted
    // `\fad(400,400)` on a 300 ms event, so libass's t2 (400) sat past its
    // t3 (-100) and the alpha jumped.  Both windows shrink by the same
    // factor, so the pair always sums to the cue length.
    const s = resolveAnimation({ fadeDurationSec: 0.4 })
    expect(animationFadeMs(s, 10, 10.3)).toEqual({ inMs: 150, outMs: 150 })
    expect(buildAnimationTags(s, 10, 10.3)).toBe(BS + 'fad(150,150)')
  })

  it('★ the migrated cue emits the SAME \\fad tag it emitted before', () => {
    // The byte-identity claim for pre-REQ-0323 projects, in one assertion.
    const s = resolveAnimation({ fadeDurationSec: 0.3 })
    expect(buildAnimationTags(s, 0, 4)).toBe(BS + 'fad(300,300)')
  })

  it('fadeDurationSec === 0 migrates to none, emitting nothing', () => {
    const s = resolveAnimation({ fadeDurationSec: 0 })
    expect(s.type).toBe('none')
    expect(buildAnimationTags(s, 0, 4)).toBe('')
  })

  it('once animationType is set it WINS — the legacy field stops being consulted', () => {
    const s = resolveAnimation({ fadeDurationSec: 0.5, animationType: 'pop', animationDurationSec: 0.2 })
    expect(s.type).toBe('pop')
    expect(s.durationSec).toBeCloseTo(0.2, 6)
  })

  it('an explicit none beats a non-zero legacy fade (user turned it off)', () => {
    // `undefined` means "never chosen"; `'none'` means "chosen: nothing".
    // Conflating the two would make it impossible to switch a fade off.
    expect(resolveAnimation({ fadeDurationSec: 0.5, animationType: 'none' }).type).toBe('none')
  })

  it('defaults fill in for a cue that chose a type but nothing else', () => {
    const s = resolveAnimation({ animationType: 'scale', fadeDurationSec: 0 })
    expect(s.durationSec).toBeCloseTo(ANIMATION_DURATION_DEFAULT_SEC, 6)
    expect(s.inEnabled).toBe(true)
    expect(s.outEnabled).toBe(true)
  })

  it('garbage values fall back instead of throwing', () => {
    const s = resolveAnimation({
      animationType: 'WOBBLE', animationDirection: 'sideways',
      animationDurationSec: 99, animationDistancePx: -5, fadeDurationSec: 0,
    })
    expect(s.type).toBe('none')
    expect(s.direction).toBe('down')
    expect(s.durationSec).toBe(1)      // clamped to max
    expect(s.distancePx).toBe(0)       // clamped to min
  })
})

describe('REQ-0323 §1 — ASS transcription', () => {
  it('scale emits an initial state plus \\t segments covering both ramps', () => {
    const tags = buildAnimationTags(spec({ type: 'scale', durationSec: 0.4 }), 0, 4)
    expect(tags).toContain(BS + 'fscx70')
    // The eased ramp is sampled, so the first segment starts at 0 and the
    // last one lands on the cue's end; the intermediate boundaries are
    // wherever the sampler decided (REQ-0331 §2-2).
    expect(tags).toContain(BS + 't(0,')
    expect(tags).toContain(',4000,')
    expect(tags).toContain('fscx100')
  })

  it('★ every non-fade type also emits the opacity ramp as \\fad', () => {
    for (const s of [
      spec({ type: 'scale', durationSec: 0.4 }),
      popSpec({ durationSec: 0.4 }),
      spec({ type: 'blur', durationSec: 0.4 }),
    ]) {
      const ms = Math.round(0.4 * ANIMATION_OPACITY_RAMP_FRACTION * 1000)
      expect(buildAnimationTags(s, 0, 4)).toContain(`${BS}fad(${ms},${ms})`)
    }
  })

  it('★ the sampled keyframes stay within tolerance of the real curve', () => {
    // The piecewise-linear approximation is only honest if the chords are
    // actually close to the curve BETWEEN the control points — the
    // anti-drift test only pins the control points themselves.
    for (const s of [
      spec({ type: 'scale', durationSec: 1 }),
      popSpec({ durationSec: 1 }),
      spec({ type: 'blur', durationSec: 1 }),
    ]) {
      const keys = animationKeyframes(s, 0, 4)
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1]
        const b = keys[i]
        if (b.atSec - a.atSec < 1e-9) continue
        for (let f = 0.1; f < 1; f += 0.1) {
          const t = a.atSec + (b.atSec - a.atSec) * f
          const real = animationTransformAt(s, 0, 4, t)
          const chord = {
            scale: a.transform.scale + (b.transform.scale - a.transform.scale) * f,
            blurPx: a.transform.blurPx + (b.transform.blurPx - a.transform.blurPx) * f,
          }
          expect(Math.abs(chord.scale - real.scale)).toBeLessThan(ANIMATION_SAMPLE_TOLERANCE * 2)
          expect(Math.abs(chord.blurPx - real.blurPx))
            .toBeLessThan(ANIMATION_SAMPLE_TOLERANCE * 2 * Math.max(1, s.blurMaxPx))
        }
      }
    }
  })

  it('pop emits the overshoot as its own \\t segment', () => {
    const tags = buildAnimationTags(popSpec({ durationSec: 0.5 }), 0, 4)
    // the overshoot, rounded the way `scalePercent` rounds it
    expect(tags).toContain(`fscx${Math.round(POP_OVERSHOOT * 1000) / 10}`)
    // in-ramp: 0 → peak → settle = two segments
    expect((tags.match(/\\t\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('blur emits \\blur and sharpens to 0', () => {
    const tags = buildAnimationTags(spec({ type: 'blur', durationSec: 0.4 }), 0, 4)
    expect(tags).toContain(BS + 'blur' + BS.slice(0, 0) + BLUR_MAX_PX)
    expect(tags).toContain(BS + 'blur0')
  })

  it('a one-ended fade writes 0 for the other end', () => {
    expect(buildAnimationTags(spec({ type: 'fade', durationSec: 0.4, outEnabled: false }), 0, 4))
      .toBe(BS + 'fad(400,0)')
    expect(buildAnimationTags(spec({ type: 'fade', durationSec: 0.4, inEnabled: false }), 0, 4))
      .toBe(BS + 'fad(0,400)')
  })

  it('slide emits NOTHING until §3 — a half-implemented \\move would never leave', () => {
    expect(buildAnimationTags(spec({ type: 'slide', durationSec: 0.4 }), 0, 4)).toBe('')
  })
})
