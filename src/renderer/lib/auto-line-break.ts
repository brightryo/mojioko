import { ASS_MARGIN_LR_PX } from './tokens'
import {
  getSubtitleFont,
  getLibassScale,
  getSubtitleFontFor,
  getLibassScaleFor,
  getCmapCoverageFor,
  getTofuSubstituteFor,
  getActiveFontId,
} from './font-metrics'
import type { SubtitleFont } from './font-metrics'
import type { FontId } from '../../shared/fonts'
import type { EmphasisRange } from '../../shared/emphasis'
// REQ-0456 — the break algorithm moved to `shared/line-break-core.ts` so the
// headless burn/transcribe path produces byte-identical `\N`.  This module is
// now the renderer-side wrapper that resolves font metrics from the renderer's
// `font-metrics` singleton cache and delegates.
import { applyAutoLineBreakCore } from '../../shared/line-break-core'

/**
 * Insert ASS \N line breaks into `text` wherever a line would exceed the
 * effective video width (videoWidthPx − 2×ASS_MARGIN_LR_PX − 2×outlineThicknessPx).
 *
 * Mirrors the glyph-advance logic in overflow-calculator.ts so that break
 * positions match what libass actually renders.  The measurement + break
 * placement (pixel budget → kinsoku → Latin word boundary → emphasis) lives in
 * `shared/line-break-core.ts`; this wrapper only resolves the font metrics from
 * the renderer cache and passes `ASS_MARGIN_LR_PX` as the margin.
 *
 * - Existing \N separators are preserved; each sub-line is processed independently.
 * - Recursive: a single line that needs more than one break is handled correctly.
 * - Falls back to character-class width estimates when the font is not loaded.
 * - REQ-0303 — script-aware break placement.  The pixel budget still decides
 *   *how much* fits on a line, but where that budget lands inside a Latin word
 *   the break is moved back to the preceding word boundary so English words are
 *   never split (`wonder` → `won` / `der`).  CJK runs have no whitespace, so
 *   they keep the character-level behaviour byte-for-byte — Japanese-only cues
 *   wrap at exactly the same positions as before REQ-0303.
 *
 * @param text               Raw subtitle text (may already contain \N).
 * @param fontSizePx         Subtitle font size in pixels.
 * @param outlineThicknessPx Subtitle outline thickness in pixels (0–OUTLINE_THICKNESS_MAX_PX).
 * @param videoWidthPx       Source video width in pixels.
 * @param font               Optional pre-loaded SubtitleFont; uses module cache if omitted.
 *                           Ignored when `fontId` is supplied.
 * @param fontId             Per-row font override (REQ-021).  When set, the
 *                           per-font cache is consulted for both the Font
 *                           reference and the libassScale, matching what
 *                           libass will actually render for that row.
 * @returns                  Text with \N inserted at overflow boundaries.
 */
export function applyAutoLineBreak(
  text: string,
  fontSizePx: number,
  outlineThicknessPx: number,
  videoWidthPx: number,
  font?: SubtitleFont | null,
  fontId?: FontId,
  // REQ-0306 §2 / REQ-0307 — when the cue has keyword emphasis, the emphasised
  // glyphs are physically larger, so the break finder must measure them at
  // `scale` to wrap correctly.  `ranges` are the caller's already-resolved
  // emphasis ranges in ORIGINAL-`text` coordinates.  Omitted / empty ⇒
  // pre-REQ-0306 behaviour, byte-identical.
  emphasis?: { ranges: readonly EmphasisRange[]; scale: number }
): string {
  const f = fontId !== undefined
    ? getSubtitleFontFor(fontId)
    : (font !== undefined ? font : getSubtitleFont())
  const libassScale = fontId !== undefined ? getLibassScaleFor(fontId) : getLibassScale()
  // REQ-0160 — resolve the tofu substitute + cmap for the effective font so the
  // break-finder mirrors the per-character advance substitution in
  // `overflow-calculator.ts`.
  const effectiveFontId = fontId ?? getActiveFontId()
  const cmap = getCmapCoverageFor(effectiveFontId)
  const tofu = getTofuSubstituteFor(effectiveFontId)

  return applyAutoLineBreakCore(
    text,
    fontSizePx,
    outlineThicknessPx,
    videoWidthPx,
    ASS_MARGIN_LR_PX,
    { font: f, libassScale, cmap, tofu },
    emphasis,
  )
}
