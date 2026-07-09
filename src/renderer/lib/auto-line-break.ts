import { ASS_MARGIN_LR_PX } from './tokens'
import {
  getSubtitleFont,
  getLibassScale,
  getSubtitleFontFor,
  getLibassScaleFor,
  getCmapCoverageFor,
  getTofuSubstituteFor,
  getActiveFontId,
  FALLBACK_LIBASS_SCALE
} from './font-metrics'
import type { SubtitleFont } from './font-metrics'
import type { FontId } from '../../shared/fonts'

/**
 * Insert ASS \N line breaks into `text` wherever a line would exceed the
 * effective video width (videoWidthPx − 2×ASS_MARGIN_LR_PX − 2×outlineThicknessPx).
 *
 * Mirrors the glyph-advance logic in overflow-calculator.ts so that break
 * positions match what libass actually renders.
 *
 * - Existing \N separators are preserved; each sub-line is processed independently.
 * - Recursive: a single line that needs more than one break is handled correctly.
 * - Falls back to character-class width estimates when the font is not loaded.
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
  fontId?: FontId
): string {
  const f = fontId !== undefined
    ? getSubtitleFontFor(fontId)
    : (font !== undefined ? font : getSubtitleFont())
  const libassScale = fontId !== undefined ? getLibassScaleFor(fontId) : getLibassScale()
  const effectivePx = videoWidthPx - 2 * ASS_MARGIN_LR_PX - 2 * outlineThicknessPx
  if (effectivePx <= 0) return text
  // REQ-0160 — resolve the tofu substitute for the effective font.  The
  // break-finder uses these to mirror the per-character advance
  // substitution in `overflow-calculator.ts` so break positions land
  // where libass will actually render the tofu-substituted text.
  const effectiveFontId = fontId ?? getActiveFontId()
  const cmap = getCmapCoverageFor(effectiveFontId)
  const tofu = getTofuSubstituteFor(effectiveFontId)

  // Process each existing \N-separated segment independently,
  // then rejoin — preserves intentional manual breaks already in the text.
  return text
    .split('\\N')
    .map((seg) => breakSegment(seg, fontSizePx, effectivePx, f, libassScale, cmap, tofu))
    .join('\\N')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recursively insert \N into a single segment (no existing \N) until every
 * resulting sub-line fits within `effectivePx`.
 */
function breakSegment(
  seg: string,
  fontSizePx: number,
  effectivePx: number,
  font: SubtitleFont | null,
  libassScale: number,
  cmap: Set<number> | null,
  tofu: string | null,
): string {
  if (!seg) return seg

  const breakPos = findBreakIndex(seg, fontSizePx, effectivePx, font, libassScale, cmap, tofu)
  if (breakPos === -1) return seg  // entire segment fits

  const left  = seg.slice(0, breakPos)
  const right = seg.slice(breakPos)
  return left + '\\N' + breakSegment(right, fontSizePx, effectivePx, font, libassScale, cmap, tofu)
}

/**
 * Return the code-unit index of the first character that pushes cumulative
 * advance width over `effectivePx`, or -1 if the whole segment fits.
 *
 * Matches the glyph loop in computeOverflowSync() exactly:
 *   scale = fontSizePx / unitsPerEm × libassScale
 *   cumulative += advance[gi]
 *   if (cumulative > effectivePx) → overflow starts at byteOffset
 *   cumulative += kerning[gi, gi+1]
 *   byteOffset += codePoint[gi].length
 */
function findBreakIndex(
  seg: string,
  fontSizePx: number,
  effectivePx: number,
  font: SubtitleFont | null,
  libassScale: number,
  cmap: Set<number> | null,
  tofu: string | null,
): number {
  if (font) {
    const scale      = (fontSizePx / font.unitsPerEm) * libassScale
    // REQ-0160 — pre-fetch the tofu character's advance so per-character
    // substitution stays a single Set.has() branch inside the hot loop.
    // Null when the font isn't cached yet (fall through to raw
    // `stringToGlyphs` behaviour, matching overflow-calculator's contract).
    const tofuAdvance = cmap !== null && tofu !== null
      ? (font.charToGlyph(tofu).advanceWidth ?? 0)
      : null
    const codePoints = [...seg]
    let cumulative   = 0
    let byteOffset   = 0

    for (let gi = 0; gi < codePoints.length; gi++) {
      const ch = codePoints[gi]
      const cp = ch.codePointAt(0)!
      // REQ-0160 — same per-character substitution as `overflow-calculator.ts`.
      // A code point outside the font's cmap gets the tofu character's
      // advance so the break decision matches what libass will render.
      // Iterates the ORIGINAL string, so `byteOffset` remains a valid
      // slice offset even when the segment contains supplementary-plane
      // code points (surrogate pairs); the substitution never mutates
      // the text itself, only the per-character advance fed into
      // `cumulative`.
      let advance: number
      if (tofuAdvance !== null && cmap !== null && !cmap.has(cp)) {
        advance = tofuAdvance
      } else {
        advance = font.charToGlyph(ch).advanceWidth ?? 0
      }
      cumulative += advance * scale

      if (cumulative > effectivePx) {
        return byteOffset  // break BEFORE this glyph
      }

      if (gi + 1 < codePoints.length) {
        const nextCh = codePoints[gi + 1]
        const nextCp = nextCh.codePointAt(0)!
        // Skip kerning across a tofu boundary so the substituted glyph's
        // (undefined) kerning tables don't contaminate the advance.
        const bothInCmap = cmap === null || (cmap.has(cp) && cmap.has(nextCp))
        if (bothInCmap) {
          cumulative += font.getKerningValue(font.charToGlyph(ch), font.charToGlyph(nextCh)) * scale
        }
      }

      byteOffset += ch.length
    }
  } else {
    // Fallback: wide / narrow character-class estimates when the per-row font
    // is not yet in the opentype.js cache.  REQ-087 — apply
    // FALLBACK_LIBASS_SCALE so this fallback lands within ~1 % of the real
    // per-glyph measurement for every Google Fonts CJK family in the
    // registry (they all share `unitsPerEm / winHeight ≈ 0.6906`).  Without
    // it, the fallback overestimated wide chars by ~45 % and broke far
    // earlier than the burn-in would render — e.g. splitting the
    // sutegana cluster "しゃ" between "し" and "ゃ".  Mirror of the same
    // change in `overflow-calculator.ts`.
    let cumulative = 0
    let i          = 0
    for (const char of seg) {
      const cp        = seg.codePointAt(i) ?? 0
      const charWidth = isWideCp(cp)
        ? fontSizePx * FALLBACK_LIBASS_SCALE
        : fontSizePx * 0.55 * FALLBACK_LIBASS_SCALE
      cumulative += charWidth
      if (cumulative > effectivePx) {
        return i  // break BEFORE this character
      }
      i += char.length
    }
  }
  return -1  // whole segment fits
}

/** Mirror of isWide() in overflow-calculator.ts. */
function isWideCp(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33bf) ||
    (cp >= 0x33ff && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b0ff) ||
    (cp >= 0x1f004 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
}
