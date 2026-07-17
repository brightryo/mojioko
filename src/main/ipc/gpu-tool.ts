import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { Channels } from '../../shared/ipc-channels'
import {
  buildGpuToolState,
  downloadGpuTool,
  deleteGpuTool,
  setActiveAccelerator,
} from '../services/gpu-tool'
import { downloadManager, type DownloadToken } from '../services/download-manager'
import { GPU_TOOL_RELEASE_TAG, type GpuToolState } from '../../shared/gpu-tool'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

/**
 * REQ-0149 — IPC surface for the GPU acceleration tools.  Follows the
 * shape already in use for whisper models and fonts:
 *
 *   - state:    invoke → snapshot for the accordion
 *   - download: invoke → `channelId`, event stream on that channel;
 *               a companion `${channel}:cancel` invoke aborts the run
 *   - delete:   invoke → deletes the folder + returns fresh state
 */
export function registerGpuToolHandlers(): void {
  ipcMain.handle(Channels.gpuToolState, async (): Promise<OkResult<GpuToolState> | ErrResult> => {
    try {
      const data = await buildGpuToolState()
      return { ok: true, data }
    } catch (err) {
      const e = err as Error
      log.error('[ipc/gpu-tool] state error', err)
      return { ok: false, error: { code: 'GPU_TOOL_STATE_ERROR', message: e.message } }
    }
  })

  // REQ-0241 — DownloadManager-issued tokens keyed by per-run channelId.
  const activeDownloads = new Map<string, DownloadToken>()

  ipcMain.handle(Channels.gpuToolDownload, async (event): Promise<OkResult<{ channelId: string }> | ErrResult> => {
    // REQ-0241 — GPU tool DL passes through the same one-slot mutex as
    // model / font downloads.  Concurrent bandwidth + write races on
    // %APPDATA%/MOJIOKO would otherwise be trivially reachable.
    const acquired = downloadManager.acquire('gpu-tool', GPU_TOOL_RELEASE_TAG)
    if ('busy' in acquired) {
      return {
        ok: false,
        error: {
          code: 'DOWNLOAD_BUSY',
          message: `Another download is in progress: ${acquired.active.kind} (${acquired.active.label})`,
        },
      }
    }
    const token = acquired
    const channelId = `gpu-tool:event:${randomUUID()}`
    activeDownloads.set(channelId, token)
    log.info(`[ipc/gpu-tool] download start, channelId=${channelId}`)

    downloadGpuTool((evt) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, evt)
      }
    }, token.signal).finally(() => {
      token.release()
      activeDownloads.delete(channelId)
    })

    return { ok: true, data: { channelId } }
  })

  ipcMain.handle(`${Channels.gpuToolDownload}:cancel`, (_event, channelId: string): void => {
    activeDownloads.get(channelId)?.cancel()
    activeDownloads.delete(channelId)
  })

  ipcMain.handle(Channels.gpuToolDelete, async (): Promise<OkResult<GpuToolState> | ErrResult> => {
    try {
      // REQ-0150 — dropping the tools also forces the accelerator back
      // to CPU so a "download → select GPU → delete" cycle can't leave
      // settings.json in a stale `activeAccelerator='gpu'` state that
      // then no-ops silently.  `setActiveAccelerator` handles the
      // fallback internally when the install is gone.
      //
      // REQ-0218 §Fix 3 — `deleteGpuTool` is now async because it must
      // wait for the sidecar to release its CUDA DLL handles before
      // unlinking; `await` is load-bearing (dropping it would race the
      // delete against the sidecar's own teardown and reintroduce the
      // EPERM failure that motivated the fix).
      await deleteGpuTool()
      const data = await setActiveAccelerator('cpu')
      return { ok: true, data }
    } catch (err) {
      const e = err as Error
      log.error('[ipc/gpu-tool] delete error', err)
      return { ok: false, error: { code: 'GPU_TOOL_DELETE_ERROR', message: e.message } }
    }
  })

  ipcMain.handle(Channels.gpuToolSelect, async (_event, choice: 'cpu' | 'gpu'): Promise<OkResult<GpuToolState> | ErrResult> => {
    try {
      const data = await setActiveAccelerator(choice)
      log.info(`[ipc/gpu-tool] activeAccelerator → ${data.activeAccelerator}`)
      return { ok: true, data }
    } catch (err) {
      const e = err as Error
      log.error('[ipc/gpu-tool] select error', err)
      return { ok: false, error: { code: 'GPU_TOOL_SELECT_ERROR', message: e.message } }
    }
  })
}
