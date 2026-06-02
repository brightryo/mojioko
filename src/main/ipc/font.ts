import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fs, existsSync } from 'fs'
import { join } from 'path'
import { Channels } from '../../shared/ipc-channels'
import {
  isFontId,
  getFontMeta,
  DEFAULT_FONT_ID,
  type FontId,
  type FontsState
} from '../../shared/fonts'
import {
  buildFontsState,
  downloadFont,
  uninstallFont as removeFontDir
} from '../services/font-downloader'
import { getFontUserDir, getFontResolveDir, getBundledOflPath } from '../lib/paths'
import { loadSettings, saveSettings } from '../services/settings-store'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

function assertValidFontId(value: unknown): asserts value is FontId {
  if (!isFontId(value)) throw new Error(`Invalid fontId: ${String(value)}`)
}

async function activeFontIdFromSettings(): Promise<FontId> {
  const settings = await loadSettings()
  if (settings.activeFontId && isFontId(settings.activeFontId)) return settings.activeFontId
  return DEFAULT_FONT_ID
}

export function registerFontHandlers(): void {
  const activeDownloads = new Map<string, AbortController>()

  ipcMain.handle(Channels.fontList, async (): Promise<OkResult<FontsState> | ErrResult> => {
    try {
      const active = await activeFontIdFromSettings()
      return { ok: true, data: buildFontsState(active) }
    } catch (err) {
      log.error('[ipc/font] list error', err)
      return { ok: false, error: { code: 'FONT_LIST_ERROR', message: (err as Error).message } }
    }
  })

  ipcMain.handle(Channels.fontDownload, async (event, fontId: string): Promise<OkResult<{ channelId: string }> | ErrResult> => {
    try { assertValidFontId(fontId) } catch (err) {
      return { ok: false, error: { code: 'INVALID_FONT_ID', message: (err as Error).message } }
    }
    const channelId = `font:download:${randomUUID()}`
    const controller = new AbortController()
    activeDownloads.set(channelId, controller)

    log.info(`[ipc/font] download ${fontId} channelId=${channelId}`)

    downloadFont(fontId, (evt) => {
      if (!event.sender.isDestroyed()) event.sender.send(channelId, evt)
    }, controller.signal).catch((err) => {
      log.error('[ipc/font] download error', err)
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, { event: 'failed', error: String(err instanceof Error ? err.message : err) })
      }
    }).finally(() => {
      activeDownloads.delete(channelId)
    })

    return { ok: true, data: { channelId } }
  })

  ipcMain.handle(`${Channels.fontDownload}:cancel`, (_event, channelId: string): void => {
    activeDownloads.get(channelId)?.abort()
    activeDownloads.delete(channelId)
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
      const active = await activeFontIdFromSettings()
      return { ok: true, data: buildFontsState(active) }
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
      return { ok: true, data: buildFontsState(fontId) }
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
