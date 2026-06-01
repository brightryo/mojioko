import { getFontMeta, type FontId, type FontMeta } from '../../shared/fonts'

/**
 * Runtime font loader for the renderer side.
 *
 * Bundled fonts are already declared via `@font-face` in `styles/fonts.css`
 * (loaded from `resources/fonts/` via Vite publicDir), so this module does
 * nothing for them — `document.fonts` already knows about them.
 *
 * Downloaded fonts live at `%APPDATA%/MOJIOKO/fonts/<id>/<file>.ttf` on disk.
 * The renderer cannot fetch via `file://` because of CSP / origin rules, so
 * they are reached through the custom `mojioko-font://` protocol registered
 * in `main/lib/font-protocol.ts`.  For each downloaded font we construct a
 * `FontFace` object from that URL and add it to `document.fonts` so that any
 * CSS rule referencing `font-family: '<cssFontFamily>'` resolves correctly.
 *
 * The map keys by FontId; once a font is loaded, subsequent calls return the
 * cached promise rather than refetching.  Forced reloads (e.g. after an
 * uninstall+reinstall) are handled by `evict(fontId)`.
 */

type LoadEntry = { promise: Promise<FontFace | null>; face?: FontFace | null }

const cache = new Map<FontId, LoadEntry>()

function fontUrl(fontId: FontId): string {
  // Cache buster appended in dev to force reload across HMR sessions; in prod
  // the protocol handler always returns fresh bytes from disk so a bust is
  // unnecessary but harmless.
  return `mojioko-font://${fontId}/ttf`
}

async function loadOne(meta: FontMeta): Promise<FontFace | null> {
  if (meta.bundled) {
    // Bundled font is registered via fonts.css already.  Wait for the family
    // to actually report ready so callers awaiting this promise can rely on
    // the family being usable for measurement / canvas-draw.
    if ('fonts' in document) {
      try { await document.fonts.load(`${meta.weight} 100px '${meta.cssFontFamily}'`) } catch { /* swallow */ }
    }
    return null
  }

  // Downloaded font — pull bytes via mojioko-font:// and wrap as a FontFace.
  const resp = await fetch(fontUrl(meta.id))
  if (!resp.ok) {
    throw new Error(`Failed to fetch font ${meta.id}: HTTP ${resp.status}`)
  }
  const buf = await resp.arrayBuffer()
  const face = new FontFace(meta.cssFontFamily, buf, {
    weight: String(meta.weight),
    style: 'normal'
  })
  await face.load()
  document.fonts.add(face)
  return face
}

/**
 * Ensure the given font is loaded and registered with the document.
 *
 * Resolves with the FontFace (downloaded fonts) or null (bundled fonts —
 * fonts.css already covers them).  Rejects only when the protocol fetch
 * fails, e.g. the user uninstalled the font before this call.
 */
export function ensureFontLoaded(fontId: FontId): Promise<FontFace | null> {
  const existing = cache.get(fontId)
  if (existing) return existing.promise

  const meta = getFontMeta(fontId)
  const entry: LoadEntry = {
    promise: loadOne(meta)
      .then((face) => {
        entry.face = face
        return face
      })
      .catch((err) => {
        // Drop from cache so the next attempt retries.
        cache.delete(fontId)
        throw err
      })
  }
  cache.set(fontId, entry)
  return entry.promise
}

/**
 * Drop the cached FontFace for `fontId` (e.g. immediately after the user
 * uninstalls it via the picker).  If a FontFace was registered, it is also
 * removed from `document.fonts` so subsequent layout passes fall back to
 * the next available family.
 */
export function evictFont(fontId: FontId): void {
  const entry = cache.get(fontId)
  if (entry?.face) {
    try { document.fonts.delete(entry.face) } catch { /* ignore */ }
  }
  cache.delete(fontId)
}
