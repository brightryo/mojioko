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
 * REQ-0331 §1-3 — bounds for the per-cue "強さ" (strength) control.
 *
 * The row's *meaning* depends on the type, so there are two independent
 * stored fields rather than one polymorphic number: a single "strength"
 * whose unit silently changed with the type is the kind of field that
 * reads fine and behaves wrong the moment somebody switches type with a
 * value already stored.
 *
 * - `scale` / `pop` → **start scale**, percent of natural size.  The
 *   owner's observation was that the apparent travel distance grows with
 *   the font size; that is inherent to a scale (the glyph box is what is
 *   being scaled), so the knob the user actually gets is *where it starts
 *   from*.
 * - `blur` → **peak blur radius** in ASS px (= output video px).
 * - `fade` → nothing; the row is greyed out.
 */
export const ANIMATION_START_SCALE_MIN_PCT = 0
export const ANIMATION_START_SCALE_MAX_PCT = 100
export const ANIMATION_START_SCALE_STEP_PCT = 5

export const ANIMATION_BLUR_MIN_PX = 1
export const ANIMATION_BLUR_MAX_PX = 30
export const ANIMATION_BLUR_STEP_PX = 1

/**
 * Curve constants.  Deliberately module-level named constants rather than
 * inline literals — CLAUDE.md §3 forbids magic numbers, and these are the
 * knobs an owner is most likely to want retuned after seeing it on real
 * footage.
 */
/**
 * DEFAULT start scale for `scale` — where a cue that has never touched
 * the strength row begins.  0.7 = noticeable but not a zoom.  Kept as the
 * default (rather than becoming a hard constant) so pre-REQ-0331 cues look
 * exactly as they did.
 */
export const SCALE_START = 0.7
/** DEFAULT start scale for `pop`: from nothing. */
export const POP_START_SCALE = 0
/** `pop` overshoots to this before settling at 1. */
export const POP_OVERSHOOT = 1.18
/** Fraction of the ramp spent going start → overshoot (rest settles to 1). */
export const POP_PEAK_PROGRESS = 0.45
/** DEFAULT peak blur for `blur` (ASS px); sharpens to 0. */
export const BLUR_MAX_PX = 8

/**
 * REQ-0331 §2-3 — `blur` radius falls as `pow(1 - p, BLUR_EASE_POWER)`.
 *
 * A LINEAR radius ramp is what RES-0323 §7 complained about: a gaussian
 * edge's sharpness goes roughly as 1/sigma, so half-way through a linear
 * ramp from 8 px the glyph is still at 4 px = 13 % of its final sharpness.
 * The cue therefore looks like an unreadable smear for most of the ramp
 * and then snaps into focus at the very end.  Raising the radius to a
 * power pulls the radius down early (8 → 1.4 px by mid-ramp at 2.5), which
 * spends the ramp in the range where the change is actually *visible*.
 *
 * Tuning: LOWER = stays blurry longer (1 reproduces the old linear ramp),
 * HIGHER = sharpens sooner.
 */
export const BLUR_EASE_POWER = 2.5

/**
 * REQ-0331 §2-3 — the fraction of the ramp over which OPACITY moves, for
 * every type except `fade`.
 *
 * "Combine with fade" is implemented as *each type owning an opacity
 * component*, not as a multi-select — a multi-select would reintroduce the
 * composition-ordering problem REQ-0323 deliberately avoided by allowing
 * one type at a time.
 *
 * 0.5 means: the cue reaches full opacity half-way through its entrance,
 * while the scale / blur channel keeps easing for the remaining half.
 * That ordering is what makes the motion read as "it arrives, then it
 * settles" rather than "it materialises exactly as it stops moving".
 *
 * This fraction is ALSO what the ASS writer turns into `\fad`, so it must
 * stay a linear ramp over a sub-window (see `animationFadeMs`): libass's
 * `\fad` is linear, and matching it exactly here is what keeps the opacity
 * channel free of approximation error.
 *
 * Tuning: LOWER = snappier appearance, HIGHER = more of a cross-fade.
 * 1 makes the opacity ramp exactly as long as the animation.
 */
export const ANIMATION_OPACITY_RAMP_FRACTION = 0.5

/**
 * The fraction of the ramp spent moving the opacity, per type.  `fade` is
 * 1 by definition (opacity IS the animation), and keeping it at 1 is what
 * makes a migrated legacy cue still emit `\fad(300,300)` byte for byte.
 */
