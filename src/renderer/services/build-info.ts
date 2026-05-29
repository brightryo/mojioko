import type { BuildInfo } from '../../shared/ipc-contracts'

export type { BuildInfo }

export async function getBuildInfo(): Promise<BuildInfo> {
  return window.electronAPI.getBuildInfo()
}
