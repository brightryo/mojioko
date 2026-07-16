import { ASS_MARGIN_LR_PX } from './tokens'
import {
  getSubtitleFont,
  getLibassScale,
  getSubtitleFontFor,
  getLibassScaleFor,
  getCmapCoverageFor,
  getTofuSubstituteFor,
  getActiveFontId,
  FALLBACK_LIBASS_SCALE,
  type SubtitleFont
} from './font-metrics'
import type { FontId } from '../../shared/fonts'

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
  /**
   * Per-row font override (REQ-021).  When defined, the row is measured
   * against this font's glyph advances and libassScale.  When omitted, the
   * module-level active-font cache is used — matching the legacy behaviour.
   */
  fontId?: FontId
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
 *   When `args.fontId` is set, `fontArg` is ignored and the per-font cache is
 *   consulted instead.
 */
export function computeOverflowSync(args: OverflowArgs, fontArg?: SubtitleFont | null): OverflowResult {
  const { text, fontSizePx, outlineThicknessPx, videoWidthPx, fontId } = args
  const usable = videoWidthPx - 2 * ASS_MARGIN_LR_PX
  // No correction factor needed here: measureLineWidth() / the glyph loop
  // already applies libassScale so character widths directly correspond to
  // the physical pixels libass renders.
  const effectivePx = usable - 2 * outlineThicknessPx

  if (effectivePx <= 0) {
    return { overflowStartIndex: 0, measuredPx: 0, effectivePx }
  }

  // Per-row font path (REQ-021): when an explicit fontId is supplied, look
  // up that font's cached Font + libassScale.  This is the only way to get
  // the correct scale for a row whose fontId differs from the active
  // selection — the legacy `getLibassScale()` returns the ACTIVE font's
  // scale regardless of which Font was passed in, which silently mismeasures
  // mixed-font projects.
  const font = fontId !== undefined
    ? getSubtitleFontFor(fontId)
    : (fontArg !== undefined ? fontArg : getSubtitleFont())
  const libassScale = fontId !== undefined ? getLibassScaleFor(fontId) : getLibassScale()
  // Normalise ASS hard-line-break `\N` to real newlines before splitting so
  // that auto-broken text is measured line-by-line instead of as one long run.
  // overflowStartIndex is an index into normalizedText — subtitle-table.tsx
  // applies the same normalisation before slicing, so the indices stay in sync.
  const normalizedText = text.replace(/\\N/g, '\n')
  // REQ-0160 — the glyph loop below measures per-character advance.  When
  // the code point is not in the effective font's cmap we swap in the
  // tofu substitute's advance instead of the font's `.notdef` — that
  // matches what libass will render post-fix (also using the same
  // tofu substitute, injected by `services/burnin.ts`) and stops the
  // 2× width mismatch that produced the auto-line-break failure.
  //
  // Crucially we iterate the ORIGINAL text characters, preserving code
  // unit offsets — the substitution affects only the per-character
  // *advance* fed into `cumulative`, not the string content.  This
  // keeps `overflowStartIndex` a valid slice offset for
  // `subtitle-table.tsx` even when the original text contains
  // supplementary-plane code points (surrogate pairs) that would
  // otherwise shift after substitution.
  //
  // When the font isn't cached yet (`cmap === null`) we fall through to
  // the legacy `.notdef` behaviour — the next `bumpFontCacheVersion`
  // rebuild triggers a correct re-measure.
  const effectiveFontId = fontId ?? getActiveFontId()
  const cmap = getCmapCoverageFor(effectiveFontId)
  const tofu = getTofuSubstituteFor(effectiveFontId)
  const lines = normalizedText.split('\n')
  let charOffset = 0

  for (const line of lines) {
    let cumulative = 0

    if (font) {
      // Libass-compatible path.
      // scale = fontSizePx / unitsPerEm × libassScale
      //       = effective pixels per font unit in libass rendering.
      const scale = (fontSizePx / font.unitsPerEm) * libassScale
      // Pre-compute the tofu character's advance once (all missing
      // glyphs get the same effective width — the substitute's own
      // glyph metrics).  Null when we're falling through the "font
      // not cached" branch, in which case the loop below uses the
      // legacy `stringToGlyphs` result directly.
      const tofuAdvance = cmap !== null && tofu !== null
        ? (font.charToGlyph(tofu).advanceWidth ?? 0)
        : null
      // [...line] iterates by Unicode code point; .length is the code-unit
      // count (1 for BMP, 2 for supplementary), matching string slice offsets.
      const codePoints = [...line]
      let byteOffset = 0

      for (let gi = 0; gi < codePoints.length; gi++) {
        // Per-character advance: substitute the tofu's advance when the
        // code point is not in the font's cmap, else use the character's
        // own glyph advance.  Note we drop the pre-fetched `glyphs`
        // array — using `font.charToGlyph` per code point gives the
        // same result and lets the substitution live inside the loop
        // without a parallel index array.
        const ch = codePoints[gi]
        const cp = ch.codePointAt(0)!
        let advance: number
        if (tofuAdvance !== null && cmap !== null && !cmap.has(cp)) {
          advance = tofuAdvance
        } else {
          advance = font.charToGlyph(ch).advanceWidth ?? 0
        }
        cumulative += advance * scale

        // Overflow check: right edge of this glyph exceeds the budget.
        if (cumulative > effectivePx) {
          return { overflowStartIndex: charOffset + byteOffset, measuredPx: cumulative, effectivePx }
        }

        // Kerning between this glyph and the next — shifts where next char starts.
        // Zero for all CJK/kana pairs in NotoSansJP-SemiBold.  Skip kerning
        // across a tofu boundary since kerning tables are not defined for
        // the substituted glyph's neighbours in practice.
        if (gi + 1 < codePoints.length) {
          const nextCh = codePoints[gi + 1]
          const nextCp = nextCh.codePointAt(0)!
          const bothInCmap = cmap === null || (cmap.has(cp) && cmap.has(nextCp))
          if (bothInCmap) {
            cumulative += font.getKerningValue(font.charToGlyph(ch), font.charToGlyph(nextCh)) * scale
          }
        }

        byteOffset += ch.length
      }
    } else {
      // Fallback: character-class estimates when the per-row font is not yet
      // in the opentype.js cache.  REQ-087 — apply FALLBACK_LIBASS_SCALE so
      // wide chars are estimated as `fontSizePx × ~0.69` (libass-rendered
      // em-pixels) instead of the raw em (= `fontSizePx × 1.0`).  Without
      // this factor the fallback over-counted CJK widths by ~45 % vs the
      // real-font path, producing spurious overflow + early line breaks for
      // every non-default font whose Font hadn't loaded yet.  The constant
      // is the same value every Google Fonts CJK family in the registry
      // computes from its OS/2 table (validated for all 9 entries), so the
      // approximation lands inside ~1 % of the real measurement for any of
      // those fonts.  Half-width punctuation specific to some display
      // faces (e.g. Dela's narrow 「。、) remains a residual diff covered
      // by 案B's per-font cache wakeup.
      let i = 0
      for (const char of line) {
        const cp = line.codePointAt(i) ?? 0
        const charWidth = isWide(cp)
          ? fontSizePx * FALLBACK_LIBASS_SCALE
          : fontSizePx * 0.55 * FALLBACK_LIBASS_SCALE
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
