import { parse } from 'opentype.js'
import type { Font } from 'opentype.js'
import { DEFAULT_FONT_ID, getFontMeta, type FontId } from '../../shared/fonts'
import { pickTofuSubstitute } from '../../shared/glyph-substitute'
import { ensureFontLoaded } from './font-registry'
import { bumpFontCacheVersion } from '@/stores/font-cache-version-store'

export type SubtitleFont = Font

/**
 * libassScale fallback used until (and as a safety net when) the OS/2 table
 * of the active font has been parsed.
 *
 * Value is `unitsPerEm / (usWinAscent + usWinDescent)` for NotoSansJP-SemiBold:
 *   1000 / (1160 + 288) = 1000 / 1448 ≈ 0.6906
 *
 * Every Google Fonts CJK family validated so far (Noto Sans JP, Dela Gothic
 * One, Reggae One, Yusei Magic, Mochiy Pop One, Hachi Maru Pop, Potta One,
 * DotGothic16, Rampart One — all 9 registry entries) shares the same OS/2
 * metrics and therefore the same scale.  We keep the per-font calculation
 * in place anyway because the registry will eventually add fonts that
 * diverge.
 *
 * REQ-087 — exported so the renderer's `overflow-calculator.ts` and
 * `auto-line-break.ts` can apply this same factor in their character-class
 * fallback branches.  Without the export, those modules used to estimate
 * wide-char widths as `fontSizePx × 1.0` (= per-em) and over-counted by
 * ~45 % vs the real glyph path (= `fontSizePx × libassScale ≈ × 0.69`),
 * producing spurious overflow + early line breaks for every row whose
 * per-row font wasn't cached at calc time.
 */
export const FALLBACK_LIBASS_SCALE = 0.6906

interface FontEntry {
  font: Font
  libassScale: number
  unitsPerEm: number
  winHeight: number
  /**
   * REQ-0160 — Set of every Unicode code point declared in the font's cmap.
   * Built once at load time by walking `font.glyphs.glyphs[*].unicodes`
   * (opentype.js exposes the reverse mapping directly).  Used by
   * `substituteMissingGlyphs` to detect "font has no glyph for this
   * character" without a per-character `charToGlyphIndex` call at
   * render/measure time.
   */
  cmapCoverage: Set<number>
  /**
   * REQ-0160 — the character string used as the "tofu" substitute for
   * this font.  Picked at load time by `pickTofuSubstitute` from an
   * ordered candidate list (U+25A1 preferred, U+003F "?" last resort).
   * Every registered font gets a non-empty pick because they all
   * declare basic ASCII (REQ-0154 verified).
   */
  tofuSubstitute: string
}

const fontCache = new Map<FontId, FontEntry>()
const inFlight = new Map<FontId, Promise<Font>>()

/**
 * The "active" font ID is a module-level variable rather than a parameter
 * to every API call, so legacy no-arg callers (`loadSubtitleFont()`, etc.)
 * keep working without rippling a FontId through every measurement
 * function.  The renderer should call `setActiveSubtitleFont(fontId)` from
 * the settings-store hydration path and again whenever the user changes
 * their selection.
 */
let activeFontId: FontId = DEFAULT_FONT_ID

// ---------------------------------------------------------------------------
// Internal load primitives
// ---------------------------------------------------------------------------

