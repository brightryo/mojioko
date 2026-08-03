import { ipcMain } from 'electron'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { Channels } from '../../shared/ipc-channels'
import { getTranslationToolsDir } from '../lib/paths'
import { loadSettings, mutateSettings } from '../services/settings-store'
import {
  buildTranslationToolsState,
  isToolInstalled,
  isToolPlaceholder,
} from '../services/translation-tool-store'
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
    async (_event, toolId: string): Promise<OkResult<{ channelId: string }> | ErrResult> => {
      if (!isTranslationToolId(toolId)) {
        return { ok: false, error: { code: 'INVALID_TOOL_ID', message: `Unknown translation tool: ${toolId}` } }
      }
      // Phase 1 — every tool is a placeholder (no download source), so the real
      // streaming download is not wired yet.  Report it cleanly; the renderer
      // shows a "coming soon" message and never hits the network.
      if (isToolPlaceholder(toolId)) {
        return {
          ok: false,
          error: { code: 'TOOL_NOT_CONFIGURED', message: `Translation tool ${toolId} has no download source yet (Phase 1)` },
        }
      }
      // (Unreachable in Phase 1.)  When a real repo is wired, the streaming
      // download — same shape as `transcriptionDownloadModel` — is added here.
      return { ok: false, error: { code: 'TOOL_NOT_CONFIGURED', message: 'Not implemented' } }
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
