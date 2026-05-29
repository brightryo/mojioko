import type { AppSettings, IpcResult } from '../../shared/types'

export async function loadSettings(): Promise<IpcResult<AppSettings>> {
  return window.electronAPI.settingsLoad()
}

export async function saveSettings(settings: AppSettings): Promise<IpcResult<null>> {
  return window.electronAPI.settingsSave(settings)
}
