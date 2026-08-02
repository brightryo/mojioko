import { describe, it, expect } from 'vitest'
import { resolveCueAnimState } from '../../src/shared/cue-animation'
import { cueAnimOpacityCss, cueAnimTransformCss } from '../../src/renderer/lib/cue-anim-paint'

/**
 * REQ-0378 §C — a cue with an entrance animation must NOT flash its settled
 * state (opacity 1 / scale 1) on the first painted frame of a playback
 * activation.  The preview seeds the overlay's `--cue-anim-opacity` /
 * `--cue-anim-transform` custom properties from `resolveCueAnimState` at render
 * time, so even the pre-first-imperative-write paint shows the animation's
 * CURRENT state.  The mount ref and the rAF loop use the SAME function, so the
 * seed and the imperative writes cannot disagree.
 *
 * The owner's repro: blur (and any entrance) animation, played through the
 * clip start, showed frame 1 = settled (opacity 1, sharp) then frame 2 = the
 * animation initial (opacity 0).  These pins assert the render seed is the
 * animation initial (opacity 0), not settled, at the activation instant.
 */
const fadeInCue = (over: Record<string, unknown> = {}) => ({
  startSec: 5,
  endSec: 8,
  animationType: 'fade',
  animationInEnabled: true,
  animationOutEnabled: true,
  animationDurationSec: 0.8,
  fadeDurationSec: 0,
  ...over,
})

const seedOpacity = (cue: ReturnType<typeof fadeInCue>, t: number, paused: boolean) => {
  const { anim, inRange } = resolveCueAnimState(cue, t, paused)
  return Number(cueAnimOpacityCss(anim, inRange))
}

describe('REQ-0378 §C — no settled flash on entrance-animation activation', () => {
  it('during playback, the render seed at the cue start is the animation INITIAL (opacity 0), not settled', () => {
    // This is the fix: before it, the first frame defaulted to opacity 1.
    expect(seedOpacity(fadeInCue(), 5, false)).toBe(0)
  })

  it('holds for any entrance animation type (owner: "他のアニメでも出る")', () => {
    for (const animationType of ['fade', 'blur', 'scale', 'pop']) {
      expect(seedOpacity(fadeInCue({ animationType }), 5, false)).toBe(0)
    }
  })

  it('mid-window (plateau) still seeds fully visible', () => {
    // t well past the in-ramp and before the out-ramp → settled opacity 1.
    expect(seedOpacity(fadeInCue(), 6.5, false)).toBe(1)
  })

  it('paused AT the start of an ANIMATED cue shows the entrance initial (REQ-0379 decision B)', () => {
    // Real-pixel finding (RES-0379): the settled "flash" was the paused-at-start
    // editing view.  For a cue WITH an entrance animation the paused view is now
    // the entrance initial (opacity 0), so playing from there starts cleanly.
    expect(seedOpacity(fadeInCue(), 5, true)).toBe(0)
    // Scrubbed one second in while paused still shows the real 1s animation state.
    expect(seedOpacity(fadeInCue(), 6.5, true)).toBe(1) // plateau
  })

  it('paused AT the start of a NON-animated cue stays settled+visible (REQ-0195/0323 preserved)', () => {
    // The snap still applies where there is no entrance to play — the 0-second
    // caption stays visible/editable.
    expect(seedOpacity(fadeInCue({ animationType: 'none' }), 5, true)).toBe(1)
    // and a cue with only an EXIT animation (no entrance) also keeps the snap.
    expect(seedOpacity(fadeInCue({ animationInEnabled: false }), 5, true)).toBe(1)
  })

  it('out of range seeds hidden (opacity 0)', () => {
    expect(seedOpacity(fadeInCue(), 8.5, false)).toBe(0) // after end
  })

  it('a non-animated cue seeds fully visible (no regression)', () => {
    expect(seedOpacity(fadeInCue({ animationType: 'none' }), 5, false)).toBe(1)
  })

  it('the transform seed is a real CSS transform (scale from the animation state)', () => {
    const { anim } = resolveCueAnimState(fadeInCue({ animationType: 'scale' }), 5, false)
    const css = cueAnimTransformCss(anim, 1)
    expect(css).toMatch(/^translate\([^)]*\) scale\([\d.]+\)$/)
    // scale animation starts away from 1.0, so the seeded transform is NOT settled.
    expect(css).not.toBe('translate(0px, 0px) scale(1)')
  })
})
