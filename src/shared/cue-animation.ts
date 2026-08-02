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
 * REQ-0324 §2 — whether `blur` is offered in the UI.  A single flag so
 * the decision has one home; the curve, the ASS emitter and the preview
 * all keep working regardless, so flipping this does not strand data.
 */
export const ANIMATION_BLUR_ENABLED = true

/**
 * The types the UI offers.  REQ-0324 §1 keeps `slide` OUT of the list, and
 * REQ-0334 §3 (owner decision 2026-07-28) **deferred slide out of v1.3.6
 * entirely** — `curve()` returns neutral and `buildAnimationTags` returns
 * `''` for it, so offering it would be a control that silently does
 * nothing.  It stays in `AnimationType` so stored values and the ASS
 * writer's exhaustive switch already accommodate it.
 *
 * ★ Adding a member here is a promise that the type renders.  It is
 * enforced, not merely documented: `tests/unit/cue-animation-req-0323.test.ts`
 * → "REQ-0334 §3 — every selectable animation type actually does
 * something" asserts that every member except `none` emits a non-empty ASS
 * tag AND moves the preview off `NEUTRAL_TRANSFORM`.  The test passes on
 * its own the day slide is genuinely implemented, and fails only if a type
 * is listed here without an implementation behind it.
 */
export const SELECTABLE_ANIMATION_TYPES: readonly AnimationType[] = [
  'none', 'fade', 'pop', 'scale', 'blur',
] as const

/** Narrow an unknown UI value to a type.  Unknown → `none`. */
export function coerceAnimationType(v: unknown): AnimationType {
  return (ANIMATION_TYPES as readonly unknown[]).includes(v) ? (v as AnimationType) : 'none'
}

// ---------------------------------------------------------------------------
// REQ-0337 §1 / §2 — the per-type defaults table, and the "強さ" scale.
// ---------------------------------------------------------------------------

/**
 * REQ-0337 §2 — the two directions of the strength knob.
 *
 * `scale` / `pop` STORE a **start scale** (`animationStartScalePercent`):
 * 0 % = grows from nothing = the biggest movement, 100 % = starts at
 * natural size = no movement at all.  `blur` stores a **peak radius**,
 * where bigger is unambiguously stronger.  Under the single label 「強さ」
 * that made the slider run backwards depending on the type, which is what
 * the owner reported in REQ-0337 §2-1.
 *
 * The fix is a display-only inversion.  **The stored meaning is
 * unchanged** (REQ-0337 §2-3): `animationStartScalePercent` is still a
 * start scale in every project file, in `AnimationSpec.startScale`, and in
 * the ASS writer.  Only the UI — and this table — speak in strength, so
 * there is no migration, no change to the curves below, and no change to a
 * single emitted byte.
 *
 * Blur needs no conversion: its stored value already rises with strength.
 */
export function strengthToStartScalePercent(strength: number): number {
  return 100 - strength
}
export function startScalePercentToStrength(startScalePercent: number): number {
  return 100 - startScalePercent
}

/** The starting point a type hands the user when it is PICKED. */
export interface AnimationTypeDefaults {
  /** Seconds, per END of the cue. */
  durationSec: number
  inEnabled: boolean
  outEnabled: boolean
  /**
   * 強さ on the unified scale (see `strengthToStartScalePercent`): larger
   * is always stronger.  The UNIT still depends on the type — travel
   * percent for `scale` / `pop`, ASS px for `blur` — which is why the two
   * stored fields stay separate and are read through
   * `defaultStartScalePercent` / `BLUR_MAX_PX` rather than from here
   * directly.  `fade` has no strength; its entry is inert filler that
   * keeps the map exhaustive.
   */
  strength: number
}

