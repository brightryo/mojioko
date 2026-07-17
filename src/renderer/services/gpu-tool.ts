import type {
  DownloadGpuToolEvent,
  GpuToolState,
} from '../../shared/gpu-tool'

type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

/**
 * REQ-0149 — client wrapper for the GPU tool IPC.  Same shape as
 * `services/transcription.ts` (download → returns a `{promise, cancel}`
 * handle that the caller stashes in a ref for the Cancel button).
 */

export interface GpuToolDownloadRun {
  promise: Promise<void>
  cancel: () => void
}

export class GpuToolDownloadError extends Error {
  readonly errorCode: NonNullable<
    Extract<DownloadGpuToolEvent, { event: 'failed' }>['errorCode']
  >
  constructor(errorCode: NonNullable<
    Extract<DownloadGpuToolEvent, { event: 'failed' }>['errorCode']
  >, message: string) {
    super(message)
    this.name = 'GpuToolDownloadError'
    this.errorCode = errorCode
  }
}

export async function getGpuToolState(): Promise<GpuToolState | null> {
  const r = (await window.electronAPI.gpuToolState()) as IpcResult<GpuToolState>
  return r.ok ? r.data : null
}

export function startGpuToolDownload(
  onEvent: (evt: DownloadGpuToolEvent) => void,
): GpuToolDownloadRun {
  let cleanup: (() => void) | null = null
  let cancelChannelId: string | null = null
  // REQ-0244 — honour cancel that races the initial invoke.
  let cancelled = false

  const promise = new Promise<void>((resolve, reject) => {
    window.electronAPI
      .gpuToolDownload()
      .then((r: IpcResult<{ channelId: string }>) => {
        if (!r.ok) {
          reject(new Error(r.error.message))
          return
        }
        cancelChannelId = r.data.channelId
        if (cancelled) {
          window.electronAPI.gpuToolDownloadCancel(cancelChannelId).catch(() => {})
          reject(new GpuToolDownloadError('aborted', 'Cancelled'))
          return
        }
        cleanup = window.electronAPI.subscribeToChannel(
          r.data.channelId,
          (payload: unknown) => {
            const evt = payload as DownloadGpuToolEvent
            onEvent(evt)
            if (evt.event === 'completed') {
              cleanup?.()
              resolve()
            } else if (evt.event === 'failed') {
              cleanup?.()
              reject(new GpuToolDownloadError(evt.errorCode ?? 'fatal', evt.error))
            }
          },
        )
      })
  })

  return {
    promise,
    // REQ-0244 — do NOT `cleanup()` here.  Main-side abort emits a
    // 'failed' event on the channel; leaving the subscription attached
    // lets the callback settle the promise (reject → cleanup).  The
    // pre-fix code called cleanup() first, orphaning the 'failed'
    // event and hanging the promise forever (see transcription.ts
    // fix and the batch-cancel-restore bug this REQ addresses).
    cancel: () => {
      cancelled = true
      if (cancelChannelId) {
        window.electronAPI.gpuToolDownloadCancel(cancelChannelId).catch(() => {})
      }
    },
  }
}

export async function deleteGpuTool(): Promise<GpuToolState | null> {
  const r = (await window.electronAPI.gpuToolDelete()) as IpcResult<GpuToolState>
  return r.ok ? r.data : null
}

export async function selectAccelerator(choice: 'cpu' | 'gpu'): Promise<GpuToolState | null> {
  const r = (await window.electronAPI.gpuToolSelect(choice)) as IpcResult<GpuToolState>
  return r.ok ? r.data : null
}
