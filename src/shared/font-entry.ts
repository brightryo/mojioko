/**
 * REQ-0456 — pure font-metrics extraction shared by the renderer's font cache
 * (`renderer/lib/font-metrics.ts`) and the main/headless font loader
 * (`main/services/font-metrics-node.ts`).
 *
 * Parses a TTF/OTF with opentype.js and derives the exact metrics the
 * width/overflow math needs: `libassScale` (unitsPerEm / OS-2 winHeight), the
 * cmap coverage Set (REQ-0160), and the per-font tofu substitute.  Kept free of
 * any renderer (`fetch`, `window`, zustand) or Electron (`app`) dependency so
 * BOTH sides build identical `FontEntry`s from the same bytes — the single
 * source of truth that lets headless auto line-break match the GUI.
 */
import { parse, type Font } from 'opentype.js'
import { pickTofuSubstitute } from './glyph-substitute'

/** libassScale fallback until (and if) the OS/2 table is parsed. See renderer font-metrics.ts. */
export const FALLBACK_LIBASS_SCALE = 0.6906

export interface FontEntry {
  font: Font
  libassScale: number
  unitsPerEm: number
  winHeight: number
  /** REQ-0160 — every Unicode code point declared in the font's cmap. */
  cmapCoverage: Set<number>
  /** REQ-0160 — the tofu substitute character picked for this font. */
  tofuSubstitute: string
}

/**
 * Build a `FontEntry` from raw font bytes.  Identical logic on both sides
 * (renderer `entryFromBytes` delegates here) so a headless burn and the GUI
 * measure widths against the same numbers.
 */
export function buildFontEntry(buf: ArrayBuffer): FontEntry {
  const font = parse(buf)
  const os2 = font.tables.os2
  const winHeight = (os2.usWinAscent ?? 0) + (os2.usWinDescent ?? 0)
  const libassScale = winHeight > 0 ? font.unitsPerEm / winHeight : FALLBACK_LIBASS_SCALE
  // REQ-0160 — build the cmap coverage set once (opentype.js exposes each
  // glyph's reverse-mapped `unicodes`; .notdef has none so it is excluded).
  const cmapCoverage = new Set<number>()
  const numGlyphs = font.numGlyphs
  for (let i = 0; i < numGlyphs; i++) {
    const glyph = font.glyphs.get(i) as { unicodes?: number[] } | undefined
    const unicodes = glyph?.unicodes
    if (!unicodes) continue
    for (const cp of unicodes) cmapCoverage.add(cp)
  }
  const tofuSubstitute = pickTofuSubstitute(cmapCoverage)
  return { font, libassScale, unitsPerEm: font.unitsPerEm, winHeight, cmapCoverage, tofuSubstitute }
}