/**
 * REQ-0337 §1-2 — where every animation parameter starts, per type.
 *
 * ## Why this table exists
 *
 * Before it, changing the type re-seeded the STRENGTH (REQ-0331 — a
 * `pop` inheriting `scale`'s 70 % start does not pop) but carried the
 * duration and the timing switches over unchanged.  One parameter
 * followed the type and the others did not, which reads as a bug because
 * it is an inconsistency with no reason behind it.  Picking a type now
 * writes ALL of them from here.
 *
 * ## ★ Exhaustive by construction
 *
 * The annotation is `{ readonly [K in AnimationType]-?: … }`, the same
 * shape `style-preset.ts`, `duplicate-entry.ts`, `settings-merge.ts` and
 * `style-defaults-to-entry.ts` use.  Adding a member to `AnimationType`
 * (slide is already there; a future `wipe` would be next) fails `tsc`
 * here until its defaults are written, rather than silently inheriting
 * whatever the previous type had.
 *
 * ## ★ This table does NOT override `TranscriptionDefaults`
 *
 * REQ-0337 §1-4.  If the user saved "type = blur, duration = 0.5 s" as the
 * default for new cues, that is an explicit choice and
 * `animationFieldsForNewCue` uses it verbatim — it never consults this
 * table for a field the defaults already carry.  The table is only the
 * starting point you get at the moment you *pick* a type, which is why the
 * defaults panel re-seeds from it exactly like the inspector does (it
 * renders the same `AnimationControls`).
 */
export const ANIMATION_TYPE_DEFAULTS: {
  readonly [K in AnimationType]-?: AnimationTypeDefaults
} = {
  none:  { durationSec: 0.4, inEnabled: true, outEnabled: true, strength: 30 },
  fade:  { durationSec: 0.2, inEnabled: true, outEnabled: true, strength: 30 },
  scale: { durationSec: 0.4, inEnabled: true, outEnabled: true, strength: 30 },
  pop:   { durationSec: 0.4, inEnabled: true, outEnabled: true, strength: 100 },
  blur:  { durationSec: 0.8, inEnabled: true, outEnabled: true, strength: 30 },
  // Dormant (REQ-0334 §3); present so the map stays exhaustive.
  slide: { durationSec: 0.4, inEnabled: true, outEnabled: true, strength: 30 },
} as const

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
/**
 * ★ REQ-0337 §2-6 — WHY THE MINIMUM STRENGTH IS NOT ZERO.
 *
 * Every type except `fade` carries its OWN opacity ramp (REQ-0331 §2-3 —
 * see `opacityRampFraction` and `curve` below).  So a cue at the weakest
 * strength is **not** "animation off": it still fades.  What it loses is
 * the component that makes it a different animation at all —
 *
 *   - strength 0 on `scale` / `pop` is start scale 100 %, i.e. no scaling
 *     whatsoever, so the cue degenerates into a plain fade wearing a
 *     different type name;
 *   - blur below ~20 px at output resolution is, in the owner's words,
 *     indistinguishable from a fade.
 *
 * The floors are therefore ABOVE zero deliberately: the range excludes the
 * region where the control has stopped meaning anything.  **Do not lower
 * them to 0 because a slider that does not start at zero looks unnatural**
 * — that reintroduces the degeneration, and a user who wants a plain fade
 * already has `fade` in the type list.
 *
 * Provenance: the blur range (20–80 since REQ-0377 §B, default 30) is the
 * owner's decision; the 40 → 80 ceiling raise is bounded by the measured
 * preview↔burn parity limit (~100, libass `\blur` saturates there).  The
 * scale/pop floor of 10 was inferred by applying the same principle, not
 * instructed — see RES-0337.
 */
export const ANIMATION_STRENGTH_SCALE_MIN = 10
export const ANIMATION_STRENGTH_SCALE_MAX = 100
export const ANIMATION_STRENGTH_SCALE_STEP = 5

/**
 * The STORED start-scale bounds, DERIVED from the strength bounds so the
 * displayed range and the stored range cannot drift apart.  The inversion
 * swaps the ends: strength 100 (the biggest movement) is start scale 0,
 * and the strength floor of 10 becomes a start-scale ceiling of 90.
 */
export const ANIMATION_START_SCALE_MIN_PCT =
  strengthToStartScalePercent(ANIMATION_STRENGTH_SCALE_MAX)
export const ANIMATION_START_SCALE_MAX_PCT =
  strengthToStartScalePercent(ANIMATION_STRENGTH_SCALE_MIN)
