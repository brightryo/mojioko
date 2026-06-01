import { ASS_MARGIN_LR_PX } from './tokens'
import {
  getSubtitleFont,
  getLibassScale,
  getSubtitleFontFor,
  getLibassScaleFor
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

  // Process each existing \N-separated segment independently,
  // then rejoin — preserves intentional manual breaks already in the text.
  return text
    .split('\\N')
    .map((seg) => breakSegment(seg, fontSizePx, effectivePx, f, libassScale))
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
  libassScale: number
): string {
  if (!seg) return seg

  const breakPos = findBreakIndex(seg, fontSizePx, effectivePx, font, libassScale)
  if (breakPos === -1) return seg  // entire segment fits

  const left  = seg.slice(0, breakPos)
  const right = seg.slice(breakPos)
  return left + '\\N' + breakSegment(right, fontSizePx, effectivePx, font, libassScale)
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
  libassScale: number
): number {
  if (font) {
    const scale      = (fontSizePx / font.unitsPerEm) * libassScale
    const glyphs     = font.stringToGlyphs(seg)
    const codePoints = [...seg]
    let cumulative   = 0
    let byteOffset   = 0

    for (let gi = 0; gi < glyphs.length; gi++) {
      cumulative += (glyphs[gi].advanceWidth ?? 0) * scale

      if (cumulative > effectivePx) {
        return byteOffset  // break BEFORE this glyph
      }

      if (gi + 1 < glyphs.length) {
        cumulative += font.getKerningValue(glyphs[gi], glyphs[gi + 1]) * scale
      }

      byteOffset += codePoints[gi].length
    }
  } else {
    // Fallback: wide / narrow character-class estimates when the font is not loaded.
    // libassScale is unavailable; widths are approximate (same fallback as overflow-calculator.ts).
    let cumulative = 0
    let i          = 0
    for (const char of seg) {
      const cp        = seg.codePointAt(i) ?? 0
      const charWidth = isWideCp(cp) ? fontSizePx : fontSizePx * 0.55
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
