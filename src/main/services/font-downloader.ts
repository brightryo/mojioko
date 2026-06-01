import { existsSync, readdirSync, statSync, mkdirSync, createWriteStream, unlinkSync, rmSync } from 'fs'
import { join } from 'path'
import {
  FONT_REGISTRY,
  type FontId,
  type FontInfo,
  type FontStatus,
  type FontsState,
  type DownloadFontEvent,
  getFontMeta,
  FONTS_SHARED_OFL_URL
} from '../../shared/fonts'
import { getFontUserDir, getFontResolveDir } from '../lib/paths'
import log from '../lib/logger'

/**
 * Read the on-disk size of a font's directory (sum of .ttf + OFL.txt etc.).
 * Bundled fonts return 0 because they don't count toward user disk usage —
 * they live in the installer payload.
 */
export function checkFontInstalled(fontId: FontId): { installed: boolean; bundled: boolean; sizeBytes: number } {
  const meta = getFontMeta(fontId)
  if (meta.bundled) {
    // Bundled font is "installed" iff the TTF actually exists on disk; it
    // should, but defensively report `false` if the installer payload is
    // damaged so the UI can surface the discrepancy.
    const ttfPath = join(getFontResolveDir(meta), meta.fileName)
    return { installed: existsSync(ttfPath), bundled: true, sizeBytes: 0 }
  }
  const dir = getFontUserDir(fontId)
  if (!existsSync(dir)) return { installed: false, bundled: false, sizeBytes: 0 }
  try {
    let total = 0
    for (const item of readdirSync(dir)) {
      try { total += statSync(join(dir, item)).size } catch { /* ignore */ }
    }
    // Treat empty directory as not installed (e.g. cancelled mid-DL leaving
    // an empty parent behind).
    if (total === 0) return { installed: false, bundled: false, sizeBytes: 0 }
    return { installed: true, bundled: false, sizeBytes: total }
  } catch {
    return { installed: false, bundled: false, sizeBytes: 0 }
  }
}

/**
 * Build the full FontsState snapshot for the renderer.  Pulls the active
 * font ID from the caller (settings) to avoid coupling this module to
 * settings-store.
 */
export function buildFontsState(activeFontId: FontId): FontsState {
  let totalUsedBytes = 0
  const fonts: FontInfo[] = FONT_REGISTRY.map((meta) => {
    const { installed, bundled, sizeBytes } = checkFontInstalled(meta.id)
    totalUsedBytes += sizeBytes
    let status: FontStatus
    if (bundled) status = 'bundled'
    else if (installed) status = 'installed'
    else status = 'not-installed'
    return {
      id: meta.id,
      displayName: meta.displayName,
      status,
      sizeBytes,
      expectedSizeBytes: meta.expectedSizeBytes,
      bundled,
      hasDownloadUrl: meta.downloadUrl !== null
    }
  })
  return { fonts, activeFontId, totalUsedBytes }
}

/**
 * Download a single binary/text URL to `destPath`.  Mirrors the pattern in
 * `model-downloader.ts` but with a Content-Length size verification step
 * added (the C-3 integrity check applied here as well as to model DL).
 *
 * `expectedSize > 0` triggers a ±10 % tolerance check on the received bytes;
 * a `expectedSize` of 0 (e.g. OFL.txt where the exact size is unknown until
 * upload) skips the check but still verifies the byte stream completed.
 */