export const ANIMATION_START_SCALE_STEP_PCT = ANIMATION_STRENGTH_SCALE_STEP

/** Blur's stored value already rises with strength, so these are both. */
export const ANIMATION_BLUR_MIN_PX = 20
/**
 * REQ-0377 §B — raised 40 → 80.  The minimum is unchanged and the default
 * (`BLUR_MAX_PX = ANIMATION_TYPE_DEFAULTS.blur.strength`, 30) is a SEPARATE
 * constant, so nothing existing moves: `animationBlurPx` is stored in absolute
 * ASS px and `resolveAnimation`'s `clamp([MIN, MAX])` passes every prior value
 * (≤ 40) through unchanged — the burn stays byte-identical (no migration).
 *
 * 80 is safe because preview↔burn blur parity was MEASURED to hold there:
 * `scripts/verify-blur-parity` (chromium CSS `blur(N·0.84)` vs ffmpeg libass
 * `\blur N`, edge σ) gives |Δσ|/σ ≤ ~4 % for every N ≤ 100, with σ/N ≈ 0.84
 * constant on both engines.  libass's `\blur` SATURATES around N ≈ 100
 * (σ ≈ 84 at N = 100/110/120) while CSS keeps growing, so the parity-safe
 * ceiling is ~100; 80 leaves margin.  Going past ~100 would ship a divergence
 * (|Δ| 15.7 % at N = 120) — do NOT raise this above ~100 without re-measuring.
 */
export const ANIMATION_BLUR_MAX_PX = 80
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
export const SCALE_START =
  strengthToStartScalePercent(ANIMATION_TYPE_DEFAULTS.scale.strength) / 100
/** DEFAULT start scale for `pop`: from nothing. */
export const POP_START_SCALE =
  strengthToStartScalePercent(ANIMATION_TYPE_DEFAULTS.pop.strength) / 100
/** `pop` overshoots to this before settling at 1. */
export const POP_OVERSHOOT = 1.18
/** Fraction of the ramp spent going start → overshoot (rest settles to 1). */
export const POP_PEAK_PROGRESS = 0.45
/**
 * DEFAULT peak blur for `blur` (ASS px); sharpens to 0.  Comes from the
 * per-type table (REQ-0337 §1-2), which raised it from 8 to 30.
 */
export const BLUR_MAX_PX = ANIMATION_TYPE_DEFAULTS.blur.strength

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
  // Only `scale` and `pop` read this field, so only they take their own
  // entry.  Every other type gets `scale`'s value: the field is still
  // written (the surfaces write the whole spec), and parking it on a
  // sensible number means switching blur → scale lands somewhere useful
  // rather than on whatever the last unrelated type happened to leave.
  return type === 'pop' || type === 'scale'
    ? strengthToStartScalePercent(ANIMATION_TYPE_DEFAULTS[type].strength)
    : strengthToStartScalePercent(ANIMATION_TYPE_DEFAULTS.scale.strength)
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
  // REQ-0337 §1-5 — the fallbacks here are deliberately NOT
  // `ANIMATION_TYPE_DEFAULTS`.  This function's job is to describe data
  // that already exists, and re-pointing an absent field at the new
  // per-type table would change how existing projects LOOK (a stored
  // `fade` with no duration would go 0.4 s → 0.2 s) without anyone having
  // touched them.  The table is the starting point for a NEW choice —
  // `animationFieldsForNewCue` and the type-change re-seed use it.
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
    // ★ REQ-0337 §2-5 — THE clamp, and the only one.
    //
    // The ranges moved with the strength rework (blur 1–30 → 20–40 px,
    // start scale 0–100 → 0–90 %), so cues written earlier can hold values
    // the sliders can no longer reach: an 8 px blur, or a 100 % start
    // scale that does not scale at all.  Clamping HERE rather than in the
    // slider is what keeps the preview and the burn-in agreeing — both
    // read the spec through this function, whereas a UI-side clamp would
    // leave the ASS writer emitting the stale number and reproduce
    // REQ-0320 §1 exactly.
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

/** The entrance / exit ramp lengths a cue actually gets, in seconds. */
export interface AnimationWindows {
  inSec: number
  outSec: number
}

