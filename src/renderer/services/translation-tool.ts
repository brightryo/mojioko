import type { IpcResult } from '../../shared/types'
import type { TranslationToolId, TranslationToolsState } from '../../shared/translation-tools'
import type { TranslateResult } from '../../shared/translation'
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

export async function openTranslationToolsFolder(): Promise<void> {
  return window.electronAPI.shellOpenTranslationToolsFolder()
}

/**
 * REQ-0410 — one-shot translate (prototype).  Resolves via the resident MADLAD
 * sidecar; the result is shown in a throwaway inspector field and never
 * persisted.  Returns the raw {@link IpcResult} so callers can branch on the
 * typed error code (NO_ACTIVE_TOOL / PYTHON_MISSING / SIDECAR_ERROR).
 */
export async function translateCue(
  text: string,
  // REQ-0426 — target MADLAD language code from the 「翻訳」 settings tab.
  target: string,
): Promise<IpcResult<TranslateResult>> {
  return window.electronAPI.translationTranslate(text, target)
}

/**
 * REQ-0430 — bulk translate a list of cue texts into `target` in one sidecar
 * round-trip (MADLAD `translate_batch`).  Output order matches the input.
 */
export async function translateBatchCues(
  texts: string[],
  target: string,
): Promise<IpcResult<{ texts: string[]; loadMs: number; translateMs: number }>> {
  return window.electronAPI.translationTranslateBatch(texts, target)
}

/**
 * REQ-0426 — warm the MADLAD sidecar (load model + tokenizer) ahead of the
 * first real translation.  Fired when the user enables 自動翻訳 so the inspector
 * preview is not cold on the first cue.
 */
export async function preloadTranslation(): Promise<IpcResult<{ loadMs: number }>> {
  return window.electronAPI.translationPreload()
}
