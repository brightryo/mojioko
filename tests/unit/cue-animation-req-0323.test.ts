import { describe, it, expect } from 'vitest'
import {
  resolveAnimation,
  animationTransformAt,
  animationKeyframes,
  isAnimationInert,
  NEUTRAL_TRANSFORM,
  SCALE_START,
  POP_OVERSHOOT,
  POP_PEAK_PROGRESS,
  BLUR_MAX_PX,
  ANIMATION_DURATION_DEFAULT_SEC,
  type AnimationSpec,
} from '../../src/shared/cue-animation'
import { buildAnimationTags } from '../../src/shared/cue-animation-ass'

const BS = String.fromCharCode(92)

function spec(patch: Partial<AnimationSpec> = {}): AnimationSpec {
  return {
    type: 'fade', inEnabled: true, outEnabled: true,
    durationSec: 0.4, direction: 'down', distancePx: 50,
    ...patch,
  }
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

  it('scale goes SCALE_START→1 and never touches opacity', () => {
    const s = spec({ type: 'scale', durationSec: 1 })
    expect(animationTransformAt(s, 0, 4, 0).scale).toBeCloseTo(SCALE_START, 6)
    expect(animationTransformAt(s, 0, 4, 0.5).scale).toBeCloseTo((SCALE_START + 1) / 2, 6)
    expect(animationTransformAt(s, 0, 4, 1).scale).toBeCloseTo(1, 6)
    expect(animationTransformAt(s, 0, 4, 0.5).opacity).toBe(1)
  })

  it('pop overshoots past 1 and settles back — the two-segment shape', () => {
    const s = spec({ type: 'pop', durationSec: 1 })
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

  it('blur starts at BLUR_MAX_PX and sharpens to 0', () => {
    const s = spec({ type: 'blur', durationSec: 1 })
    expect(animationTransformAt(s, 0, 4, 0).blurPx).toBeCloseTo(BLUR_MAX_PX, 6)
    expect(animationTransformAt(s, 0, 4, 0.5).blurPx).toBeCloseTo(BLUR_MAX_PX / 2, 6)
    expect(animationTransformAt(s, 0, 4, 1).blurPx).toBeCloseTo(0, 6)
  })

  it('a disabled end does not ramp there', () => {
    const s = spec({ type: 'fade', durationSec: 1, outEnabled: false })
    expect(animationTransformAt(s, 0, 4, 0.5).opacity).toBeCloseTo(0.5, 6)
    expect(animationTransformAt(s, 0, 4, 3.5).opacity).toBeCloseTo(1, 6) // no fade-out
  })

  it('overlapping ramps on a short cue meet in the middle and never settle', () => {
    // duration 0.4, ramps 1s each → the two ramps overlap.
    const s = spec({ type: 'fade', durationSec: 1 })
    const peak = animationTransformAt(s, 0, 0.4, 0.2).opacity
    expect(peak).toBeLessThan(1)
    expect(peak).toBeCloseTo(0.2, 6)
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
    spec({ type: 'pop', durationSec: 0.4 }),
    spec({ type: 'blur', durationSec: 0.4 }),
    spec({ type: 'pop', durationSec: 1, inEnabled: false }),
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
    const keys = animationKeyframes(spec({ type: 'pop', durationSec: 1 }), 0, 1.2)
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
    for (const fadeSec of [0.1, 0.2, 0.3, 0.5]) {
      const s = resolveAnimation({ fadeDurationSec: fadeSec })
      for (const [start, end] of [[0, 4], [1.5, 2.0], [10, 10.3]]) {
        for (let t = start; t <= end; t += (end - start) / 20) {
          expect(animationTransformAt(s, start, end, t).opacity)
            .toBeCloseTo(legacyFadeOpacity(t, start, end, fadeSec), 10)
        }
      }
    }
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
  it('scale emits an initial state plus one \\t per ramp', () => {
    const tags = buildAnimationTags(spec({ type: 'scale', durationSec: 0.4 }), 0, 4)
    expect(tags).toContain(BS + 'fscx70')
    expect(tags).toContain(BS + 't(0,400,')
    expect(tags).toContain(BS + 't(3600,4000,')
  })

  it('pop emits the overshoot as its own \\t segment', () => {
    const tags = buildAnimationTags(spec({ type: 'pop', durationSec: 0.5 }), 0, 4)
    expect(tags).toContain("fscx115")  // the overshoot, rounded by scalePercent
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
