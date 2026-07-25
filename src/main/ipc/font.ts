import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { Channels } from '../../shared/ipc-channels'
import {
  isFontId,
  getFontMeta,
  DEFAULT_FONT_ID,
  FONT_SET_VERSION,
  type FontId,
  type FontsState
} from '../../shared/fonts'
import {
  buildFontsState,
  downloadFont,
  uninstallFont as removeFontDir,
  uninstallAllDownloaded,
} from '../services/font-downloader'
import { downloadManager, type DownloadToken } from '../services/download-manager'
import { getFontUserDir, getFontResolveDir, getBundledOflPath } from '../lib/paths'
import { loadSettings, saveSettings } from '../services/settings-store'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

function assertValidFontId(value: unknown): asserts value is FontId {
  if (!isFontId(value)) throw new Error(`Invalid fontId: ${String(value)}`)
}

export function registerFontHandlers(): void {
  // REQ-0241 — DownloadManager-issued tokens keyed by per-run channelId.
  const activeDownloads = new Map<string, DownloadToken>()

  ipcMain.handle(Channels.fontList, async (): Promise<OkResult<FontsState> | ErrResult> => {
    try {
      const settings = await loadSettings()
      const active = settings.activeFontId && isFontId(settings.activeFontId)
        ? settings.activeFontId
        : DEFAULT_FONT_ID
      return { ok: true, data: buildFontsState(active, settings.fontSetInstalledVersion) }
    } catch (err) {
      log.error('[ipc/font] list error', err)
      return { ok: false, error: { code: 'FONT_LIST_ERROR', message: (err as Error).message } }
    }
  })

  // REQ-0275 §3 — persist the current FONT_SET_VERSION after a successful
  // bulk download.  Renderer calls this once all fonts in the batch have
  // landed on disk; the next fontList call will then treat them as
  // `installed`.  Idempotent: writing the same value repeatedly is a no-op.
  ipcMain.handle(`${Channels.fontList}:recordSetVersion`, async (): Promise<OkResult<{ version: number }> | ErrResult> => {
    try {
      const settings = await loadSettings()
      settings.fontSetInstalledVersion = FONT_SET_VERSION
      await saveSettings(settings)
      log.info(`[ipc/font] recorded fontSetInstalledVersion=${FONT_SET_VERSION}`)
      return { ok: true, data: { version: FONT_SET_VERSION } }
    } catch (err) {
      log.error('[ipc/font] recordSetVersion error', err)
      return { ok: false, error: { code: 'FONT_SET_VERSION_RECORD_ERROR', message: (err as Error).message } }
    }
  })

  ipcMain.handle(Channels.fontDownload, async (event, fontId: string): Promise<OkResult<{ channelId: string }> | ErrResult> => {
    try { assertValidFontId(fontId) } catch (err) {
      return { ok: false, error: { code: 'INVALID_FONT_ID', message: (err as Error).message } }
    }
    // REQ-0244 — per-font-key acquire.  The font-picker's batch DL
    // loop iterates sequentially over fonts, so within a batch each
    // per-font call takes and releases 'font:<id>' cleanly.  Other
    // kinds (model / GPU) run fully in parallel.  Same-font-id
    // duplicate rejection is a safety net for double-clicks.
    const acquired = downloadManager.acquire('font', fontId, fontId)
    if ('busy' in acquired) {
      return {
        ok: false,
        error: {
          code: 'DOWNLOAD_BUSY',
          message: `Download already in progress for font ${acquired.existing.targetId}`,
        },
      }
    }
    const token = acquired
    const channelId = `font:download:${randomUUID()}`
    activeDownloads.set(channelId, token)

    log.info(`[ipc/font] download ${fontId} channelId=${channelId}`)

    downloadFont(fontId, (evt) => {
      if (!event.sender.isDestroyed()) event.sender.send(channelId, evt)
    }, token.signal).catch((err) => {
      log.error('[ipc/font] download error', err)
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, { event: 'failed', error: String(err instanceof Error ? err.message : err) })
      }
    }).finally(() => {
      token.release()
      activeDownloads.delete(channelId)
    })

    return { ok: true, data: { channelId } }
  })

  ipcMain.handle(`${Channels.fontDownload}:cancel`, (_event, channelId: string): void => {
    activeDownloads.get(channelId)?.cancel()
    activeDownloads.delete(channelId)
  })

  // REQ-0281 §4 — "Uninstall all additional fonts" + batch-DL cancel cleanup.
  // Deletes every non-bundled font directory AND clears
  // `fontSetInstalledVersion` so the next `fontList` reports the whole
  // set as `not-installed` (binary state model).  If the active font was
  // a downloaded weight, it falls back to `DEFAULT_FONT_ID` — same
  // policy as the per-font uninstall handler below.
  ipcMain.handle(Channels.fontUninstallAll, async (): Promise<OkResult<FontsState & { removedIds: FontId[] }> | ErrResult> => {
    try {
      const removed = uninstallAllDownloaded()
      const settings = await loadSettings()
      // Clear the version stamp so the binary state pins to 0.  Even if
      // `removed` was empty (disk already clean), we still reset here so
      // callers can use this handler idempotently as "make sure we're at 0".
      settings.fontSetInstalledVersion = undefined
      // If the active font was one of the removed weights, fall back to
      // the bundled default so no orphaned selection survives.
      const activeStillOk =
        settings.activeFontId
        && isFontId(settings.activeFontId)
        && !removed.includes(settings.activeFontId as FontId)
      if (!activeStillOk) {
        settings.activeFontId = DEFAULT_FONT_ID
      }
      await saveSettings(settings)
      const active = settings.activeFontId as FontId
      const state = buildFontsState(active, settings.fontSetInstalledVersion)
      log.info(`[ipc/font] uninstallAll removed ${removed.length} font(s); fontSetInstalledVersion cleared`)
      return { ok: true, data: { ...state, removedIds: removed } }
    } catch (err) {
      log.error('[ipc/font] uninstallAll error', err)
      return { ok: false, error: { code: 'FONT_UNINSTALL_ALL_ERROR', message: (err as Error).message } }
    }
  })

  ipcMain.handle(Channels.fontUninstall, async (_event, fontId: string): Promise<OkResult<FontsState> | ErrResult> => {
    try { assertValidFontId(fontId) } catch (err) {
      return { ok: false, error: { code: 'INVALID_FONT_ID', message: (err as Error).message } }
    }
    try {
      const meta = getFontMeta(fontId)
      if (meta.bundled) {
        return { ok: false, error: { code: 'CANNOT_UNINSTALL_BUNDLED', message: `Cannot uninstall bundled font ${fontId}` } }
      }
      removeFontDir(fontId)

      // If the uninstalled font was active, fall back to the default.
      const settings = await loadSettings()
      if (settings.activeFontId === fontId) {
        settings.activeFontId = DEFAULT_FONT_ID
        await saveSettings(settings)
      }
      const refreshed = await loadSettings()
      const active = refreshed.activeFontId && isFontId(refreshed.activeFontId)
        ? refreshed.activeFontId
        : DEFAULT_FONT_ID
      return { ok: true, data: buildFontsState(active, refreshed.fontSetInstalledVersion) }
    } catch (err) {
      log.error('[ipc/font] uninstall error', err)
      return { ok: false, error: { code: 'FONT_UNINSTALL_ERROR', message: (err as Error).message } }
    }
  })

  ipcMain.handle(Channels.fontSetActive, async (_event, fontId: string): Promise<OkResult<FontsState> | ErrResult> => {
    try { assertValidFontId(fontId) } catch (err) {
      return { ok: false, error: { code: 'INVALID_FONT_ID', message: (err as Error).message } }
    }
    try {
      const settings = await loadSettings()
      settings.activeFontId = fontId
      await saveSettings(settings)
      log.info(`[ipc/font] setActive → ${fontId}`)
      return { ok: true, data: buildFontsState(fontId, settings.fontSetInstalledVersion) }
    } catch (err) {
      log.error('[ipc/font] setActive error', err)
      return { ok: false, error: { code: 'FONT_SET_ACTIVE_ERROR', message: (err as Error).message } }
    }
  })

  ipcMain.handle(Channels.fontReadOfl, async (_event, fontId: string): Promise<OkResult<string> | ErrResult> => {
    try { assertValidFontId(fontId) } catch (err) {
      return { ok: false, error: { code: 'INVALID_FONT_ID', message: (err as Error).message } }
    }
    try {
      const meta = getFontMeta(fontId)
      // Pick the OFL location based on whether the font is bundled or
      // user-downloaded.  Both branches return the file contents verbatim:
      // each shipped OFL.txt already begins with that font's copyright
      // header (the SIL OFL §2 "above copyright notice"), so we do NOT
      // prepend `meta.copyright` here — that would duplicate the line.
      const oflPath = meta.bundled
        ? getBundledOflPath(meta)
        : join(getFontUserDir(fontId), 'OFL.txt')
      if (oflPath && existsSync(oflPath)) {
        const buf = await fs.readFile(oflPath, 'utf-8')
        return { ok: true, data: buf }
      }
      // Fallback: the OFL.txt is missing on disk (corrupt install, or a
      // font registry entry that hasn't shipped the OFL yet).  Return the
      // registry copyright string so the License panel still surfaces
      // attribution; the renderer can show a hint that the full text is
      // unavailable.
      log.warn(`[ipc/font] OFL.txt missing for ${fontId}; falling back to registry copyright`)
      return { ok: true, data: meta.copyright }
    } catch (err) {
      log.error('[ipc/font] readOfl error', err)
      return { ok: false, error: { code: 'FONT_READ_OFL_ERROR', message: (err as Error).message } }
    }
  })

  ipcMain.handle(Channels.fontReadBytes, async (_event, fontId: string): Promise<OkResult<ArrayBuffer> | ErrResult> => {
    try { assertValidFontId(fontId) } catch (err) {
      return { ok: false, error: { code: 'INVALID_FONT_ID', message: (err as Error).message } }
    }
    try {
      const meta = getFontMeta(fontId)
      const ttfPath = join(getFontResolveDir(meta), meta.fileName)
      if (!existsSync(ttfPath)) {
        return { ok: false, error: { code: 'FONT_NOT_INSTALLED', message: `TTF missing: ${ttfPath}` } }
      }
      const buf = await fs.readFile(ttfPath)
      // Convert Buffer to ArrayBuffer for transmission across IPC.  The slice
      // ensures we transmit only this buffer's bytes — Buffer.buffer can be
      // shared across many Buffers in Node and would otherwise leak unrelated
      // memory.
      const arrayBuf = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      return { ok: true, data: arrayBuf as ArrayBuffer }
    } catch (err) {
      log.error('[ipc/font] readBytes error', err)
      return { ok: false, error: { code: 'FONT_READ_BYTES_ERROR', message: (err as Error).message } }
    }
  })
}
