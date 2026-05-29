import { ASS_MARGIN_LR_PX } from './tokens'
import { getSubtitleFont, getLibassScale, type SubtitleFont } from './font-metrics'

export interface OverflowResult {
  /** -1 if entire text fits; otherwise the code-unit index where overflow begins. */
  overflowStartIndex: number
  /**
   * Measured width of the overflowing line in pixels (libass-compatible when
   * font is loaded: advance widths scaled by libassScale = unitsPerEm / winHeight).
   */
  measuredPx: number
  /**
   * Effective allowed width after margins and outline thickness.
   * = videoWidth − 2×ASS_MARGIN_LR_PX − 2×outlineThickness
   *
   * This matches the physical pixel budget available to libass: the ASS
   * renderer uses the same margin and outline values, so the threshold is
   * directly comparable to the libass-scaled character widths returned by
   * measureLineWidth() / the glyph loop below.
   */
  effectivePx: number
}

export interface OverflowArgs {
  text: string
  fontFamily: string
  fontSizePx: number
  outlineThicknessPx: number
  videoWidthPx: number
}

/**
 * Compute where subtitle text first exceeds the safe video width.
 *
 * When the font is loaded, character widths are calculated as:
 *   advance_units × (fontSizePx / unitsPerEm) × libassScale
 *
 * where libassScale = unitsPerEm / (usWinAscent + usWinDescent).
 * This matches the physical pixel width libass + HarfBuzz renders in the
 * output video (libass scales glyphs against OS/2 winHeight, not unitsPerEm).
 *
 * GPOS kern pairs (getKerningValue) are also accumulated between consecutive
 * glyphs.  For NotoSansJP-SemiBold, all CJK/kana pairs have kern = 0; only
 * Latin pairs produce non-zero adjustments.
 *
 * Each `\n`-delimited line is measured independently.  `overflowStartIndex`
 * is a code-unit offset into the full multi-line text string.
 *
 * Falls back to character-class estimates (wide / narrow) when the font is
 * not yet available.
 *
 * @param fontArg Pass the loaded SubtitleFont to enable accurate glyph metrics.
 *   Omit (or pass undefined) to fall back to the module-level cache.
 */
export function computeOverflowSync(args: OverflowArgs, fontArg?: SubtitleFont | null): OverflowResult {
  const { text, fontSizePx, outlineThicknessPx, videoWidthPx } = args
  const usable = videoWidthPx - 2 * ASS_MARGIN_LR_PX
  // No correction factor needed here: measureLineWidth() / the glyph loop
  // already applies libassScale so character widths directly correspond to
  // the physical pixels libass renders.
  const effectivePx = usable - 2 * outlineThicknessPx

  if (effectivePx <= 0) {
    return { overflowStartIndex: 0, measuredPx: 0, effectivePx }
  }

  const font = fontArg !== undefined ? fontArg : getSubtitleFont()
  // Normalise ASS hard-line-break `\N` to real newlines before splitting so
  // that auto-broken text is measured line-by-line instead of as one long run.
  // overflowStartIndex is an index into normalizedText — subtitle-table.tsx
  // applies the same normalisation before slicing, so the indices stay in sync.
  const normalizedText = text.replace(/\\N/g, '\n')
  const lines = normalizedText.split('\n')
  let charOffset = 0

  for (const line of lines) {
    let cumulative = 0

    if (font) {
      // Libass-compatible path.
      // scale = fontSizePx / unitsPerEm × libassScale
      //       = effective pixels per font unit in libass rendering.
      const scale = (fontSizePx / font.unitsPerEm) * getLibassScale()
      const glyphs = font.stringToGlyphs(line)
      // [...line] iterates by Unicode code point; .length is the code-unit
      // count (1 for BMP, 2 for supplementary), matching string slice offsets.
      const codePoints = [...line]
      let byteOffset = 0

      for (let gi = 0; gi < glyphs.length; gi++) {
        // Add advance for this glyph (right edge before kerning to next).
        cumulative += (glyphs[gi].advanceWidth ?? 0) * scale

        // Overflow check: right edge of this glyph exceeds the budget.
        if (cumulative > effectivePx) {
          return { overflowStartIndex: charOffset + byteOffset, measuredPx: cumulative, effectivePx }
        }

        // Kerning between this glyph and the next — shifts where next char starts.
        // Zero for all CJK/kana pairs in NotoSansJP-SemiBold.
        if (gi + 1 < glyphs.length) {
          cumulative += font.getKerningValue(glyphs[gi], glyphs[gi + 1]) * scale
        }

        byteOffset += codePoints[gi].length
      }
    } else {
      // Fallback: character-class estimates when the font is not yet loaded.
      // libassScale is unavailable here; widths are approximate.
      let i = 0
      for (const char of line) {
        const cp = line.codePointAt(i) ?? 0
        const charWidth = isWide(cp) ? fontSizePx : fontSizePx * 0.55
        cumulative += charWidth
        if (cumulative > effectivePx) {
          return { overflowStartIndex: charOffset + i, measuredPx: cumulative, effectivePx }
        }
        i += char.length
      }
    }

    charOffset += line.length + 1
  }

  return { overflowStartIndex: -1, measuredPx: 0, effectivePx }
}

/** Async wrapper kept for API compatibility; delegates to the sync implementation. */
export async function computeOverflow(args: OverflowArgs): Promise<OverflowResult> {
  return computeOverflowSync(args)
}

/** Returns true for CJK and other "wide" Unicode code points. */
function isWide(cp: number): boolean {
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

export function clearOverflowCache(): void {
  // Phase 5: clear opentype.js font cache here if needed
}
