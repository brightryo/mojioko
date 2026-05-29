import { parse } from 'opentype.js'
import type { Font } from 'opentype.js'

export type SubtitleFont = Font

/**
 * Font URL must be **relative** ('./fonts/...'), not absolute ('/fonts/...').
 *
 * - Dev (Vite publicDir = `resources/`): both `./fonts/...` and `/fonts/...`
 *   resolve to `http://localhost:5174/fonts/...` and Vite serves the file.
 * - Packaged (renderer is loaded from `file:///.../app.asar/out/renderer/`):
 *   `/fonts/...` resolves to the FILE SYSTEM ROOT (`file:///fonts/...`), which
 *   does not exist → fetch fails → libassScale stays at the fallback → preview
 *   text size diverges from the burned-in output.  Vite copies publicDir into
 *   `out/renderer/fonts/...`, so the relative URL resolves correctly inside
 *   the asar.
 *
 * Vite auto-rewrites `url('/fonts/...')` in CSS to a relative path during the
 * build, which is why `@font-face` still works in packaged mode — but it does
 * NOT rewrite string literals in JS, so this fetch path has to be relative on
 * the source side.
 */
const FONT_URL = './fonts/Noto_Sans_JP/static/NotoSansJP-SemiBold.ttf'

/**
 * libassScale used until (and as a safety net when) the OS/2 table is parsed.
 * Value is `unitsPerEm / (usWinAscent + usWinDescent)` for NotoSansJP-SemiBold:
 *   1000 / (1160 + 288) = 1000 / 1448 ≈ 0.6906
 * With this constant as the initial value, the preview matches the libass
 * output proportions even on the very first frame and on the failure path.
 */
const FALLBACK_LIBASS_SCALE = 0.6906

let fontCache: Font | null = null
let loadPromise: Promise<Font> | null = null

/**
 * libass scales glyphs relative to OS/2 winHeight (usWinAscent + usWinDescent)
 * rather than unitsPerEm.  This module-level variable is computed from the
 * loaded font's OS/2 table and applied in all width calculations so that
 * Step 2 overflow detection matches the physical pixel widths rendered by
 * libass + HarfBuzz in the output video.
 */
let libassScale = FALLBACK_LIBASS_SCALE

export async function loadSubtitleFont(): Promise<Font> {
  if (fontCache) return fontCache
  if (loadPromise) return loadPromise
  loadPromise = fetch(FONT_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${FONT_URL}`)
      return r.arrayBuffer()
    })
    .then((buf) => {
      fontCache = parse(buf)

      // Derive libass-compatible scale from the OS/2 table.
      // libass uses winHeight = usWinAscent + usWinDescent as its EM divisor,
      // making each rendered glyph narrower than a pure unitsPerEm calculation.
      const os2 = fontCache.tables.os2
      const usWinAscent: number = os2.usWinAscent
      const usWinDescent: number = os2.usWinDescent
      const winHeight = usWinAscent + usWinDescent
      libassScale = fontCache.unitsPerEm / winHeight

      // Production-visible startup log so packaged installs can be diagnosed
      // without a dev build.  One line per app launch.
      console.info(
        `[font-metrics] subtitle font loaded — libassScale=${libassScale.toFixed(4)} (unitsPerEm=${fontCache.unitsPerEm}, winHeight=${winHeight})`
      )

      // Verbose calibration sample — dev only.
      if (import.meta.env.DEV) {
        const sampleGlyph = fontCache.charToGlyph('あ')
        const rawWidthPx = ((sampleGlyph.advanceWidth ?? 0) / fontCache.unitsPerEm) * 100
        const libassWidthPx = rawWidthPx * libassScale
        console.debug('[font-metrics] OS/2 calibration:', {
          unitsPerEm: fontCache.unitsPerEm,
          usWinAscent,
          usWinDescent,
          winHeight,
          libassScale: +libassScale.toFixed(4),
          '「あ」 raw 100px': +rawWidthPx.toFixed(2) + 'px',
          '「あ」 libass 100px': +libassWidthPx.toFixed(2) + 'px',
          '25chars libass': +(libassWidthPx * 25).toFixed(1) + 'px',
          'effectivePx (1920,bord3)': 1920 - 20 - 6,
          'charsFit (1920,bord3)': +((1920 - 20 - 6) / libassWidthPx).toFixed(2),
        })
      }

      return fontCache
    })
    .catch((err) => {
      // Loud production log so a broken bundle is diagnosable from DevTools.
      // libassScale already holds the NotoSansJP-SemiBold fallback (0.6906),
      // so preview proportions remain correct on the failure path.
      console.error(
        `[font-metrics] subtitle font load failed at ${FONT_URL} — using fallback libassScale=${FALLBACK_LIBASS_SCALE}`,
        err
      )
      // Reset loadPromise so a later call can retry (e.g., after the network
      // problem is resolved or a route change re-mounts the consumer).
      loadPromise = null
      throw err
    })
  return loadPromise
}

export function getSubtitleFont(): Font | null {
  return fontCache
}

/**
 * libass-compatible scale factor = unitsPerEm / (usWinAscent + usWinDescent).
 * Returns 1.0 if the font has not yet been loaded.
 */
export function getLibassScale(): number {
  return libassScale
}

/**
 * Raw advance width in pixels for one character (no GPOS kerning, no libassScale).
 * Kept for call sites that need the unscaled opentype.js value.
 */
export function glyphAdvancePx(font: Font, char: string, fontSizePx: number): number {
  const g = font.charToGlyph(char)
  return ((g.advanceWidth ?? 0) / font.unitsPerEm) * fontSizePx
}

/**
 * Kerning-aware, libass-compatible line width in pixels for a single line (no `\n`).
 *
 * Applies `libassScale` (= unitsPerEm / winHeight) so the returned value matches
 * the physical pixel width as rendered by libass + HarfBuzz in the output video.
 *
 * GPOS kerning note: NotoSansJP-SemiBold returns kern = 0 for all CJK / kana
 * pairs (full-em fixed-width cells).  Only Latin pairs have non-zero adjustments.
 * For Japanese-only text the kerning contribution is < 0.2 % of total width; the
 * libassScale correction is the dominant term.
 *
 * @param font        Loaded SubtitleFont (opentype.js Font).
 * @param text        Single line of text — must not contain `\n`.
 * @param fontSizePx  Desired render size in CSS / ASS pixels.
 * @returns           Line width in pixels, libass-equivalent.
 */
export function measureLineWidth(font: Font, text: string, fontSizePx: number): number {
  // fontSizePx / unitsPerEm × libassScale = effective pixels per font unit in libass.
  const scale = (fontSizePx / font.unitsPerEm) * libassScale
  const glyphs = font.stringToGlyphs(text)
  let totalUnits = 0
  for (let i = 0; i < glyphs.length; i++) {
    totalUnits += glyphs[i].advanceWidth ?? 0
    if (i + 1 < glyphs.length) {
      totalUnits += font.getKerningValue(glyphs[i], glyphs[i + 1])
    }
  }
  return totalUnits * scale
}
