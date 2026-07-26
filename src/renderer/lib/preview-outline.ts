/**
 * REQ-0311 §3 — preview outline geometry, extracted so it can be unit-tested
 * independently of the overlay's DOM.
 *
 * ## Why this file exists
 *
 * libass and CSS disagree about where an outline lives relative to the glyph:
 *
 *   - libass `\bord N` grows the border N px OUTWARD only.  It renders the
 *     border into its own bitmap and subtracts the glyph bitmap from it, so the
 *     border never intrudes on the glyph's interior.
 *   - CSS `-webkit-text-stroke: W` is CENTRED on the glyph outline: W/2 outside
 *     and W/2 inside.
 *
 * The overlay bridges this with `strokeWidth = 2N` + `paint-order: stroke fill`
 * — the fill paints over the stroke's inner half, leaving exactly N visible
 * outward.  Both halves of that claim were measured in Electron against a real
 * libass burn-in (REQ-0311 §3 ③) and both hold:
 *
 *   fill alpha 100 %, bord 5/12/20 -> outward 4.90/11.55/19.55 px
 *                                     (libass  5.70/12.00/20.00 px)
 *   with `paint-order`    the fill run stays 28 px at every bord
 *   without `paint-order` the fill run collapses 17 -> 3 -> 0 px
 *   with a 1x stroke      outward halves to 2.54/5.55/9.75 px
 *
 * ## The defect this mitigates
 *
 * That trick needs an OPAQUE fill.  REQ-0310 made the fill alpha-aware, so at
 * low `textAlpha` nothing masks the inner half any more and the stroke's
 * inward N becomes visible — the ring reads 2N instead of N.  Measured against
 * libass, whose interior hole stays a constant 24 px at every bord:
 *
 *   bord     2    5    8   12   20
 *   hole    21   16    9    0    0     <- preview, fill alpha 0 %
 *
 * At bord >= 12 the hole closes completely: hollow text renders SOLID in the
 * preview while the export stays hollow.  That is a qualitatively wrong
 * picture, not merely a thickness error.
 *
 * ## Why this is a clamp and not a real fix
 *
 * Stroke width drives the inward and outward extents together, so no choice of
 * width fixes one without breaking the other — measured: a 1x or
 * alpha-interpolated stroke restores the interior but collapses the outward
 * extent by up to 10.25 px at bord 20.  A true fix needs the glyph punched out
 * of the ring, which CSS cannot express: `feMorphology` quantises its radius at
 * the sub-pixel radii real preview scales produce (0.41-0.74x, too light) and
 * Chromium silently ignores an SVG `mask` fed by `foreignObject` (byte-identical
 * output).  The correct construction is a canvas ring layer
 * (`strokeText` then `destination-out` `fillText`), which is deferred to its
 * own REQ because it must re-implement the cue's intra-line layout.
 *
 * So this clamp buys back only the qualitative property — the interior stays
 * open — and is deliberately INERT at `textAlpha === 100`, where the shipping
 * model is already exact and must not be disturbed.
 *
 * DELETE THIS WHOLE MODULE when the canvas ring layer lands.
 */
import { OPACITY_MAX_PERCENT } from '../../shared/alpha'

/**
 * Floor (in preview pixels) applied to the visible outline so the thinnest
 * setting stays discernible at small preview sizes.  Carried over verbatim
 * from subtitle-overlay.tsx — behaviour-preserving.
 */
export const MIN_VISIBLE_OUTLINE_PX = 0.5

/**
 * Largest inward bleed tolerated before the clamp engages, as a fraction of the
 * rendered em.  A sans-serif stem is roughly 0.08-0.12 em, so holding the bleed
 * under ~0.04 em keeps a visible gap down the middle of a stroke instead of the
 * two inward halves meeting and filling it.
 *
 * Approximate on purpose: the exact stem width is a per-glyph, per-font
 * property the overlay has no access to at paint time, and the clamp only has
 * to prevent a qualitative failure, not achieve parity.
 */
export const MAX_INWARD_BLEED_EM = 0.04

export interface PreviewOutlineInput {
  /** `entry.outlineThicknessPx` — ASS/output video pixels, 0..OUTLINE_THICKNESS_MAX_PX. */
  outlineThicknessPx: number
  /** Preview display scale, `containerWidthPx / videoWidthPx`. */
  scale: number
  /** The already-scaled CSS font size, i.e. `fontSizePx * libassScale * scale`. */
  fontSizeCssPx: number
  /**
   * Fill opacity governing whether the fill can mask the stroke's inner half.
   * `undefined` means 100 % (REQ-0310's convention).  With karaoke on this is
   * the UNSPOKEN half's alpha (`\2a`), which is the half that renders hollow.
   */
  textAlphaPercent: number | undefined
}

export interface PreviewOutlineResult {
  /** Visible outward band, preview px — what should equal libass's `\bord`. */
  outlinePx: number
  /** The value to hand to `-webkit-text-stroke-width`. */
  strokeWidthPx: number
  /** True when the clamp engaged; surfaced for tests and debugging. */
  clamped: boolean
}

/**
 * Computes the preview's outline geometry.
 *
 * At `textAlphaPercent === 100` (or undefined) this is exactly the pre-REQ-0311
 * behaviour: `outlinePx = max(thickness * scale, MIN_VISIBLE_OUTLINE_PX)` and
 * `strokeWidth = 2 * outlinePx`.
 */
export function computePreviewOutline({
  outlineThicknessPx,
  scale,
  fontSizeCssPx,
  textAlphaPercent,
}: PreviewOutlineInput): PreviewOutlineResult {
  const raw = outlineThicknessPx * scale
  if (!(raw > 0)) return { outlinePx: 0, strokeWidthPx: 0, clamped: false }

  const outlinePx = Math.max(raw, MIN_VISIBLE_OUTLINE_PX)

  // Fraction of the inner half the fill will paint over.  1 => fully masked,
  // which is the shipping case and must stay untouched.
  const maskedFraction = Math.min(1, Math.max(0, (textAlphaPercent ?? OPACITY_MAX_PERCENT) / OPACITY_MAX_PERCENT))
  const unmasked = 1 - maskedFraction
  if (unmasked <= 0) return { outlinePx, strokeWidthPx: outlinePx * 2, clamped: false }

  const budgetPx = fontSizeCssPx * MAX_INWARD_BLEED_EM
  const visibleInward = outlinePx * unmasked
  if (visibleInward <= budgetPx) {
    return { outlinePx, strokeWidthPx: outlinePx * 2, clamped: false }
  }

  // Shrink only as far as the budget demands, never below the visibility floor.
  const clampedOutline = Math.max(MIN_VISIBLE_OUTLINE_PX, budgetPx / unmasked)
  return {
    outlinePx: Math.min(outlinePx, clampedOutline),
    strokeWidthPx: Math.min(outlinePx, clampedOutline) * 2,
    clamped: clampedOutline < outlinePx,
  }
}
