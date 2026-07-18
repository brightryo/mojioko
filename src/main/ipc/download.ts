import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { downloadManager } from '../services/download-manager'
import type { ActiveDownloadInfo } from '../../shared/ipc-contracts'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

/**
 * REQ-0241 → REQ-0244 (retired) → REQ-0245 (restored, multi-slot).
 *
 * Exposes a boot-time hydration snapshot of the DownloadManager's
 * active-slot ARRAY.  Live updates arrive on
 * `Channels.downloadActiveChanged` (fired directly by the manager to
 * every open BrowserWindow), so no per-channel handler is needed for
 * updates — only this initial `get`.
 *
 * Use case: the renderer is unmounting/remounting components (e.g.
 * closing and reopening the settings drawer) while a download is
 * in flight.  Without hydration, remounted components would show
 * "Download" buttons for keys main still holds.  This handler + the
 * boot subscription (`initDownloadActiveStore`) keep the store true
 * to main.
 */
export function registerDownloadHandlers(): void {
  ipcMain.handle(Channels.downloadActiveGet, (): OkResult<ActiveDownloadInfo[]> | ErrResult => {
    try {
      return { ok: true, data: downloadManager.snapshot() }
    } catch (err) {
      log.error('[ipc/download] active:get error', err)
      return { ok: false, error: { code: 'DOWNLOAD_ACTIVE_GET_ERROR', message: (err as Error).message } }
    }
  })
}