function opacityRampFraction(type: AnimationType): number {
  return type === 'fade' ? 1 : ANIMATION_OPACITY_RAMP_FRACTION
}

// ---------------------------------------------------------------------------
// Easing.  REQ-0331 §2-2: these live HERE and nowhere else.  The preview
// evaluates them per frame; the ASS writer samples them (see
// `animationKeyframes`).  A second copy in `cue-animation-ass.ts` is the
// exact regression REQ-0320 §1 records.
//
// ## Why one map covers both ends
//
// `rampProgress` has already collapsed entrance and exit into a single
// number that RISES 0→1 on the way in and FALLS 1→0 on the way out.  So a
// single decelerating map g(p) is automatically ease-OUT entering (fast
// then slow) and ease-IN leaving (slow then fast) — the asymmetry §2-3
// asks for, with no in/out branch to keep in sync.
// ---------------------------------------------------------------------------

/** Decelerating: covers most of the distance immediately, eases to rest. */
function easeOutCubic(p: number): number {
  const u = 1 - p
  return 1 - u * u * u
}

/** Zero slope at BOTH ends — the settle half of a bounce. */
function smoothstep(p: number): number {
  return p * p * (3 - 2 * p)
}

/**
 * The start scale a cue of `type` gets when it carries no explicit
 * `animationStartScalePercent`.  Exported because the UI needs the SAME
 * answer when the user switches type (it re-seeds the strength row), and
 * two copies of "pop starts at 0, scale starts at 70" would drift.
 */
export function defaultStartScalePercent(type: AnimationType): number {
  return type === 'pop' ? POP_START_SCALE * 100 : SCALE_START * 100
}

