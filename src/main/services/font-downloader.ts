import { existsSync, readdirSync, statSync, mkdirSync, createWriteStream, unlinkSync, rmSync } from 'fs'
import { join } from 'path'
import {
  FONT_REGISTRY,
  FONT_SET_VERSION,
  deriveFontStatus,
  type FontId,
  type FontInfo,
  type FontsState,
  type DownloadFontEvent,
  getFontMeta
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
 *
 * REQ-0275 §3 — `recordedSetVersion` is the value the caller loaded from
 * `settings.json` (`fontSetInstalledVersion`).  When it does NOT match
 * the current `FONT_SET_VERSION`, every non-bundled font on disk is
 * reported as `not-installed` even if its bytes exist.  This is the
 * safeguard against a v1.3.5 user's `fonts-v1` files being picked up
 * with the wrong upstream family name after the v1.3.6 rename:
 * detecting the stale set forces a re-download of the MOJIOKO-
 * namespaced replacements, avoiding the silent preview↔burn-in
 * divergence RES-0274 documented.  Bundled fonts are never affected
 * (they ship with the installer and are always in sync).
 *
 * REQ-0276 §3 — `recordedSetVersion` is also echoed back in the returned
 * `FontsState.fontSetInstalledVersion` so the renderer can distinguish
 * "brand-new install (unset)" from "outdated (recorded but < current)"
 * for the upgrade-notice banner.
 */
export function buildFontsState(activeFontId: FontId, recordedSetVersion?: number): FontsState {
  const setIsCurrent = recordedSetVersion === FONT_SET_VERSION
  let totalUsedBytes = 0
  const fonts: FontInfo[] = FONT_REGISTRY.map((meta) => {
    const { installed, bundled, sizeBytes } = checkFontInstalled(meta.id)
    totalUsedBytes += sizeBytes
    return {
      id: meta.id,
      displayName: meta.displayName,
      status: deriveFontStatus(bundled, installed, setIsCurrent),
      sizeBytes,
      expectedSizeBytes: meta.expectedSizeBytes,
      bundled,
      hasDownloadUrl: meta.downloadUrl !== null
    }
  })
  return { fonts, activeFontId, totalUsedBytes, fontSetInstalledVersion: recordedSetVersion }
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
  if (meta.oflUrl === null) {
    // Defensive: every non-bundled registry entry should have an oflUrl
    // (the per-font `<FontName>-OFL.txt` asset).  Throw rather than silently
    // skip the OFL — running without the license breaks SIL OFL §2.
    throw new Error(`Font ${fontId} has no oflUrl`)
  }
  const oflUrl = meta.oflUrl

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

/**
 * REQ-0281 §4 — sweep every downloaded non-bundled font off disk.
 *
 * Called from two paths:
 *  1. Batch-DL cancel / failure — REQ-0281 §4-3 says a partial batch must
 *     leave zero downloaded files behind, so the next batch always starts
 *     from the clean slate.  Combined with the caller clearing
 *     `fontSetInstalledVersion` back to `undefined`, this pins the binary
 *     state at 0 (`not-installed`).
 *  2. The "Uninstall all additional fonts" button on the FontPicker
 *     (REQ-0281 §4-5, owner-approved: individual per-row trash was
 *     replaced by a single set-wide operation because per-row deletion
 *     contradicts the binary state model).
 *
 * Bundled Noto weights are never touched — their TTFs live in the
 * installer payload (`resources/fonts/Noto_Sans_JP/static/`) which
 * this process has no business modifying at runtime.
 *
 * Returns the list of fontIds that were actually removed (empty when
 * the disk was already clean) so callers can log or toast a count.
 */
export function uninstallAllDownloaded(): FontId[] {
  const removed: FontId[] = []
  for (const meta of FONT_REGISTRY) {
    if (meta.bundled) continue
    const dir = getFontUserDir(meta.id)
    if (!existsSync(dir)) continue
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(meta.id)
    } catch (err) {
      log.warn(`[font-downloader] uninstallAllDownloaded: failed to remove ${meta.id}: ${(err as Error).message}`)
      // Continue with the rest — one failure shouldn't strand the others.
    }
  }
  if (removed.length > 0) {
    log.info(`[font-downloader] uninstallAllDownloaded removed ${removed.length} font(s): ${removed.join(', ')}`)
  }
  return removed
}
