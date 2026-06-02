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
    console.info(`[font-registry] bundled ${meta.id} (${meta.cssFontFamily}) — fonts.css covers it`)
    return null
  }

  // Downloaded font — read bytes through the IPC bridge and wrap as a
  // FontFace.  We feed the bytes into a Blob URL rather than an
  // ArrayBuffer directly because:
  //
  //   1. The ArrayBuffer form failed silently in Electron 30 (Chromium 124)
  //      — face.load() resolved but document.fonts.check() returned false,
  //      i.e. the family was never actually usable for CSS rendering even
  //      though the API surface reported success.
  //   2. The URL form goes through Chromium's standard font fetcher which
  //      reliably produces a registered, queryable FontFace.
  //   3. `blob:` is whitelisted in the renderer CSP under both font-src
  //      and img-src so the URL is safe to dereference.
  //
  // The Blob URL is intentionally NOT revoked — Chromium needs it alive for
  // the lifetime of the FontFace (revoking it before face.load() resolves
  // produces a NetworkError; revoking after document.fonts.add() can cause
  // re-layouts to fall back to system fonts).  The leak is bounded by the
  // small number of installed fonts.
  console.info(`[font-registry] loading ${meta.id} (${meta.cssFontFamily}) via IPC + Blob URL`)
  const r = await window.electronAPI.fontReadBytes(meta.id)
  if (!r.ok) {
    console.error(`[font-registry] fontReadBytes !ok for ${meta.id}`, r.error)
    throw new Error(`fontReadBytes failed for ${meta.id}: ${r.error.message}`)
  }
  console.info(`[font-registry] received ${r.data.byteLength} bytes for ${meta.id}`)

  const blob = new Blob([new Uint8Array(r.data)], { type: 'font/ttf' })
  const blobUrl = URL.createObjectURL(blob)
  let face: FontFace
  try {
    face = new FontFace(meta.cssFontFamily, `url(${blobUrl})`, {
      weight: String(meta.weight),
      style: 'normal'
    })
  } catch (err) {
    URL.revokeObjectURL(blobUrl)
    console.error(`[font-registry] new FontFace threw for ${meta.id}`, err)
    throw err
  }
  try {
    await face.load()
  } catch (err) {
    URL.revokeObjectURL(blobUrl)
    console.error(`[font-registry] face.load() rejected for ${meta.id}`, err)
    throw err
  }
  document.fonts.add(face)
  // Diagnostic: confirm the family is now actually queryable via CSS.  In
  // dev this answers "did the registration take?" with a single console
  // line; in production the log is shipped via electron-log so a bug
  // report can include it.
  const check = document.fonts.check(`${meta.weight} 16px "${meta.cssFontFamily}"`)
  console.info(`[font-registry] ✓ ${meta.id} registered (status=${face.status}, document.fonts.check=${check})`)
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