/** The resolved, defaults-applied animation settings for one cue. */
export interface AnimationSpec {
  type: AnimationType
  inEnabled: boolean
  outEnabled: boolean
  durationSec: number
  direction: AnimationDirection
  distancePx: number
  /**
   * REQ-0331 §1-3 — where `scale` / `pop` start, 1 = natural size.
   * Ignored by the other types.
   */
  startScale: number
  /** REQ-0331 §1-3 — peak `blur` radius in ASS px.  Ignored otherwise. */
  blurMaxPx: number
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
  animationStartScalePercent?: unknown
  animationBlurPx?: unknown
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
        startScale: SCALE_START,
        blurMaxPx: BLUR_MAX_PX,
      }
    }
    return {
      type: 'none',
      inEnabled: true,
      outEnabled: true,
      durationSec: ANIMATION_DURATION_DEFAULT_SEC,
      direction: 'down',
      distancePx: ANIMATION_DISTANCE_DEFAULT_PX,
      startScale: SCALE_START,
      blurMaxPx: BLUR_MAX_PX,
    }
  }

  const type = coerceType(rawType)
  const durationRaw = typeof entry.animationDurationSec === 'number'
    ? entry.animationDurationSec
    : ANIMATION_DURATION_DEFAULT_SEC
  const distanceRaw = typeof entry.animationDistancePx === 'number'
    ? entry.animationDistancePx
    : ANIMATION_DISTANCE_DEFAULT_PX
  // REQ-0331 §1-3 — absent means "the default for THIS type", which is not
  // the same number for `scale` (70 %) and `pop` (0 %).  Every pre-REQ-0331
  // cue is in exactly this branch, which is what keeps it looking identical.
  const startScaleRaw = typeof entry.animationStartScalePercent === 'number'
    ? entry.animationStartScalePercent
    : defaultStartScalePercent(type)
  const blurRaw = typeof entry.animationBlurPx === 'number'
    ? entry.animationBlurPx
    : BLUR_MAX_PX

  return {
    type,
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
    startScale: Math.min(
      ANIMATION_START_SCALE_MAX_PCT,
      Math.max(ANIMATION_START_SCALE_MIN_PCT, startScaleRaw),
    ) / 100,
    blurMaxPx: Math.min(
      ANIMATION_BLUR_MAX_PX,
      Math.max(ANIMATION_BLUR_MIN_PX, blurRaw),
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
  // REQ-0331 §2-3 — every non-fade type carries its own opacity component.
  const opacity = clamp01(p / opacityRampFraction(spec.type))
  switch (spec.type) {
    case 'fade':
      // opacityRampFraction('fade') === 1, so this IS `p`.  Written through
      // the shared expression rather than as a literal `p` so there is one
      // definition of "the opacity component" for every type.
      return { ...NEUTRAL_TRANSFORM, opacity }
    case 'blur':
      return {
        ...NEUTRAL_TRANSFORM,
        opacity,
        blurPx: spec.blurMaxPx * Math.pow(1 - p, BLUR_EASE_POWER),
      }
    case 'scale':
      return {
        ...NEUTRAL_TRANSFORM,
        opacity,
        // Decelerating in, accelerating out — see the easing note above.
        scale: spec.startScale + (1 - spec.startScale) * easeOutCubic(p),
      }
    case 'pop': {
      // Two phases, each eased, meeting at the overshoot with zero slope on
      // both sides — that C1 join is what makes it read as a spring
      // settling rather than as a triangle wave.  Phase A launches hard and
      // decelerates into the peak; phase B leaves the peak from rest
      // (smoothstep) and arrives at rest.
      const peak = POP_PEAK_PROGRESS
      const s0 = spec.startScale
      const scale = p <= peak
        ? s0 + (POP_OVERSHOOT - s0) * easeOutCubic(p / peak)
        : POP_OVERSHOOT + (1 - POP_OVERSHOOT) * smoothstep((p - peak) / (1 - peak))
      return { ...NEUTRAL_TRANSFORM, opacity, scale }
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
 * REQ-0331 §2-2 — how far a piecewise-LINEAR chord may sit from the real
 * curve before the sampler splits the interval.
 *
 * Units: scale factor (0.004 = 0.4 % of natural size) and, for blur, the
 * same fraction of the cue's own peak radius.  Opacity is deliberately NOT
 * part of the metric: it is carried by `\fad`, which reproduces the ramp
 * exactly, so sampling it would buy nothing.
 *
 * Why a tolerance instead of a fixed sample count: the four curves have
 * wildly different curvature.  `scale` (easeOutCubic across a 0.3 range)
 * is nearly straight and 4 segments cover it; `pop`'s launch phase is ~20×
 * steeper and a count chosen for it would trip 5× the tags on every other
 * type.  A tolerance spends tags exactly where the eye can see the error,
 * and — unlike a magic N — stays correct if the curves are retuned.
 * `ANIMATION_SAMPLE_MAX_DEPTH` bounds the cost at 2^depth segments per
 * ramp no matter what curve is added later.
 */
export const ANIMATION_SAMPLE_TOLERANCE = 0.004
export const ANIMATION_SAMPLE_MAX_DEPTH = 5

/** Interior positions the sampler measures the chord error at.  See below. */
const SAMPLE_PROBES: readonly number[] = [0.25, 0.5, 0.75]

/** Worst per-channel deviation between two states, normalised. */
function transformDistance(
  spec: AnimationSpec,
  a: AnimationTransform,
  b: AnimationTransform,
): number {
  const blurRef = Math.max(1, spec.blurMaxPx)
  return Math.max(
    Math.abs(a.scale - b.scale),
    Math.abs(a.blurPx - b.blurPx) / blurRef,
  )
}

/**
 * Progress values to emit control points at, chosen by recursive bisection
 * so the chord between neighbours never departs from the curve by more
 * than `ANIMATION_SAMPLE_TOLERANCE`.
 *
 * `pop` seeds the split at its overshoot: linear interpolation ACROSS a
 * maximum always clips it, and clipping the overshoot is precisely losing
 * the pop.  Seeding it makes the peak an exact control point.
 */
function progressSamples(spec: AnimationSpec): number[] {
  const seeds = spec.type === 'pop' ? [0, POP_PEAK_PROGRESS, 1] : [0, 1]
  const out: number[] = [seeds[0]]

  const refine = (p0: number, p1: number, depth: number): void => {
    if (depth < ANIMATION_SAMPLE_MAX_DEPTH) {
      const a = curve(spec, p0)
      const b = curve(spec, p1)
      let worst = 0
      // Probing the MIDPOINT ALONE is not enough, and the failure is silent:
      // `smoothstep` (pop's settle phase) is odd-symmetric about its centre,
      // so its chord passes exactly through the true midpoint value.  A
      // midpoint-only test therefore reports zero error and accepts the whole
      // phase as one straight line — an 0.017 scale error, four times the
      // tolerance, in the segment that is supposed to read as a bounce.
      for (const f of SAMPLE_PROBES) {
        const chord: AnimationTransform = {
          ...NEUTRAL_TRANSFORM,
          scale: a.scale + (b.scale - a.scale) * f,
          blurPx: a.blurPx + (b.blurPx - a.blurPx) * f,
        }
        const real = curve(spec, p0 + (p1 - p0) * f)
        worst = Math.max(worst, transformDistance(spec, chord, real))
      }
      if (worst > ANIMATION_SAMPLE_TOLERANCE) {
        const mid = (p0 + p1) / 2
        refine(p0, mid, depth + 1)
        refine(mid, p1, depth + 1)
        return
      }
    }
    out.push(p1)
  }

  for (let i = 1; i < seeds.length; i++) refine(seeds[i - 1], seeds[i], 0)
  return out
}

/**
 * REQ-0331 §2-3 — the opacity component, expressed as libass `\fad`
 * milliseconds.
 *
 * The opacity channel is NOT transcribed from keyframes.  `\fad` is a
 * linear alpha ramp over a window measured from the event's own ends, and
 * `curve()`'s opacity is `clamp01(p / fraction)` — a linear ramp over
 * exactly that window.  So `\fad` reproduces it with **zero approximation
 * error and one tag**, whereas expressing it as `\t(...\alpha...)` would
 * both cost N tags and clobber the cue's own `\1a`/`\3a`/`\4a` (the
 * per-cue text / outline / shadow opacities are a shipped feature).
 *
 * This function and `opacityRampFraction` are the ONLY two places the
 * opacity window is defined — the writer just prints what it returns.
 */
export function animationFadeMs(spec: AnimationSpec): { inMs: number; outMs: number } {
  if (isAnimationInert(spec) || spec.type === 'slide') return { inMs: 0, outMs: 0 }
  const ms = Math.round(spec.durationSec * opacityRampFraction(spec.type) * 1000)
  if (ms <= 0) return { inMs: 0, outMs: 0 }
  return {
    inMs: spec.inEnabled ? ms : 0,
    outMs: spec.outEnabled ? ms : 0,
  }
}

/**
 * The control points the ASS writer interpolates between.
 *
 * Every segment between consecutive keyframes is LINEAR, which is what
 * ASS `\t(t1,t2,...)` does with the default acceleration — so the writer
 * can transcribe these directly and libass reproduces the same curve the
 * preview draws.  Eased curves are therefore delivered as a piecewise-
 * linear approximation whose error is bounded by
 * `ANIMATION_SAMPLE_TOLERANCE` (ASS `\t` offers only `pow(progress,
 * accel)`, which cannot express overshoot at all).
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

  const breaks = progressSamples(spec)

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

/**
 * REQ-0325 §2 — the animation fields to stamp onto a NEW cue, taken from
 * `TranscriptionDefaults`.
 *
 * Cue creation uses the v1.2.2 "作成時コピー方式": every entry carries its own
 * concrete values, so later edits to the defaults do not retroactively
 * rewrite existing cues.  Animation follows that, unlike `karaokeStyle`
 * (REQ-0322 §3), because here the settings row is genuinely "what new cues
 * start with" rather than a live fallback.
 *
 * Returns `{}` when the defaults carry no explicit choice, so the new cue
 * stays on the `fadeDurationSec` migration path and pre-REQ-0325 settings
 * keep producing the fade they always did.
 */
export function animationFieldsForNewCue(defaults: {
  animationType?: AnimationType
  animationInEnabled?: boolean
  animationOutEnabled?: boolean
  animationDurationSec?: number
  animationStartScalePercent?: number
  animationBlurPx?: number
}): {
  animationType?: AnimationType
  animationInEnabled?: boolean
  animationOutEnabled?: boolean
  animationDurationSec?: number
  animationStartScalePercent?: number
  animationBlurPx?: number
} {
  if (defaults.animationType === undefined) return {}
  return {
    animationType: defaults.animationType,
    animationInEnabled: defaults.animationInEnabled !== false,
    animationOutEnabled: defaults.animationOutEnabled !== false,
    animationDurationSec: defaults.animationDurationSec ?? ANIMATION_DURATION_DEFAULT_SEC,
    animationStartScalePercent: defaults.animationStartScalePercent
      ?? defaultStartScalePercent(defaults.animationType),
    animationBlurPx: defaults.animationBlurPx ?? BLUR_MAX_PX,
  }
}
