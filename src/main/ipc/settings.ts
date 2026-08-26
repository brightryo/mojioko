import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { loadSettings, mutateSettings, takeSettingsQuarantineNotice } from '../services/settings-store'
import { mergeSettingsForSave } from './settings-merge'
import type { AppSettings, SettingsLoadResult } from '../../shared/types'
import log from '../lib/logger'

export function registerSettingsHandlers(): void {
  ipcMain.handle(Channels.settingsLoad, async (): Promise<{ ok: true; data: SettingsLoadResult } | { ok: false; error: { code: string; message: string } }> => {
    try {
      const settings = await loadSettings()
      // REQ-0542 — taking it here (rather than on a channel of its own) is what
      // makes "shown once" mean once: the renderer asks for settings exactly
      // once at startup, and the notice is cleared as it leaves main.
      return { ok: true, data: { settings, quarantine: takeSettingsQuarantineNotice() } }
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
