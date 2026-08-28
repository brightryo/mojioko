import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { Channels } from '../../shared/ipc-channels'
import { getTranslationToolsDir } from '../lib/paths'
import { loadSettings, mutateSettings } from '../services/settings-store'
import {
  buildTranslationToolsState,
  isToolInstalled,
} from '../services/translation-tool-store'
import { downloadTranslationTool } from '../services/translation-tool-downloader'
import { downloadManager, type DownloadToken } from '../services/download-manager'
import { DownloadError } from '../services/model-downloader'
import { isTranslationToolId, type TranslationToolId, type TranslationToolsState } from '../../shared/translation-tools'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

/**
 * REQ-0405 — translation-tool management handlers (Phase 1: list / download /
 * uninstall / setActive).  Mirrors the Whisper model handlers.  Download is
 * gated while the tools are placeholders (no real repo): the handler returns
 * `TOOL_NOT_CONFIGURED` and the renderer surfaces a "coming soon" message
 * WITHOUT touching the network (offline-preserving — REQ-0405 §6).  The real
 * streaming download lands with the repo in a follow-up REQ.
 */
export function registerTranslationToolHandlers(): void {
  // Per-run cancel tokens, keyed by the streaming download channel id.
  const activeDownloads = new Map<string, DownloadToken>()

  ipcMain.handle(
    Channels.translationToolList,
    async (): Promise<OkResult<TranslationToolsState> | ErrResult> => {
      try {
        const settings = await loadSettings()
        const state = buildTranslationToolsState(settings.translationToolActiveId ?? null)
        return { ok: true, data: state }
      } catch (err) {
        const e = err as Error
        log.error('[ipc/translation-tool] list error', err)
        return { ok: false, error: { code: 'LIST_TOOLS_ERROR', message: e.message } }
      }
    },
  )

  ipcMain.handle(
    Channels.translationToolDownload,
    async (event, toolId: string): Promise<OkResult<{ channelId: string }> | ErrResult> => {
      if (!isTranslationToolId(toolId)) {
        return { ok: false, error: { code: 'INVALID_TOOL_ID', message: `Unknown translation tool: ${toolId}` } }
      }
      // REQ-0244-style per-target acquire so a same-tool double-invoke is
      // refused (the UI already swaps Download → Cancel while in flight).
      const acquired = downloadManager.acquire('translation-tool', toolId, toolId)
      if ('busy' in acquired) {
        return { ok: false, error: { code: 'DOWNLOAD_BUSY', message: `Download already in progress for ${toolId}` } }
      }
      const token = acquired
      const channelId = `translationTool:download:${randomUUID()}`
      activeDownloads.set(channelId, token)

      const toolsDir = getTranslationToolsDir()
      log.info(`[ipc/translation-tool] download ${toolId}, channelId=${channelId}`)

      // REQ-0407 — real streaming download (Whisper downloader reused).  Runs
      // detached; progress / completed / failed stream on `channelId`.
      downloadTranslationTool(
        toolId,
        toolsDir,
        (evt) => {
          if (!event.sender.isDestroyed()) event.sender.send(channelId, evt)
        },
        token.signal,
      )
        .catch((err) => {
          log.error('[ipc/translation-tool] download error', err)
          if (!event.sender.isDestroyed()) {
            const errorCode = err instanceof DownloadError ? err.code : 'fatal'
            const inner = err instanceof DownloadError ? err.inner : err
            const innerMsg = inner instanceof Error ? inner.message : String(inner)
            event.sender.send(channelId, { event: 'failed', error: innerMsg, errorCode })
          }
        })
        .finally(() => {
          token.release()
          activeDownloads.delete(channelId)
        })

      return { ok: true, data: { channelId } }
    },
  )

  ipcMain.handle(
    `${Channels.translationToolDownload}:cancel`,
    (_event, channelId: string): void => {
      activeDownloads.get(channelId)?.cancel()
      activeDownloads.delete(channelId)
    },
  )

  ipcMain.handle(
    Channels.translationToolUninstall,
    async (_event, toolId: string): Promise<OkResult<TranslationToolsState> | ErrResult> => {
      try {
        if (!isTranslationToolId(toolId)) {
          return { ok: false, error: { code: 'INVALID_TOOL_ID', message: `Unknown translation tool: ${toolId}` } }
        }
        const toolsDir = getTranslationToolsDir()
        const dir = join(toolsDir, toolId)
        if (existsSync(dir)) {
          rmSync(dir, { recursive: true, force: true })
          log.info(`[ipc/translation-tool] uninstalled ${toolId}`)
        }
        // Deleting the enabled tool disables translation (spec §4).
        const activeId = await mutateSettings((settings) => {
          if (settings.translationToolActiveId === toolId) {
            settings.translationToolActiveId = null
          }
          return { save: settings, value: settings.translationToolActiveId ?? null }
        })
        return { ok: true, data: buildTranslationToolsState(activeId, toolsDir) }
      } catch (err) {
        const e = err as Error
        log.error('[ipc/translation-tool] uninstall error', err)
        return { ok: false, error: { code: 'UNINSTALL_TOOL_ERROR', message: e.message } }
      }
    },
  )

  ipcMain.handle(
    Channels.translationToolSetActive,
    async (_event, toolId: string | null): Promise<OkResult<TranslationToolsState> | ErrResult> => {
      try {
        const toolsDir = getTranslationToolsDir()
        let next: TranslationToolId | null
        if (toolId === null) {
          next = null // disable
        } else if (isTranslationToolId(toolId)) {
          if (!isToolInstalled(toolId, toolsDir)) {
            return { ok: false, error: { code: 'NOT_INSTALLED', message: `Translation tool ${toolId} is not installed` } }
          }
          next = toolId
        } else {
          return { ok: false, error: { code: 'INVALID_TOOL_ID', message: `Unknown translation tool: ${toolId}` } }
        }
        await mutateSettings((settings) => {
          settings.translationToolActiveId = next
          return { save: settings, value: null }
        })
        log.info(`[ipc/translation-tool] setActive → ${next ?? '(disabled)'}`)
        return { ok: true, data: buildTranslationToolsState(next, toolsDir) }
      } catch (err) {
        const e = err as Error
        log.error('[ipc/translation-tool] setActive error', err)
        return { ok: false, error: { code: 'SET_ACTIVE_TOOL_ERROR', message: e.message } }
      }
    },
  )
}