/**
 * REQ-0333 §4 — the ONE place the entrance / exit windows are decided.
 *
 * ## The bug this fixes
 *
 * The requested duration is per-END, so a cue with both ends enabled asks
 * for `2 × durationSec` of ramp.  When that exceeds the cue's own length
 * the two windows overlap, and the preview and the burn then disagree
 * about what overlapping windows mean:
 *
 *   - the shared model took `min(pIn, pOut)`, i.e. a triangle that peaks
 *     part-way up and never settles;
 *   - libass's `\fade(a1,a2,a3,t1,t2,t3,t4)` — which `\fad(in,out)`
 *     expands to with `t2 = in` and `t3 = dur − out` — tests its control
 *     points in order, so when `t2 > t3` the whole in-ramp wins, the cue
 *     reaches FULL opacity at `t2`, and the alpha then JUMPS to wherever
 *     the out-ramp had already got to.  A discontinuity, and nothing like
 *     a triangle.
 *
 * Rather than teach the shared model to imitate that (it is a libass
 * implementation artefact, not a design), the windows are shrunk so they
 * can never overlap in the first place.  Then `min(pIn, pOut)` and
 * `\fade`'s control points describe the same shape and the question of
 * who wins the overlap does not arise.
 *
 * ## Why PROPORTIONAL shrink rather than one-side priority
 *
 * Both windows are scaled by the same factor `cueLen / (in + out)`.
 *
 *   - It is symmetric.  A cue with both ends enabled keeps both ends —
 *     each gets half the cue.  One-side priority ("the entrance is worth
 *     more") would delete the exit outright on a short cue, and a caption
 *     that fades in but cuts to black is a far more visible defect than
 *     one whose fades are simply quick.
 *   - It preserves the enabled/disabled asymmetry for free: a cue with
 *     only ONE end enabled has `total = durationSec`, so the factor
 *     clamps that single window to the whole cue, which is the obvious
 *     right answer and needs no special case.
 *   - It is a no-op whenever the windows fit (`total <= cueLen`), and the
 *     early return below leaves the requested value *untouched* — not
 *     multiplied by a factor of 1 — so ordinary cues cannot pick up a
 *     floating-point difference and change a single emitted byte.
 */
export function animationWindows(
  spec: AnimationSpec,
  startSec: number,
  endSec: number,
): AnimationWindows {
  if (isAnimationInert(spec)) return { inSec: 0, outSec: 0 }
  const want: AnimationWindows = {
    inSec: spec.inEnabled ? spec.durationSec : 0,
    outSec: spec.outEnabled ? spec.durationSec : 0,
  }
  const total = want.inSec + want.outSec
  const cueSec = Math.max(0, endSec - startSec)
  if (total <= 0 || total <= cueSec) return want
  const factor = cueSec / total
  return { inSec: want.inSec * factor, outSec: want.outSec * factor }
}

/**
 * Ramp progress at time `t`: 0 = fully un-entered, 1 = fully settled.
 *
 * Taking the MINIMUM of the entrance and exit ramps generalises exactly
 * what `computeFadeOpacity` did for `\fad`.  Since REQ-0333 §4 the two
 * windows are clamped so they cannot overlap, so the `min` only ever
 * picks the ramp that is actually running — see `animationWindows` for
 * why the overlap had to go rather than be modelled.
 */
