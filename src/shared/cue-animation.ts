/**
 * REQ-0323 §1-1 — the single source of truth for cue entrance / exit
 * animation.
 *
 * ## Why this module exists at all
 *
 * The predecessor, `renderer/lib/fade-opacity.ts`, was a pure helper that
 * the preview rAF loop called — and its JSDoc said it "mirrors the libass
 * `\fad(t,t)` semantics used by `ass-generator.ts`".  *Mirrors*.  The ASS
 * writer re-derived the same ramp from `fadeDurationSec` on its own, in
 * main, with no shared code and nothing forcing the two to agree.  They
 * happened to agree because `\fad` is trivial.  Nothing structural made
 * that true, and REQ-0320 §1 is the record of what happens when a render
 * value has two independent sources: the preview looked right for a whole
 * release while the MP4 was wrong.
 *
 * So this module lives in `shared/` and **both** consumers import it:
 *
 *   - `renderer/.../video-preview-panel.tsx` (rAF loop) calls
 *     `animationTransformAt()` every frame and writes the result to CSS.
 *   - `main/services/ass-generator.ts` calls `animationKeyframes()` and
 *     emits `\fad` / `\t(...)` from the returned control points.
 *
 * The two entry points are different shapes because the two targets are:
 * CSS wants "the value at time t", ASS wants "the control points to
 * interpolate between".  They are kept honest by a property the unit
 * tests pin directly:
 *
 *   **for every keyframe k returned by animationKeyframes(),
 *     animationTransformAt(k.atSec) deep-equals k.transform.**
 *
 * That is the anti-drift guarantee.  Adding a curve without satisfying it
 * fails the test, so the two paths cannot silently diverge again.
 *
 * ## Coordinate / unit conventions
 *
 * - `opacity` — 0..1, unitless.  CSS `opacity`, ASS alpha via `\fad`.
 * - `scale`   — 1 = natural size.  CSS `transform: scale()`, ASS
 *               `\fscx`/`\fscy` (which are percentages, so ×100).
 * - `blurPx`  — ASS script pixels (= output video pixels).  ASS `\blur`
 *               takes script pixels directly; the preview must multiply
 *               by the preview scale before writing `filter: blur()`.
 * - `offsetXPx` / `offsetYPx` — ASS script pixels, positive = right/down.
 *               Reserved for slide (REQ-0323 §3); always 0 for the four
 *               types implemented here.
 */

export type AnimationType = 'none' | 'fade' | 'slide' | 'pop' | 'scale' | 'blur'
export type AnimationDirection = 'down' | 'up' | 'left' | 'right'

export const ANIMATION_TYPES: readonly AnimationType[] = [
  'none', 'fade', 'slide', 'pop', 'scale', 'blur',
] as const
export const ANIMATION_DIRECTIONS: readonly AnimationDirection[] = [
  'down', 'up', 'left', 'right',
] as const

/** Slider bounds for the duration control (seconds). */
export const ANIMATION_DURATION_MIN_SEC = 0
export const ANIMATION_DURATION_MAX_SEC = 1
export const ANIMATION_DURATION_DEFAULT_SEC = 0.4
export const ANIMATION_DURATION_STEP_SEC = 0.1

/**
 * The types the UI offers.  REQ-0324 §1 keeps `slide` OUT of the list
 * until REQ-0323 §3 implements it — `buildAnimationTags` returns '' for
 * slide, so offering it would be a control that silently does nothing.
 * It stays in `AnimationType` so stored values and the ASS writer's
 * exhaustive switch already accommodate it.
 */
/**
 * REQ-0324 §2 — whether `blur` is offered in the UI.  A single flag so
 * the decision has one home; the curve, the ASS emitter and the preview
 * all keep working regardless, so flipping this does not strand data.
 */
export const ANIMATION_BLUR_ENABLED = true

export const SELECTABLE_ANIMATION_TYPES: readonly AnimationType[] = [
  'none', 'fade', 'pop', 'scale', 'blur',
] as const

/** Narrow an unknown UI value to a type.  Unknown → `none`. */
export function coerceAnimationType(v: unknown): AnimationType {
  return (ANIMATION_TYPES as readonly unknown[]).includes(v) ? (v as AnimationType) : 'none'
}

/** Slide distance bounds (ASS px).  REQ-0323 §3-4. */
export const ANIMATION_DISTANCE_MIN_PX = 0
export const ANIMATION_DISTANCE_MAX_PX = 200
export const ANIMATION_DISTANCE_DEFAULT_PX = 50

/**
 * Curve constants.  Deliberately module-level named constants rather than
 * inline literals — CLAUDE.md §3 forbids magic numbers, and these are the
 * knobs an owner is most likely to want retuned after seeing it on real
 * footage.
 */
/** `scale` starts here and grows to 1.  0.7 = noticeable but not a zoom. */
export const SCALE_START = 0.7
/** `pop` overshoots to this before settling at 1. */
export const POP_OVERSHOOT = 1.15
/** Fraction of the ramp spent going 0 → overshoot (rest settles to 1). */
export const POP_PEAK_PROGRESS = 0.6
/** `blur` starts this blurred (ASS px) and sharpens to 0. */
export const BLUR_MAX_PX = 8

