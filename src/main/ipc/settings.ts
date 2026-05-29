import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { loadSettings, saveSettings } from '../services/settings-store'
import type { AppSettings } from '../../shared/types'
import log from '../lib/logger'

export function registerSettingsHandlers(): void {
  ipcMain.handle(Channels.settingsLoad, async (): Promise<{ ok: true; data: AppSettings } | { ok: false; error: { code: string; message: string } }> => {
    try {
      const data = await loadSettings()
      return { ok: true, data }
    } catch (err: unknown) {
      const e = err as Error
      log.error('[ipc/settings] load error', err)
      return { ok: false, error: { code: 'SETTINGS_LOAD_ERROR', message: e.message } }
    }
  })

  ipcMain.handle(Channels.settingsSave, async (_event, settings: AppSettings): Promise<{ ok: true; data: null } | { ok: false; error: { code: string; message: string } }> => {
    try {
      // Merge with the currently persisted settings so that fields managed
      // exclusively by the main process (activeModelId, lastInputDir,
      // lastOutputDir) are not clobbered when the renderer sends null.
      //
      // Step 3-only UI state (`burnin`, `subtitleBackground`, `audioMode`) is
      // explicitly dropped from the saved file — the renderer treats these as
      // session-only and resets them on Step 1 navigation.  Stripping them
      // here ensures stale values from older versions can never re-emerge.
      const existing = await loadSettings()
      const merged: AppSettings = {
        ...settings,
        activeModelId:       settings.activeModelId       ?? existing.activeModelId,
        lastInputDir:        settings.lastInputDir        ?? existing.lastInputDir,
        lastOutputDir:       settings.lastOutputDir       ?? existing.lastOutputDir,
      }
      delete merged.burnin
      delete merged.subtitleBackground
      delete merged.audioMode
      await saveSettings(merged)
      return { ok: true, data: null }
    } catch (err: unknown) {
      const e = err as Error
      log.error('[ipc/settings] save error', err)
      return { ok: false, error: { code: 'SETTINGS_SAVE_ERROR', message: e.message } }
    }
  })
}
