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
  animationKeyframes,
  isAnimationInert,
  type AnimationSpec,
  type AnimationTransform,
} from './cue-animation'

/** ASS percentage for a scale factor: 1 → 100. */
function scalePercent(scale: number): number {
  return Math.round(scale * 1000) / 10
}

function relMs(atSec: number, startSec: number): number {
  return Math.round((atSec - startSec) * 1000)
}

/**
 * The tags describing `transform` as a *state* (used both for the initial
 * state and as the target of a `\t`).  Returns '' when the state is the
 * natural one for that channel.
 */
function stateTags(spec: AnimationSpec, t: AnimationTransform): string {
  switch (spec.type) {
    case 'scale':
    case 'pop': {
      const p = scalePercent(t.scale)
      return `\\fscx${p}\\fscy${p}`
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
): string {
  if (isAnimationInert(spec)) return ''

  if (spec.type === 'fade') {
    // Keep the historical `\fad` form exactly.  Durations are per-end, so
    // a one-ended fade writes 0 for the other end.
    const ms = Math.round(spec.durationSec * 1000)
    if (ms <= 0) return ''
    const inMs = spec.inEnabled ? ms : 0
    const outMs = spec.outEnabled ? ms : 0
    return `\\fad(${inMs},${outMs})`
  }

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
  if (keys.length < 2) return ''

  // Initial state = the first keyframe, written as plain tags so the cue
  // is already in its start state on its very first frame.
  let out = stateTags(spec, keys[0].transform)

  // One `\t` per segment.  A segment whose endpoints are identical (the
  // plateau between the in-ramp and the out-ramp) contributes nothing.
  for (let i = 1; i < keys.length; i++) {
    const from = keys[i - 1]
    const to = keys[i]
    const target = stateTags(spec, to.transform)
    if (!target) continue
    if (stateTags(spec, from.transform) === target) continue
    out += `\\t(${relMs(from.atSec, startSec)},${relMs(to.atSec, startSec)},${target})`
  }
  return out
}
