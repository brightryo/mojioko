import { ASS_BLUR_TO_CSS_SIGMA } from '../../shared/constants'
import type { AnimationTransform } from '../../shared/cue-animation'
import { applyCueBlurToLayer } from './cue-blur-layer'

/**
 * REQ-0339 §2 — the ONE place a cue's animation state is written to the DOM.
 *
 * Two writers used to exist in `video-preview-panel`: the rAF loop (opacity +
 * transform + blur) and the mount-time callback ref (opacity ONLY).  The
 * callback ref fires during the commit phase, so it is what the browser paints
 * on a cue's FIRST frame — and because it wrote only opacity, every cue's first
 * frame appeared with no blur and no scale, then snapped to the animated state
 * one frame later.  Measured against the real component in a real Electron
 * window: 1.36× the intended width for `pop`, 1.25× for `scale`, and fully
 * sharp for `blur`.
 *
 * Collapsing both writers onto this function is the fix.  A second writer that
 * covers a subset of the channels is not a smaller version of the first — it is
 * a guaranteed one-frame disagreement.
 *
 * Every CSSOM write is guarded by a read so a steady-state caption (mid-plateau,
 * opacity "1") does not invalidate style on every one of 60 frames per second.
 */
export function applyCueAnimationPaint(
  outer: HTMLElement,
  anim: AnimationTransform,
  inRange: boolean,
  scalePx: number,
): void {
  const opacity = String(inRange ? anim.opacity : 0)
  if (outer.style.opacity !== opacity) outer.style.opacity = opacity

  // `offset*Px` is in ASS px; multiply into preview px like every other
  // ASS-space quantity.  React owns the BASE transform (pinned-anchor offset,
  // rotation) and composes it with this custom property through `var()`, so
  // the two writers stay off each other's toes.
  const transform =
    `translate(${anim.offsetXPx * scalePx}px, ${anim.offsetYPx * scalePx}px) scale(${anim.scale})`
  if (outer.style.getPropertyValue('--cue-anim-transform') !== transform) {
    outer.style.setProperty('--cue-anim-transform', transform)
  }

  // REQ-0324 §2 — `scalePx` because ASS blur is in VIDEO pixels and the
  // preview is smaller; `ASS_BLUR_TO_CSS_SIGMA` because libass and Chromium
  // disagree on what a blur radius means (σ = 0.834·N vs ≈0.956·N).
  // REQ-0339 §1 — the LAYER choice lives in `applyCueBlurToLayer`.
  applyCueBlurToLayer(outer, anim.blurPx * scalePx * ASS_BLUR_TO_CSS_SIGMA)
}
