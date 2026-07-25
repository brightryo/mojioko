import type { FontsState, FontId, DownloadFontEvent } from '../../shared/fonts'
import type { IpcResult } from '../../shared/types'

export type { DownloadFontEvent }

export async function listFonts(): Promise<IpcResult<FontsState>> {
  return window.electronAPI.fontList()
}

export async function uninstallFont(fontId: FontId): Promise<IpcResult<FontsState>> {
  return window.electronAPI.fontUninstall(fontId)
}

/**
 * REQ-0281 §4 — remove every downloaded (non-bundled) font AND reset
 * `fontSetInstalledVersion` back to undefined so the binary set state
 * pins at 0 (`not-installed`).  Called from the batch DL cancel/failure
 * cleanup path AND from the FontPicker's "Uninstall all additional
 * fonts" button (which replaced the per-row trash icons under the
 * binary state model).  The `removedIds` array in the response lets
 * the caller toast an accurate count and evict per-font renderer
 * caches (font-registry, font-metrics) in one pass.
 */
export async function uninstallAllFonts(): Promise<IpcResult<FontsState & { removedIds: FontId[] }>> {
  return window.electronAPI.fontUninstallAll()
}

export async function setActiveFont(fontId: FontId): Promise<IpcResult<FontsState>> {
  return window.electronAPI.fontSetActive(fontId)
}

export async function readFontOfl(fontId: FontId): Promise<IpcResult<string>> {
  return window.electronAPI.fontReadOfl(fontId)
}

export async function readFontBytes(fontId: FontId): Promise<IpcResult<ArrayBuffer>> {
  return window.electronAPI.fontReadBytes(fontId)
}

/**
 * REQ-0275 §3 — mark the on-disk font set as matching the current
 * FONT_SET_VERSION.  Called by the FontPicker's bulk-download success
 * path so subsequent `listFonts` returns `status: 'installed'` for the
 * newly-downloaded weights instead of `not-installed`.
 */
export async function recordFontSetVersion(): Promise<IpcResult<{ version: number }>> {
  return window.electronAPI.fontRecordSetVersion()
}

export interface FontDownloadRun {
  promise: Promise<void>
  cancel: () => void
}

/**
 * Start a font download and return a handle.  Mirrors the shape of
 * `downloadModel` in `services/transcription.ts`.  Auto-unsubscribes on
 * `completed` and `failed` events to avoid the leak documented in the v1.0.0
 * code review's M-5.
 */
export function downloadFont(
  fontId: FontId,
  onEvent: (evt: DownloadFontEvent) => void
): FontDownloadRun {
  let channelId: string | null = null
  let unsub: (() => void) | null = null
  // REQ-0244 — honour cancel that races the initial invoke.
  let cancelled = false

  const promise = (async () => {
    const result = await window.electronAPI.fontDownload(fontId)
    if (!result.ok) throw new Error(result.error.message)
    channelId = result.data.channelId

    if (cancelled) {
      window.electronAPI.fontDownloadCancel(channelId)
      throw new Error('Cancelled')
    }

    return new Promise<void>((resolve, reject) => {
      unsub = window.electronAPI.subscribeToChannel(channelId!, (payload) => {
        const evt = payload as DownloadFontEvent
        onEvent(evt)
        if (evt.event === 'completed') {
          unsub?.()
          resolve()
        } else if (evt.event === 'failed') {
          unsub?.()
          reject(new Error(evt.error))
        }
      })
    })
  })()

  return {
    promise,
    // REQ-0244 — critical fix: do NOT `unsub?.()` here.  Leave the
    // subscription attached so the main-side 'failed' event fired by
    // the abort settles the inner Promise via reject().  The pre-fix
    // ordering (unsub → cancel) orphaned the 'failed' event and hung
    // the outer `await run.promise` forever — the batch loop in
    // font-picker.tsx `handleBatchDownload` couldn't advance past the
    // cancelled iteration, so its post-loop cleanup
    // (`setBatchState(null)`) never ran and the batch button never
    // came back.  This is the root cause called out in REQ-0244.
    cancel: () => {
      cancelled = true
      if (channelId) window.electronAPI.fontDownloadCancel(channelId)
    }
  }
}