async function fetchFontBytes(fontId: FontId): Promise<ArrayBuffer> {
  const meta = getFontMeta(fontId)
  // Bundled fonts: keep using the relative URL that worked in v1.1.0 so the
  // dev mode (Vite publicDir at `/fonts/...`) and packaged mode (asar's
  // `out/renderer/fonts/...`) both resolve.  This path is 'self' to the
  // renderer's CSP so the fetch is allowed.  Must match the URL in
  // fonts.css `@font-face` declarations.
  if (meta.bundled) {
    const relPath = meta.bundledRelativeDir ?? ''
    const url = `./fonts/${relPath}/${meta.fileName}`.replace(/\/+/g, '/')
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`)
    return resp.arrayBuffer()
  }
  // Downloaded fonts: pull through the IPC bridge.  `fetch('mojioko-font://')`
  // would be blocked by `connect-src 'self'` in the renderer CSP, and
  // Electron also requires `registerSchemesAsPrivileged({ supportFetchAPI:
  // true })` for fetch to reach custom protocols — neither of which we
  // configure.  IPC bypasses both constraints cleanly.
  const r = await window.electronAPI.fontReadBytes(fontId)
  if (!r.ok) throw new Error(`fontReadBytes failed for ${fontId}: ${r.error.message}`)
  return r.data
}

function entryFromBytes(buf: ArrayBuffer): FontEntry {
  const font = parse(buf)
  const os2 = font.tables.os2
  const winHeight = (os2.usWinAscent ?? 0) + (os2.usWinDescent ?? 0)
  const libassScale = winHeight > 0 ? font.unitsPerEm / winHeight : FALLBACK_LIBASS_SCALE
  // REQ-0160 — build the cmap coverage set once per font load.  opentype.js
  // exposes each glyph's `unicodes: number[]` (reverse-mapped from the
  // cmap tables); the .notdef glyph (index 0) never has any so it's
  // naturally excluded, keeping the semantic "code point → has a real
  // glyph" clean.  Uses the public `glyphs.get(i)` API — the internal
  // `glyphs.glyphs` map is `private` in the TS types and would require
  // a cast.  Cost: O(numGlyphs) at load, saves per-character work at
  // every render / measure call.
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

/**
 * Load a specific font.  Cached on success; concurrent calls dedupe via an
 * in-flight promise map.  Failed loads are NOT cached so a later attempt can
 * retry — e.g. after the user finishes downloading the font.
 */
export async function loadSubtitleFontFor(fontId: FontId): Promise<Font> {
  const cached = fontCache.get(fontId)
  if (cached) return cached.font
  const pending = inFlight.get(fontId)
  if (pending) return pending

  const meta = getFontMeta(fontId)
  // Ask the font-registry (CSS side) to load it in parallel so the
  // @font-face is also ready by the time this promise resolves.  Best
  // effort — failures here just mean the preview falls back to the system
  // font; opentype.js parsing is independent.
  void ensureFontLoaded(fontId).catch(() => undefined)

  const promise = (async () => {
    try {
      const buf = await fetchFontBytes(fontId)
      const entry = entryFromBytes(buf)
      fontCache.set(fontId, entry)
      // REQ-087 — notify the React layer that the cache contents changed
      // so any `useMemo` that depends on per-row font metrics
      // (notably `overflowMap` in step2.tsx) re-runs the very next
      // render with the now-cached real glyph metrics instead of the
      // approximate character-class fallback.
      bumpFontCacheVersion()
      // Production-visible log so a packaged install can be diagnosed without
      // a dev build — one line per font load.
      console.info(
        `[font-metrics] loaded ${fontId} (${meta.displayName}) — libassScale=${entry.libassScale.toFixed(4)} (unitsPerEm=${entry.unitsPerEm}, winHeight=${entry.winHeight})`
      )
      return entry.font
    } catch (err) {
      console.error(
        `[font-metrics] load failed for ${fontId} (${meta.displayName}) — using fallback libassScale=${FALLBACK_LIBASS_SCALE}`,
        err
      )
      inFlight.delete(fontId)
      throw err
    }
  })()
  inFlight.set(fontId, promise)
  // Once settled (either way), clear the in-flight entry so retries can run.
  promise.finally(() => { inFlight.delete(fontId) })
  return promise
}

export function getSubtitleFontFor(fontId: FontId): Font | null {
  return fontCache.get(fontId)?.font ?? null
}

export function getLibassScaleFor(fontId: FontId): number {
  return fontCache.get(fontId)?.libassScale ?? FALLBACK_LIBASS_SCALE
}

/**
 * REQ-0160 — cmap coverage Set for a font, or null when the font is not
 * yet in the cache (background load in progress or the download hasn't
 * completed).  Callers must treat null as "cannot detect missing
 * glyphs yet"; the safe fallback is to skip substitution and let libass
 * do whatever fallback it normally does.  Once the font finishes loading,
 * `bumpFontCacheVersion` triggers the React memo layer to re-run.
 */
export function getCmapCoverageFor(fontId: FontId): Set<number> | null {
  return fontCache.get(fontId)?.cmapCoverage ?? null
}

/**
 * REQ-0160 — tofu substitute character for a font, or null when the
 * font isn't cached yet.  Same "cannot substitute yet" semantics as
 * `getCmapCoverageFor` — the caller side treats null as skip.
 */
export function getTofuSubstituteFor(fontId: FontId): string | null {
  return fontCache.get(fontId)?.tofuSubstitute ?? null
}

/**
 * Drop the cached font entry — call after uninstall so reading the same
 * font ID later triggers a fresh load (which will fail until the user
 * re-downloads).
 */
export function evictSubtitleFont(fontId: FontId): void {
  fontCache.delete(fontId)
}

// ---------------------------------------------------------------------------
// Active-font API (back-compat for existing callers)
// ---------------------------------------------------------------------------

/**
 * Set the active font.  Triggers a load if not already cached.  Returns the
 * loaded font, or null on failure (caller can fall through to fallback
 * measurement constants).
 */
export async function setActiveSubtitleFont(fontId: FontId): Promise<Font | null> {
  activeFontId = fontId
  try {
    return await loadSubtitleFontFor(fontId)
  } catch {
    return null
  }
}

/** Return the active font's ID — useful for legacy paths that want to know. */
export function getActiveFontId(): FontId {
  return activeFontId
}

/**
 * Backwards-compatible no-arg loader.  Targets the currently-active font.
 * New code should prefer `loadSubtitleFontFor(fontId)`.
 */
export async function loadSubtitleFont(): Promise<Font> {
  return loadSubtitleFontFor(activeFontId)
}

export function getSubtitleFont(): Font | null {
  return getSubtitleFontFor(activeFontId)
}

export function getLibassScale(): number {
  return getLibassScaleFor(activeFontId)
}

// ---------------------------------------------------------------------------
// Measurement helpers (unchanged signatures — callers already pass the Font)
// ---------------------------------------------------------------------------

/**
 * Raw advance width in pixels for one character (no GPOS kerning, no libassScale).
 * Kept for call sites that need the unscaled opentype.js value.
 */
export function glyphAdvancePx(font: Font, char: string, fontSizePx: number): number {
  const g = font.charToGlyph(char)
  return ((g.advanceWidth ?? 0) / font.unitsPerEm) * fontSizePx
}

/**
 * Kerning-aware, libass-compatible line width in pixels for a single line.
 *
 * The libassScale is looked up against the active font when called as
 * `measureLineWidth(font, text, size)` with the active font — but because
 * the function takes a Font argument that may belong to any font, we look
 * the scale up via the cache by identity-matching the cached entries.
 * In practice the active path covers >99 % of calls and the per-font
 * variant matches by reverse lookup; a stale Font (font ID evicted while
 * still referenced) gracefully falls back to FALLBACK_LIBASS_SCALE.
 */
export function measureLineWidth(font: Font, text: string, fontSizePx: number): number {
  let libassScale = FALLBACK_LIBASS_SCALE
  for (const entry of fontCache.values()) {
    if (entry.font === font) { libassScale = entry.libassScale; break }
  }
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
