import type { FontsState, FontId, DownloadFontEvent } from '../../shared/fonts'
import type { IpcResult } from '../../shared/types'
import { tryParseBusyError } from './download-busy-error'

export type { DownloadFontEvent }

export async function listFonts(): Promise<IpcResult<FontsState>> {
  return window.electronAPI.fontList()
}

export async function uninstallFont(fontId: FontId): Promise<IpcResult<FontsState>> {
  return window.electronAPI.fontUninstall(fontId)
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

  const promise = (async () => {
    const result = await window.electronAPI.fontDownload(fontId)
    if (!result.ok) {
      // REQ-0241 — typed busy rejection so the font picker can toast
      // the active kind + label instead of a generic Error.
      const busy = tryParseBusyError(result.error)
      if (busy) throw busy
      throw new Error(result.error.message)
    }
    channelId = result.data.channelId

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
    cancel: () => {
      unsub?.()
      if (channelId) window.electronAPI.fontDownloadCancel(channelId)
    }
  }
}
