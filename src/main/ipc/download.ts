import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { downloadManager } from '../services/download-manager'
import type { ActiveDownloadInfo } from '../../shared/ipc-contracts'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

/**
 * REQ-0241 — IPC surface for the app-wide download coordinator.
 *
 * There's just one active-download slot at a time; this handler exposes
 * a snapshot getter for boot-time hydration.  The `active:changed`
 * broadcast is fired directly by the DownloadManager to every open
 * BrowserWindow (no per-channel handler needed) so the renderer stays
 * in sync without having to poll.
 */
export function registerDownloadHandlers(): void {
  ipcMain.handle(Channels.downloadActiveGet, (): OkResult<ActiveDownloadInfo | null> | ErrResult => {
    try {
      return { ok: true, data: downloadManager.snapshot() }
    } catch (err) {
      log.error('[ipc/download] active:get error', err)
      return { ok: false, error: { code: 'DOWNLOAD_ACTIVE_GET_ERROR', message: (err as Error).message } }
    }
  })
}
