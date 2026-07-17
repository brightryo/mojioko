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
  /**
   * REQ-086 — total source audio tracks.  When >= 2, main spawns a
   * preview-mix ffmpeg pass after Whisper completes; the returned
   * `previewMixUrl` from `runTranscription` then populates the
   * preview-mix store so `VideoPreviewPanel` can wire a hidden
   * `<audio>` against the muted `<video>`.
   */
  audioTrackCount: number
  defaults: {
    fontSizePx: number
    textColorHex: string
    outlineColorHex: string
    outlineThicknessPx: number
    /** REQ-20260615-050 — seed for the per-entry fade.  `0` = no fade. */
    fadeDurationSec: number
  }
  advanced: TranscriptionAdvancedParams
  /**
   * REQ-0207 — experimental word-level subtitle re-split.  Default off,
   * off matches the pre-REQ-0207 payload byte-identically (the key is
   * dropped from the sidecar JSON when false / undefined — see
   * `main/services/transcription-sidecar.ts` for the guard).
   */
  wordSubtitle?: boolean
}

export interface TranscriptionRunResult {
  /**
   * REQ-086 — preview-mix URL when the source had >= 2 audio tracks
   * and the mix succeeded.  `null` for 0- or 1-track sources (no mix
   * needed) and for pre-v1.3.2 main processes that do not emit the
   * field.
   */
  previewMixUrl: string | null
}

export interface TranscriptionRun {
  /** Resolves with the run's result (incl. preview-mix URL when applicable);
   *  rejects on error or cancel. */
  promise: Promise<TranscriptionRunResult>
  cancel: () => void
}

export interface DownloadRun {
  promise: Promise<void>
  cancel: () => void
}

/**
 * REQ-20260615-081 — error subclass that carries the IPC `errorCode`
 * so the renderer's toast layer can pick the right locale key without
 * parsing the message string.  Pre-REQ-081 the renderer wrapped the
 * raw IPC message in a plain `Error`, which surfaced "Error:
 * TypeError: terminated" verbatim in the UI on undici drops.
 */
export class DownloadFailedError extends Error {
  readonly errorCode: 'network' | 'fatal' | 'aborted'
  constructor(errorCode: 'network' | 'fatal' | 'aborted', innerMsg: string) {
    super(innerMsg)
    this.name = 'DownloadFailedError'
    this.errorCode = errorCode
  }
}


export function downloadModel(
  modelId: string,
  onEvent: (event: DownloadModelEvent) => void
): DownloadRun {
  let channelId: string | null = null
  let unsub: (() => void) | null = null
  // REQ-0244 — cancel() flag: if the user hits Cancel between
  // `transcriptionDownloadModel` invoke and its resolution, we honour
  // it as soon as we know the channelId (fire IPC cancel + throw).
  let cancelled = false

  const promise = (async () => {
    const result = await window.electronAPI.transcriptionDownloadModel(modelId)
    if (!result.ok) throw new Error(result.error.message)
    channelId = result.data.channelId

    if (cancelled) {
      // Cancel raced the invoke.  Tell main to abort (main may or may
      // not have started I/O yet) and unwind so awaiters stop pending.
      window.electronAPI.transcriptionDownloadModelCancel(channelId)
      throw new Error('Cancelled')
    }

    return new Promise<void>((resolve, reject) => {
      unsub = window.electronAPI.subscribeToChannel(channelId!, (payload) => {
        const evt = payload as DownloadModelEvent
        onEvent(evt)
        if (evt.event === 'completed') {
          unsub?.()
          resolve()
        } else if (evt.event === 'failed') {
          unsub?.()
          // REQ-081 — when the main process attached a code, prefer
          // the typed DownloadFailedError so the consumer can dispatch
          // on `err.errorCode` instead of `String(err).includes(...)`.
          // Older main processes (no code) still produce a plain Error
          // with the message, matching pre-REQ-081 behaviour.
          if (evt.errorCode) {
            reject(new DownloadFailedError(evt.errorCode, evt.error))
          } else {
            reject(new Error(evt.error))
          }
        }
      })
    })
  })()

  return {
    promise,
    cancel: () => {
      // REQ-0244 — the pre-existing bug this REQ fixes: cancel() used
      // to `unsub()` before invoking the main-side cancel, so the
      // 'failed' event fired by main's abort landed on nobody and the
      // inner promise hung forever.  A caller doing `await run.promise`
      // (e.g. font-picker's batch loop) then stalled, and the batch
      // button never reappeared.  We now leave the subscription
      // attached — main's cancel path will emit `{event:'failed',
      // errorCode:'aborted'}` on the channel, the subscriber calls
      // `unsub?.(); reject(...)`, and the outer promise settles.
      cancelled = true
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

  const promise = (async (): Promise<TranscriptionRunResult> => {
    const result = await window.electronAPI.transcriptionStart({
      videoPath: opts.videoPath,
      trackIndex: opts.trackIndex,
      modelId: opts.modelId,
      audioTrackCount: opts.audioTrackCount,
      modelsDir: '',   // filled in by main process
      ffmpegPath: '',  // filled in by main process
      defaults: opts.defaults,
      advanced: opts.advanced,
      // REQ-0207 — only include the key when it's actually true; the
      // sidecar service drops undefined / false anyway, but keeping it
      // out of the request object entirely means TS tests can assert on
      // an unchanged object shape for the default path.
      ...(opts.wordSubtitle === true ? { wordSubtitle: true } : {}),
    })

    if (!result.ok) throw new Error(result.error.message)

    const { channelId } = result.data

    return new Promise<TranscriptionRunResult>((resolve, reject) => {
      const unsub = window.electronAPI.subscribeToChannel(channelId, (payload) => {
        const evt = payload as TranscriptionEvent
        onEvent(evt)
        if (evt.event === 'completed') {
          unsub()
          // REQ-086 — `previewMixUrl` is on the completed event when the
          // main process generated a mix (audioTrackCount >= 2).  Older
          // main processes will not include the field, in which case we
          // surface `null` (preview falls back to <video>-only audio).
          resolve({ previewMixUrl: evt.previewMixUrl ?? null })
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
