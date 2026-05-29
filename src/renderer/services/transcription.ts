import type { IpcResult, ModelsState, WhisperModelId, TranscriptionAdvancedParams } from '../../shared/types'
import type { TranscriptionEvent, ModelCheckResult, DownloadModelEvent } from '../../shared/ipc-contracts'

export type { TranscriptionEvent }
export type { ModelCheckResult }
export type { DownloadModelEvent }

export async function checkModel(modelId: string): Promise<IpcResult<ModelCheckResult>> {
  return window.electronAPI.transcriptionCheckModel(modelId)
}

export async function listModels(): Promise<IpcResult<ModelsState>> {
  return window.electronAPI.transcriptionListModels()
}

export async function uninstallModel(modelId: WhisperModelId): Promise<IpcResult<ModelsState>> {
  return window.electronAPI.transcriptionUninstallModel(modelId)
}

export async function setActiveModel(modelId: WhisperModelId): Promise<IpcResult<ModelsState>> {
  return window.electronAPI.transcriptionSetActiveModel(modelId)
}

export async function openModelsFolder(): Promise<void> {
  return window.electronAPI.shellOpenModelsFolder()
}

export interface TranscriptionOptions {
  videoPath: string
  trackIndex: number
  modelId: string
  defaults: {
    fontSizePx: number
    textColorHex: string
    outlineColorHex: string
    outlineThicknessPx: number
    fadeEnabled: boolean
  }
  advanced: TranscriptionAdvancedParams
}

export interface TranscriptionRun {
  /** Resolves when transcription completes; rejects on error or cancel. */
  promise: Promise<void>
  cancel: () => void
}

export interface DownloadRun {
  promise: Promise<void>
  cancel: () => void
}

export function downloadModel(
  modelId: string,
  onEvent: (event: DownloadModelEvent) => void
): DownloadRun {
  let channelId: string | null = null
  let unsub: (() => void) | null = null

  const promise = (async () => {
    const result = await window.electronAPI.transcriptionDownloadModel(modelId)
    if (!result.ok) throw new Error(result.error.message)
    channelId = result.data.channelId

    return new Promise<void>((resolve, reject) => {
      unsub = window.electronAPI.subscribeToChannel(channelId!, (payload) => {
        const evt = payload as DownloadModelEvent
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
      if (channelId) window.electronAPI.transcriptionDownloadModelCancel(channelId)
    }
  }
}

/**
 * Start a transcription and return a handle to track completion and cancel.
 * Events (progress, segments, etc.) are delivered via `onEvent`.
 */
export function runTranscription(
  opts: TranscriptionOptions,
  onEvent: (event: TranscriptionEvent) => void
): TranscriptionRun {
  let doCancel = () => {}

  const promise = (async () => {
    const result = await window.electronAPI.transcriptionStart({
      videoPath: opts.videoPath,
      trackIndex: opts.trackIndex,
      modelId: opts.modelId,
      modelsDir: '',   // filled in by main process
      ffmpegPath: '',  // filled in by main process
      defaults: opts.defaults,
      advanced: opts.advanced
    })

    if (!result.ok) throw new Error(result.error.message)

    const { channelId } = result.data

    return new Promise<void>((resolve, reject) => {
      const unsub = window.electronAPI.subscribeToChannel(channelId, (payload) => {
        const evt = payload as TranscriptionEvent
        onEvent(evt)
        if (evt.event === 'completed') {
          unsub()
          resolve()
        } else if (evt.event === 'failed') {
          unsub()
          reject(new Error(evt.error))
        } else if (evt.event === 'needsDownload') {
          unsub()
          reject(new Error(`needsDownload:${evt.model}`))
        }
      })

      doCancel = () => {
        unsub()
        window.electronAPI.transcriptionCancel()
        reject(new Error('Cancelled'))
      }
    })
  })()

  return { promise, cancel: () => doCancel() }
}
