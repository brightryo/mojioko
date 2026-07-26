/**
 * REQ-0310 — per-cue opacity for the text fill and the outline.
 *
 * ## Why this lives in `shared/`
 *
 * Three consumers must agree on the arithmetic or preview and burn-in drift:
 * the ass-generator (main process), `subtitle-overlay` (the CSS preview), and
 * the karaoke rAF loop in `video-preview-panel`.  Keeping the clamp and both
 * conversions here makes that agreement structural rather than a convention.
 *
 * ## Model
 *
 * The user-facing unit is **opacity percent**: 100 = fully opaque (the
 * default), 0 = fully transparent.  ASS stores the inverse — an *alpha* byte
 * where `00` is opaque and `FF` is transparent — so every conversion to ASS
 * flips the sense.  `undefined` means "never set", which resolves to 100 and,
 * critically, makes the emitters skip their tags entirely so an untouched cue
 * is byte-identical to the pre-REQ-0310 output.
 *
 * ## 0 % is legal
 *
 * REQ-0310 §2 is explicit that 0 must NOT be clamped away or warned about:
 * fill 0 % with an opaque outline is hollow/outline-only text, and fill 0 %
 * with karaoke on is the effect the feature was requested for (unspoken words
 * are invisible and appear as they are spoken).  Both alphas at 0 makes the cue
 * invisible; that is the user's choice.
 */

/** Opacity percent when the field is absent — fully opaque. */
export const OPACITY_DEFAULT_PERCENT = 100

/** Inclusive range for the opacity controls. */
export const OPACITY_MIN_PERCENT = 0
export const OPACITY_MAX_PERCENT = 100

/** Step used by the opacity sliders. */
export const OPACITY_STEP_PERCENT = 5

/**
 * Clamp a raw opacity percent into 0–100, rounding to an integer.
 * `undefined` (and any non-finite value) resolves to fully opaque.
 */
export function clampOpacityPercent(v: number | undefined): number {
  const raw = v ?? OPACITY_DEFAULT_PERCENT
  if (!Number.isFinite(raw)) return OPACITY_DEFAULT_PERCENT
  return Math.max(OPACITY_MIN_PERCENT, Math.min(OPACITY_MAX_PERCENT, Math.round(raw)))
}

/** True when this value leaves the cue fully opaque (⇒ emit no ASS alpha tag). */
export function isFullyOpaque(v: number | undefined): boolean {
  return clampOpacityPercent(v) === OPACITY_MAX_PERCENT
}

/**
 * Opacity percent → the two-hex-digit ASS alpha byte (uppercase).
 * ASS alpha is inverted: `00` = opaque, `FF` = transparent.
 *
 *   100 % → '00'      50 % → '80'      0 % → 'FF'
 */
export function opacityPercentToAssAlpha(v: number | undefined): string {
  const pct = clampOpacityPercent(v)
  const alpha = Math.round((1 - pct / 100) * 255)
  return alpha.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * Opacity percent → a full ASS alpha override VALUE (`&HXX&`), ready to append
 * to `\1a` / `\2a` / `\3a`.  The caller supplies the tag name so the emitted
 * override stays readable at the call site.
 */
export function assAlphaValue(v: number | undefined): string {
  return `&H${opacityPercentToAssAlpha(v)}&`
}

/**
 * `#RRGGBB` + opacity percent → a CSS `rgba(...)` string, for the preview.
 *
 * Returns the hex unchanged when the value is fully opaque so the emitted CSS
 * (and therefore every existing snapshot / visual expectation) is unchanged for
 * cues that never touched the new controls.  A malformed hex falls back to
 * opaque black, mirroring the defensive behaviour of the previous local
 * `hexToRgba` in `subtitle-overlay` — the ColorPicker validator upstream
 * guarantees the 6-hex form.
 */
export function hexWithOpacity(hex: string, v: number | undefined): string {
  if (isFullyOpaque(v)) return hex
  const pct = clampOpacityPercent(v)
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return `rgba(0, 0, 0, ${pct / 100})`
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r}, ${g}, ${b}, ${pct / 100})`
}
