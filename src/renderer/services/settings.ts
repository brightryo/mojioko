import type { AppSettings, IpcResult, SettingsLoadResult } from '../../shared/types'

export async function loadSettings(): Promise<IpcResult<SettingsLoadResult>> {
  return window.electronAPI.settingsLoad()
}

export async function saveSettings(settings: AppSettings): Promise<IpcResult<null>> {
  return window.electronAPI.settingsSave(settings)
}
