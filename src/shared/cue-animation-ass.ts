/**
 * REQ-0323 §1 — transcribe `cue-animation.ts` keyframes into ASS override
 * tags.
 *
 * This module deliberately contains **no curve maths**.  Every value it
 * writes comes from `animationKeyframes()` / `animationTransformAt()`, so
 * the burn-in and the preview are driven by one implementation.  If you
 * find yourself computing a ramp here, that is the REQ-0320 §1 bug class
 * reappearing — put it in `cue-animation.ts` instead.
 *
 * ## Why `\fad` for fade but `\t` for the rest
 *
 * `\fad(in,out)` is libass's built-in alpha ramp and is what MOJIOKO has
 * always emitted for fades.  Keeping it (rather than expressing fade as
 * `\t(...\alpha...)`) is what makes pre-REQ-0323 projects burn
 * byte-identically after the migration — the emitted string is character
 * for character what it was.  The other three types have no built-in, so
 * they use `\t`, whose default acceleration is linear and therefore
 * matches the piecewise-linear curves the shared module defines.
 *
 * ## `\t` time base
 *
 * `\t(t1,t2,tags)` times are milliseconds **relative to the event's own
 * Start**, not absolute video time.  Keyframes arrive as absolute seconds,
 * so everything is rebased against `startSec` here.  (Verified for
 * `\move` in REQ-0323 §3-1; `\t` follows the same rule.)
 */

import {
  animationFadeMs,
  animationKeyframes,
  isAnimationInert,
  type AnimationSpec,
  type AnimationTransform,
} from './cue-animation'

/**
 * REQ-0325 §1 — the cue's non-glyph geometry, needed because libass does
 * NOT scale these with `\fscx`/`\fscy` while CSS `transform: scale()`
 * unavoidably does (it scales already-rasterised pixels).  Measured at
 * S=70/100/115: libass outline thickness stayed at its nominal value in
 * every case, ratio exactly 1.000.
 *
 * The preview is the reference (owner decision, REQ-0325 §1), so the ASS
 * writer drives these explicitly alongside the scale.
 */
export interface AnimationGeometry {
  /**
   * The cue's `\bord`.  Under BorderStyle=1 this is the outline width;
   * under BorderStyle=3 it is the opaque box's padding.  Scaling it is
   * right in BOTH cases: the CSS preview draws the box with a `padding`
   * in px, which `transform: scale()` scales too.
   */
  outlinePx: number
  /**
   * The cue's effective `\shad`.  Pass 0 when no shadow is emitted —
   * including for a background-box row, where the writer deliberately
   * emits `\shad0` to stop shadow bleed.  Emitting a scaled `\shad` there
   * would resurrect the very shadow that `\shad0` suppresses.
   */
  shadowPx: number
}

/** ASS percentage for a scale factor: 1 → 100. */
function scalePercent(scale: number): number {
  return Math.round(scale * 1000) / 10
}

/** One decimal is libass's own precision for these tags. */
function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function relMs(atSec: number, startSec: number): number {
  return Math.round((atSec - startSec) * 1000)
}

/**
 * The tags describing `transform` as a *state* (used both for the initial
 * state and as the target of a `\t`).  Returns '' when the state is the
 * natural one for that channel.
 */
function stateTags(
  spec: AnimationSpec,
  t: AnimationTransform,
  geom: AnimationGeometry,
): string {
  switch (spec.type) {
    case 'scale':
    case 'pop': {
      const p = scalePercent(t.scale)
      let out = `\\fscx${p}\\fscy${p}`
      // REQ-0325 §1 — carry the outline and shadow with the glyph.  Without
      // this, a `pop` starting at `\fscx0` collapses the glyph to nothing
      // while leaving a full-width border ring behind: the burn shows a
      // blob where the preview shows nothing at all.
      if (geom.outlinePx > 0) out += `\\bord${round1(geom.outlinePx * t.scale)}`
      if (geom.shadowPx > 0) out += `\\shad${round1(geom.shadowPx * t.scale)}`
      return out
    }
    case 'blur':
      // `\blur` takes script pixels; 0 is a sharp edge.
      return `\\blur${Math.round(t.blurPx * 10) / 10}`
    default:
      return ''
  }
}

/**
 * Build the animation override tags for one cue.
 *
 * Returns `''` for an inert spec so a cue that never touched the feature
 * contributes nothing to the emitted line.
 */
export function buildAnimationTags(
  spec: AnimationSpec,
  startSec: number,
  endSec: number,
  geom: AnimationGeometry = { outlinePx: 0, shadowPx: 0 },
): string {
  if (isAnimationInert(spec)) return ''

  // REQ-0331 §2-3 — the opacity component of EVERY type, as `\fad`.
  //
  // For `fade` this is the whole animation and the emitted string is
  // character-for-character what it has always been (the window is the
  // full duration), which is what keeps pre-REQ-0323 projects byte-
  // identical.  For `scale` / `pop` / `blur` it is the mixed-in fade the
  // owner asked for, over a shorter window — the durations come from
  // `animationFadeMs`, not from arithmetic here, so there is still exactly
  // one definition of the ramp.
  // REQ-0333 §4 — the cue bounds are passed so the shared clamp can shrink
  // both windows on a cue shorter than in + out.  The clamp lives in
  // `cue-animation.ts`; recomputing it here is the two-implementations bug
  // this module's header exists to forbid.
  const { inMs, outMs } = animationFadeMs(spec, startSec, endSec)
  const fadeTag = inMs > 0 || outMs > 0 ? `\\fad(${inMs},${outMs})` : ''

  if (spec.type === 'fade') return fadeTag

  if (spec.type === 'slide') {
    // REQ-0323 §3.  `\move` is one-per-event (proved empirically in
    // §3-1: first tag wins, later ones are discarded outright), so slide
    // cannot be expressed as an override on a single event — it needs the
    // cue split into abutting events.  That splitting is out of scope for
    // §1, and emitting a partial `\move` here would render a cue that
    // slides in and then never leaves.  Emitting nothing is the honest
    // behaviour until §3 lands.
    return ''
  }

  const keys = animationKeyframes(spec, startSec, endSec)
  if (keys.length < 2) return fadeTag

  // Initial state = the first keyframe, written as plain tags so the cue
  // is already in its start state on its very first frame.
  let out = fadeTag + stateTags(spec, keys[0].transform, geom)

  // One `\t` per segment.  A segment whose endpoints are identical (the
  // plateau between the in-ramp and the out-ramp) contributes nothing.
  for (let i = 1; i < keys.length; i++) {
    const from = keys[i - 1]
    const to = keys[i]
    const target = stateTags(spec, to.transform, geom)
    if (!target) continue
    if (stateTags(spec, from.transform, geom) === target) continue
    out += `\\t(${relMs(from.atSec, startSec)},${relMs(to.atSec, startSec)},${target})`
  }
  return out
}
