import type {
  DownloadGpuToolEvent,
  GpuToolState,
} from '../../shared/gpu-tool'
import { tryParseBusyError } from './download-busy-error'

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

  const promise = new Promise<void>((resolve, reject) => {
    window.electronAPI
      .gpuToolDownload()
      .then((r: IpcResult<{ channelId: string }>) => {
        if (!r.ok) {
          // REQ-0241 — typed busy rejection so the GPU-tool card can
          // toast + tooltip instead of bubbling a generic Error.
          const busy = tryParseBusyError(r.error)
          reject(busy ?? new Error(r.error.message))
          return
        }
        cancelChannelId = r.data.channelId
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
    cancel: () => {
      if (cancelChannelId) {
        window.electronAPI.gpuToolDownloadCancel(cancelChannelId).catch(() => {})
      }
      cleanup?.()
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