function rampProgress(spec: AnimationSpec, startSec: number, endSec: number, tSec: number): number {
  const { inSec, outSec } = animationWindows(spec, startSec, endSec)
  const pIn = inSec > 0 ? clamp01((tSec - startSec) / inSec) : 1
  const pOut = outSec > 0 ? clamp01((endSec - tSec) / outSec) : 1
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
      // ★ DORMANT — deferred out of v1.3.6 (REQ-0334 §3; owner decision
      // 2026-07-28).  Declared here so the type is exhaustive and the
      // preview/ASS split is already in place, but the geometry is not
      // implemented — it returns neutral, i.e. no movement.
      //
      // Adding `'slide'` to `SELECTABLE_ANIMATION_TYPES` without first
      // implementing this branch (and the `\move` branch in
      // `cue-animation-ass.ts:buildAnimationTags`) ships a dropdown entry
      // that silently does nothing.  `tests/unit/cue-animation-req-0323.test.ts`
      // → "REQ-0334 §3 — every selectable animation type actually does
      // something" fails in exactly that case; do not weaken it, implement
      // the branch instead.  The measured `\move` groundwork is in
      // `dev-docs/specs/event-splitting.md`.
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
 * REQ-0378 — the ONE decision for "what animation state does this cue show at
 * time `tSec`", shared by the preview's mount-time callback ref, its rAF loop,
 * AND its React render (which seeds the `--cue-anim-*` custom-property defaults
 * so the FIRST painted frame of a playback activation is already the animated
 * state, not the settled default that used to flash for one frame).
 *
 * Three copies of this predicate is exactly how the render default and the
 * imperative writer would drift apart and reintroduce the flash — so there is
 * one.  The paused-at-or-before-start snap (REQ-0195 / REQ-0323 §1-2) keeps a
 * cue parked on its own start visible-and-settled for editing; out of range is
 * hidden; everything else samples the burn-in-accurate curve.
 */
export function resolveCueAnimState(
  entry: Parameters<typeof resolveAnimation>[0] & { startSec: number; endSec: number },
  tSec: number,
  isPaused: boolean,
): { anim: AnimationTransform; inRange: boolean } {
  const inRange = tSec >= entry.startSec && tSec < entry.endSec
  const snapToSettled = isPaused && tSec <= entry.startSec
  const anim =
    snapToSettled || !inRange
      ? { ...NEUTRAL_TRANSFORM }
      : animationTransformAt(resolveAnimation(entry), entry.startSec, entry.endSec, tSec)
  return { anim, inRange }
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
 *
 * REQ-0333 §4 — the window comes from `animationWindows`, which is why
 * this now needs the cue's own bounds.  Emitting `\fad(in,out)` with
 * `in + out > dur` is what made libass's control points cross; going
 * through the shared clamp means the pair emitted here can never do that,
 * and it is the SAME clamp `animationTransformAt` applies, so the preview
 * cannot describe a different ramp.
 */
export function animationFadeMs(
  spec: AnimationSpec,
  startSec: number,
  endSec: number,
): { inMs: number; outMs: number } {
  if (isAnimationInert(spec) || spec.type === 'slide') return { inMs: 0, outMs: 0 }
  const fraction = opacityRampFraction(spec.type)
  const { inSec, outSec } = animationWindows(spec, startSec, endSec)
  return {
    inMs: Math.round(inSec * fraction * 1000),
    outMs: Math.round(outSec * fraction * 1000),
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

  // REQ-0333 §4 — sample over the CLAMPED windows.  Using `durationSec`
  // here while `rampProgress` used a shorter window would put the control
  // points at instants the curve no longer passes through, i.e. exactly
  // the preview/burn split this REQ closes.  Unclamped, `inSec` IS
  // `durationSec`, so ordinary cues keep the identical arithmetic.
  const { inSec, outSec } = animationWindows(spec, startSec, endSec)
  if (inSec > 0) for (const p of breaks) push(startSec + p * inSec)
  if (outSec > 0) for (const p of [...breaks].reverse()) push(endSec - p * outSec)

  // De-duplicate coincident points (the in and out breakpoints can still
  // collide when the clamped windows exactly meet) and keep them in time
  // order.
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
 *
 * ## ★ REQ-0337 §1-4 — the per-type table must NOT win here
 *
 * Every field the settings panel actually saved is copied VERBATIM.  A
 * user who set "type = blur, duration = 0.5 s" as their default made an
 * explicit choice, and `ANIMATION_TYPE_DEFAULTS.blur.durationSec` (0.8)
 * must not quietly overrule it.  The table is consulted only for fields
 * the defaults do not carry at all — i.e. a settings file written before
 * that field existed — where there is no choice to respect.
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
  const table = ANIMATION_TYPE_DEFAULTS[defaults.animationType]
  return {
    animationType: defaults.animationType,
    animationInEnabled: defaults.animationInEnabled !== false,
    animationOutEnabled: defaults.animationOutEnabled !== false,
    animationDurationSec: defaults.animationDurationSec ?? table.durationSec,
    animationStartScalePercent: defaults.animationStartScalePercent
      ?? defaultStartScalePercent(defaults.animationType),
    animationBlurPx: defaults.animationBlurPx ?? BLUR_MAX_PX,
  }
}

// ---------------------------------------------------------------------------
// REQ-0337 §1 — the UI value object, and the two operations every animation
// surface performs on it.
//
// The inspector, the bulk-edit bar and the settings 「字幕スタイル」 panel all
// render one `AnimationControls`, but each of them used to re-implement the
// "spread the whole spec back onto the entry fields" step inline — three
// copies of the same six-line mapping.  That is the shape REQ-0320 §1
// records the cost of, so the mapping lives here and each surface calls it.
//
// It is also what makes REQ-0337 §1-4 testable without a DOM: the
// re-seed is a pure function of the type, and the write is a pure function
// of (current, patch), so "the defaults panel re-seeds exactly like the
// inspector" is a property of these two functions rather than of a
// component that only an integration test could reach.
// ---------------------------------------------------------------------------

/** A resolved animation as the flat object the controls bind to. */
export interface AnimationUiValue {
  type: AnimationType
  inEnabled: boolean
  outEnabled: boolean
  durationSec: number
  /**
   * The STORED start scale (percent of natural size), NOT the 「強さ」 the
   * slider shows — REQ-0337 §2-3 keeps the inversion inside the control.
   */
  startScalePercent: number
  /** Peak blur radius, ASS px.  Already rises with strength. */
  blurPx: number
}

/** The `SubtitleEntry` / `TranscriptionDefaults` fields an edit writes. */
export interface AnimationEntryFields {
  animationType: AnimationType
  animationInEnabled: boolean
  animationOutEnabled: boolean
  animationDurationSec: number
  animationStartScalePercent: number
  animationBlurPx: number
}

/** A resolved spec, viewed as the controls' value object. */
export function animationUiValue(spec: AnimationSpec): AnimationUiValue {
  return {
    type: spec.type,
    inEnabled: spec.inEnabled,
    outEnabled: spec.outEnabled,
    durationSec: spec.durationSec,
    startScalePercent: Math.round(spec.startScale * 100),
    blurPx: spec.blurMaxPx,
  }
}

/**
 * Apply a control patch and return the WHOLE field set to write.
 *
 * Whole, not just the changed key: a legacy cue carries no `animation*`
 * fields at all, so patching one would leave the rest falling through
 * `resolveAnimation`'s migration branch and the edit would appear not to
 * stick.  `current` therefore has to come from the RESOLVED spec.
 */
export function animationEntryFields(
  current: AnimationUiValue,
  patch: Partial<AnimationUiValue> = {},
): AnimationEntryFields {
  return {
    animationType: patch.type ?? current.type,
    animationInEnabled: patch.inEnabled ?? current.inEnabled,
    animationOutEnabled: patch.outEnabled ?? current.outEnabled,
    animationDurationSec: patch.durationSec ?? current.durationSec,
    animationStartScalePercent: patch.startScalePercent ?? current.startScalePercent,
    animationBlurPx: patch.blurPx ?? current.blurPx,
  }
}

/**
 * REQ-0337 §1-2 — every parameter a freshly PICKED type starts from.
 *
 * Returns a full value (not a partial) because picking a type overwrites
 * all of them: timing, duration and strength.  See
 * `ANIMATION_TYPE_DEFAULTS` for why the duration and switches now follow
 * the type as the strength already did.
 */
export function animationFieldsForTypeChange(type: AnimationType): AnimationUiValue {
  const seed = ANIMATION_TYPE_DEFAULTS[type]
  return {
    type,
    inEnabled: seed.inEnabled,
    outEnabled: seed.outEnabled,
    durationSec: seed.durationSec,
    startScalePercent: defaultStartScalePercent(type),
    blurPx: BLUR_MAX_PX,
  }
}