/** The resolved, defaults-applied animation settings for one cue. */
export interface AnimationSpec {
  type: AnimationType
  inEnabled: boolean
  outEnabled: boolean
  durationSec: number
  direction: AnimationDirection
  distancePx: number
}

/** The visual state of a cue at one instant. */
export interface AnimationTransform {
  opacity: number
  scale: number
  blurPx: number
  offsetXPx: number
  offsetYPx: number
}

/** A control point the ASS writer interpolates between. */
export interface AnimationKeyframe {
  /** Absolute seconds on the same axis as the cue's start/end. */
  atSec: number
  transform: AnimationTransform
}

/** The state a cue rests at when nothing is animating. */
export const NEUTRAL_TRANSFORM: AnimationTransform = {
  opacity: 1, scale: 1, blurPx: 0, offsetXPx: 0, offsetYPx: 0,
}

export function isNeutral(t: AnimationTransform): boolean {
  return t.opacity === 1 && t.scale === 1 && t.blurPx === 0
    && t.offsetXPx === 0 && t.offsetYPx === 0
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function coerceType(v: unknown): AnimationType {
  return (ANIMATION_TYPES as readonly unknown[]).includes(v) ? (v as AnimationType) : 'none'
}

function coerceDirection(v: unknown): AnimationDirection {
  return (ANIMATION_DIRECTIONS as readonly unknown[]).includes(v)
    ? (v as AnimationDirection)
    : 'down'
}

/**
 * Read a cue's animation settings, applying defaults for absent fields.
 *
 * ## REQ-0323 §1-6 — the `fadeDurationSec` migration lives HERE
 *
 * `fadeDurationSec` is a **required** per-entry field that every existing
 * `.mojioko` project file carries a value for.  Rather than rewriting
 * saved files (the owner's standing preference — see the default-colour
 * and karaoke-style precedents), the legacy value is translated on every
 * read:
 *
 *   - a cue that has never seen the animation UI has `animationType`
 *     absent → if its `fadeDurationSec > 0` it is reported as a `fade`
 *     of that duration with both ends enabled, which is exactly what it
 *     rendered as before this REQ.
 *   - `fadeDurationSec === 0` → `none`, also exactly as before.
 *
 * Once the user touches the animation UI, `animationType` is written and
 * takes over permanently; `fadeDurationSec` is then no longer consulted.
 * That is what "廃止して統合" means in practice — the field stays in the
 * type as the legacy input to this function, and stops being an
 * independent control surface.
 *
 * Dropping this translation would silently delete the fade from every
 * existing project, which is the failure REQ-0323 §1-6 calls out.
 */
export function resolveAnimation(entry: {
  animationType?: unknown
  animationInEnabled?: unknown
  animationOutEnabled?: unknown
  animationDurationSec?: unknown
  animationDirection?: unknown
  animationDistancePx?: unknown
  fadeDurationSec?: unknown
}): AnimationSpec {
  const rawType = entry.animationType
  const legacyFade = typeof entry.fadeDurationSec === 'number' ? entry.fadeDurationSec : 0

  // Migration branch: no per-cue animation choice recorded yet.
  if (rawType === undefined || rawType === null) {
    if (legacyFade > 0) {
      return {
        type: 'fade',
        inEnabled: true,
        outEnabled: true,
        durationSec: legacyFade,
        direction: 'down',
        distancePx: ANIMATION_DISTANCE_DEFAULT_PX,
      }
    }
    return {
      type: 'none',
      inEnabled: true,
      outEnabled: true,
      durationSec: ANIMATION_DURATION_DEFAULT_SEC,
      direction: 'down',
      distancePx: ANIMATION_DISTANCE_DEFAULT_PX,
    }
  }

  const durationRaw = typeof entry.animationDurationSec === 'number'
    ? entry.animationDurationSec
    : ANIMATION_DURATION_DEFAULT_SEC
  const distanceRaw = typeof entry.animationDistancePx === 'number'
    ? entry.animationDistancePx
    : ANIMATION_DISTANCE_DEFAULT_PX

  return {
    type: coerceType(rawType),
    // Absent means enabled — a cue that picked a type but never touched
    // the two switches should animate at both ends, which is what the UI
    // shows by default.
    inEnabled: entry.animationInEnabled !== false,
    outEnabled: entry.animationOutEnabled !== false,
    durationSec: Math.min(
      ANIMATION_DURATION_MAX_SEC,
      Math.max(ANIMATION_DURATION_MIN_SEC, durationRaw),
    ),
    direction: coerceDirection(entry.animationDirection),
    distancePx: Math.min(
      ANIMATION_DISTANCE_MAX_PX,
      Math.max(ANIMATION_DISTANCE_MIN_PX, distanceRaw),
    ),
  }
}

/** True when the spec produces no visual change at any time. */
export function isAnimationInert(spec: AnimationSpec): boolean {
  return spec.type === 'none'
    || spec.durationSec <= 0
    || (!spec.inEnabled && !spec.outEnabled)
}

/**
 * Ramp progress at time `t`: 0 = fully un-entered, 1 = fully settled.
 *
 * Taking the MINIMUM of the entrance and exit ramps generalises exactly
 * what `computeFadeOpacity` did for `\fad`: on a cue shorter than twice
 * the duration the two ramps overlap and meet in the middle, so the cue
 * never fully settles.  Reproducing that rule here (rather than inventing
 * a new one) is what lets `fade` remain bit-for-bit the behaviour users
 * already have — see the equivalence test.
 */
function rampProgress(spec: AnimationSpec, startSec: number, endSec: number, tSec: number): number {
  const d = spec.durationSec
  if (d <= 0) return 1
  const pIn = spec.inEnabled ? clamp01((tSec - startSec) / d) : 1
  const pOut = spec.outEnabled ? clamp01((endSec - tSec) / d) : 1
  return Math.min(pIn, pOut)
}

/** Map ramp progress to the visual state, per animation type. */
function curve(spec: AnimationSpec, p: number): AnimationTransform {
  switch (spec.type) {
    case 'fade':
      return { ...NEUTRAL_TRANSFORM, opacity: p }
    case 'blur':
      return { ...NEUTRAL_TRANSFORM, blurPx: BLUR_MAX_PX * (1 - p) }
    case 'scale':
      return { ...NEUTRAL_TRANSFORM, scale: SCALE_START + (1 - SCALE_START) * p }
    case 'pop': {
      // Two linear segments: 0 → overshoot → 1.  Two segments is also
      // exactly what `\t` needs, so the ASS side is a direct transcription
      // rather than a re-derivation.
      const peak = POP_PEAK_PROGRESS
      const scale = p <= peak
        ? (POP_OVERSHOOT * p) / peak
        : POP_OVERSHOOT + (1 - POP_OVERSHOOT) * ((p - peak) / (1 - peak))
      return { ...NEUTRAL_TRANSFORM, scale }
    }
    case 'slide':
      // REQ-0323 §3.  Declared here so the type is exhaustive and the
      // preview/ASS split is already in place, but the geometry is not
      // implemented in this REQ — it returns neutral, i.e. no movement.
      return { ...NEUTRAL_TRANSFORM }
    case 'none':
    default:
      return { ...NEUTRAL_TRANSFORM }
  }
}

/**
 * The visual state of a cue at absolute time `tSec`.  Called every frame
 * by the preview rAF loop.
 *
 * Outside `[startSec, endSec]` this returns the neutral transform rather
 * than a hidden one: the caller only mounts an overlay while the playhead
 * is inside the cue, and returning "hidden" here caused a real bug once
 * (REQ-0195 §2 — a cue sitting exactly on `currentTime = 0`).  Visibility
 * is the caller's business; this function only describes the animation.
 */
export function animationTransformAt(
  spec: AnimationSpec,
  startSec: number,
  endSec: number,
  tSec: number,
): AnimationTransform {
  if (isAnimationInert(spec)) return { ...NEUTRAL_TRANSFORM }
  return curve(spec, rampProgress(spec, startSec, endSec, tSec))
}

/**
 * The control points the ASS writer interpolates between.
 *
 * Every segment between consecutive keyframes is LINEAR, which is what
 * ASS `\t(t1,t2,...)` does with the default acceleration — so the writer
 * can transcribe these directly and libass reproduces the same curve the
 * preview draws.
 *
 * Returns an empty array for an inert spec, which is how the writer knows
 * to emit no tags at all (and therefore keep byte-identical output for
 * every pre-REQ-0323 cue — REQ-0323 §1-5).
 */
export function animationKeyframes(
  spec: AnimationSpec,
  startSec: number,
  endSec: number,
): AnimationKeyframe[] {
  if (isAnimationInert(spec)) return []

  // Progress breakpoints where the curve changes slope.  `pop` bends at
  // its overshoot; everything else is a single straight segment.
  const breaks = spec.type === 'pop' ? [0, POP_PEAK_PROGRESS, 1] : [0, 1]

  const out: AnimationKeyframe[] = []
  const push = (atSec: number) => {
    // Derive the transform from the SAME function the preview uses, at
    // the same instant — this is why the keyframes cannot drift from the
    // continuous evaluation.
    const clamped = Math.max(startSec, Math.min(endSec, atSec))
    out.push({ atSec: clamped, transform: animationTransformAt(spec, startSec, endSec, clamped) })
  }

  const d = spec.durationSec
  if (spec.inEnabled) for (const p of breaks) push(startSec + p * d)
  if (spec.outEnabled) for (const p of [...breaks].reverse()) push(endSec - p * d)

  // De-duplicate coincident points (a cue shorter than the ramps can make
  // the in and out breakpoints collide) and keep them in time order.
  out.sort((a, b) => a.atSec - b.atSec)
  return out.filter((k, i) => i === 0 || Math.abs(k.atSec - out[i - 1].atSec) > 1e-9)
}
