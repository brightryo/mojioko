import { getFontMeta, type FontId, type FontMeta } from '../../shared/fonts'

/**
 * Runtime font loader for the renderer side.
 *
 * Bundled fonts are already declared via `@font-face` in `styles/fonts.css`
 * (loaded from `resources/fonts/` via Vite publicDir), so this module does
 * nothing for them — `document.fonts` already knows about them.
 *
 * Downloaded fonts live at `%APPDATA%/MOJIOKO/fonts/<id>/<file>.ttf` on disk.
 * Bytes are fetched over IPC (`fontReadBytes`) and wrapped as a `FontFace`
 * constructed from the resulting `ArrayBuffer`.  This deliberately avoids
 * `fetch('mojioko-font://...')` because the renderer's strict CSP
 * (`connect-src 'self'`) blocks custom protocols on the fetch path — and
 * because Electron requires `registerSchemesAsPrivileged({ supportFetchAPI:
 * true })` to enable that scheme for fetch, which we do not currently set.
 *
 * The map keys by FontId; once a font is loaded, subsequent calls return the
 * cached promise rather than refetching.  Forced reloads (e.g. after an
 * uninstall+reinstall) are handled by `evictFont(fontId)`.
 */

type LoadEntry = { promise: Promise<FontFace | null>; face?: FontFace | null }

const cache = new Map<FontId, LoadEntry>()

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

  // Downloaded font — read bytes through the IPC bridge (CSP-friendly) and
  // wrap as a FontFace.  ArrayBuffer-sourced FontFaces bypass CSP font-src
  // entirely, so we only need connect-src 'self' for the IPC channel itself
  // (which the renderer's preload contract already satisfies).
  const r = await window.electronAPI.fontReadBytes(meta.id)
  if (!r.ok) {
    throw new Error(`fontReadBytes failed for ${meta.id}: ${r.error.message}`)
  }
  const face = new FontFace(meta.cssFontFamily, r.data, {
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
