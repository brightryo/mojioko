import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { loadSettings, mutateSettings } from '../services/settings-store'
import { mergeSettingsForSave } from './settings-merge'
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
      // REQ-0319 §1 — the whole read-merge-write runs inside the settings lock.
      await mutateSettings((existing) => ({
        save: mergeSettingsForSave(settings, existing),
        value: null,
      }))
      return { ok: true, data: null }
    } catch (err: unknown) {
      const e = err as Error
      log.error('[ipc/settings] save error', err)
      return { ok: false, error: { code: 'SETTINGS_SAVE_ERROR', message: e.message } }
    }
  })
}
