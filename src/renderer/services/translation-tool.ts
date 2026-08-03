import type { IpcResult } from '../../shared/types'
import type { TranslationToolId, TranslationToolsState } from '../../shared/translation-tools'
import type { DownloadModelEvent } from '../../shared/ipc-contracts'

/**
 * REQ-0405 — renderer service wrapper for the translation-tool IPC (Phase 1).
 * Components/stores never touch `window.electronAPI` directly (ARCHITECTURE
 * layering); they call these thin wrappers.
 */

export async function listTranslationTools(): Promise<IpcResult<TranslationToolsState>> {
  return window.electronAPI.translationToolList()
}

export interface TranslationToolDownloadRun {
  promise: Promise<void>
  cancel: () => void
}

export class TranslationToolDownloadError extends Error {
  readonly errorCode: NonNullable<Extract<DownloadModelEvent, { event: 'failed' }>['errorCode']> | 'fatal'
  constructor(errorCode: TranslationToolDownloadError['errorCode'], message: string) {
    super(message)
    this.name = 'TranslationToolDownloadError'
    this.errorCode = errorCode
  }
}

/**
 * REQ-0407 — start a real streaming download.  Mirrors `startGpuToolDownload`:
 * returns a `{ promise, cancel }` handle; `onEvent` receives progress ticks; the
 * promise resolves on `completed` and rejects on `failed` (incl. user cancel).
 */
export function startTranslationToolDownload(
  toolId: TranslationToolId,
  onEvent: (evt: DownloadModelEvent) => void,
): TranslationToolDownloadRun {
  let cleanup: (() => void) | null = null
  let cancelChannelId: string | null = null
  let cancelled = false

  const promise = new Promise<void>((resolve, reject) => {
    window.electronAPI
      .translationToolDownload(toolId)
      .then((r) => {
        if (!r.ok) {
          reject(new TranslationToolDownloadError('fatal', r.error.message))
          return
        }
        cancelChannelId = r.data.channelId
        if (cancelled) {
          window.electronAPI.translationToolDownloadCancel(cancelChannelId).catch(() => {})
          reject(new TranslationToolDownloadError('aborted', 'Cancelled'))
          return
        }
        cleanup = window.electronAPI.subscribeToChannel(cancelChannelId, (payload: unknown) => {
          const evt = payload as DownloadModelEvent
          onEvent(evt)
          if (evt.event === 'completed') {
            cleanup?.()
            resolve()
          } else if (evt.event === 'failed') {
            cleanup?.()
            reject(new TranslationToolDownloadError(evt.errorCode ?? 'fatal', evt.error))
          }
        })
      })
  })

  return {
    promise,
    cancel: () => {
      cancelled = true
      if (cancelChannelId) {
        window.electronAPI.translationToolDownloadCancel(cancelChannelId).catch(() => {})
      }
    },
  }
}

export async function uninstallTranslationTool(
  toolId: TranslationToolId,
): Promise<IpcResult<TranslationToolsState>> {
  return window.electronAPI.translationToolUninstall(toolId)
}

/** Enable a tool (id) or disable translation (null). */
export async function setActiveTranslationTool(
  toolId: TranslationToolId | null,
): Promise<IpcResult<TranslationToolsState>> {
  return window.electronAPI.translationToolSetActive(toolId)
}