async function downloadFile(
  url: string,
  destPath: string,
  expectedSize: number,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal
): Promise<number> {
  const resp = await fetch(url, { signal, redirect: 'follow' })

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${new URL(url).pathname.split('/').pop()}`)
  }

  const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10)
  const dest = createWriteStream(destPath)

  let received = 0
  if (!resp.body) throw new Error(`No response body for ${url}`)
  const reader = resp.body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      dest.write(value)
      received += value.length
      if (contentLength > 0) onProgress(received, contentLength)
    }
    await new Promise<void>((res, rej) =>
      dest.end((err: Error | null | undefined) => (err ? rej(err) : res()))
    )
  } catch (err) {
    dest.destroy()
    try { unlinkSync(destPath) } catch { /* ignore */ }
    throw err
  } finally {
    reader.releaseLock()
  }

  // Integrity check — bytes-received vs Content-Length (when supplied) and
  // expected size (when known a priori).  ±10 % tolerance forgives minor
  // server-side compression differences; tighter than that and the file is
  // treated as truncated.
  if (contentLength > 0 && Math.abs(received - contentLength) > contentLength * 0.1) {
    try { unlinkSync(destPath) } catch { /* ignore */ }
    throw new Error(`Truncated download for ${url}: received ${received} / ${contentLength}`)
  }
  if (expectedSize > 0 && Math.abs(received - expectedSize) > expectedSize * 0.1) {
    try { unlinkSync(destPath) } catch { /* ignore */ }
    throw new Error(`Size mismatch for ${url}: received ${received}, expected ~${expectedSize} (±10%)`)
  }

  return received
}

/**
 * Download a font (TTF + sibling OFL.txt) into `%APPDATA%/MOJIOKO/fonts/<id>/`.
 *
 * If the font is bundled, downloading is a no-op completion event.  If the
 * font's downloadUrl is null (defensive — should never happen for non-bundled
 * registry entries), throws so the UI surfaces the misconfiguration loud.
 *
 * Emits {progress, file, fileIndex, totalFiles, percent} events as it goes —
 * the file list is always `[ttf, ofl]` so totalFiles = 2 and fileIndex 0/1.
 */
export async function downloadFont(
  fontId: FontId,
  onEvent: (evt: DownloadFontEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const meta = getFontMeta(fontId)
  if (meta.bundled) {
    onEvent({ event: 'completed' })
    return
  }
  if (meta.downloadUrl === null) {
    throw new Error(`Font ${fontId} has no downloadUrl`)
  }

  const dir = getFontUserDir(fontId)
  mkdirSync(dir, { recursive: true })

  const ttfPath = join(dir, meta.fileName)
  const oflPath = join(dir, 'OFL.txt')
  const oflUrl = meta.oflUrl ?? FONTS_SHARED_OFL_URL

  // Track files so the catch handler can clean up a partial install.
  const written: string[] = []

  try {
    // 1) Font TTF
    log.info(`[font-downloader] DL ${fontId} TTF from ${meta.downloadUrl}`)
    onEvent({ event: 'progress', file: meta.fileName, fileIndex: 0, totalFiles: 2, percent: 0 })
    await downloadFile(
      meta.downloadUrl,
      ttfPath,
      meta.expectedSizeBytes,
      (received, total) => {
        const overallPct = Math.floor(((received / total) / 2) * 100)
        onEvent({ event: 'progress', file: meta.fileName, fileIndex: 0, totalFiles: 2, percent: overallPct })
      },
      signal
    )
    written.push(ttfPath)

    // 2) OFL.txt (small, sibling to the TTF so the renderer can read it
    // without another network round-trip).  We don't enforce a size for OFL
    // because the upstream OFL text length is not pinned in the registry.
    log.info(`[font-downloader] DL ${fontId} OFL from ${oflUrl}`)
    onEvent({ event: 'progress', file: 'OFL.txt', fileIndex: 1, totalFiles: 2, percent: 50 })
    await downloadFile(
      oflUrl,
      oflPath,
      0,
      (received, total) => {
        const overallPct = 50 + Math.floor(((received / total) / 2) * 100)
        onEvent({ event: 'progress', file: 'OFL.txt', fileIndex: 1, totalFiles: 2, percent: overallPct })
      },
      signal
    )
    written.push(oflPath)
  } catch (err) {
    // Clean up any partial files.  Mirrors model-downloader behaviour and
    // avoids leaving "installed but broken" state behind.
    for (const p of written) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
    // Best-effort: also remove an empty per-font directory.
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
    throw err
  }

  onEvent({ event: 'completed' })
}

/**
 * Remove a downloaded font.  No-op (with logged warning) for bundled fonts —
 * the installer payload cannot be touched at runtime.
 */
export function uninstallFont(fontId: FontId): void {
  const meta = getFontMeta(fontId)
  if (meta.bundled) {
    log.warn(`[font-downloader] refusing to uninstall bundled font ${fontId}`)
    return
  }
  const dir = getFontUserDir(fontId)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    log.info(`[font-downloader] uninstalled ${fontId}`)
  }
}
