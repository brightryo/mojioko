import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, rmSync, statfsSync } from 'fs'
import { join, parse } from 'path'
import { Channels } from '../../shared/ipc-channels'
import { transcribe, checkModelInstalled } from '../services/transcription-sidecar'
import { downloadModel, isModelFormatStale, DownloadError } from '../services/model-downloader'
import { generatePreviewMix } from '../services/preview-mix'
import { getModelsDir, getBinPath } from '../lib/paths'
import { loadSettings, saveSettings } from '../services/settings-store'
import { resolveActiveModelId } from '../services/resolve-active-model'
import { applyTranscriptionTierGate } from '../services/transcribe-payload'
import { isPackagedAsMsix, getCurrentProcessContext } from '../lib/msix'
import type { TranscriptionStartRequest } from '../../shared/ipc-contracts'
import type { ModelInfo, ModelStatus, ModelsState, WhisperModelId } from '../../shared/types'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

// ---------------------------------------------------------------------------
// Expected download sizes per model
// ---------------------------------------------------------------------------

// REQ-20260615-065 S-2 — v1.3.0 ship models.  turbo is listed first
// so the renderer's natural top-of-list "recommended" treatment puts
// it where the user's eye lands.  `displayName` carries the
// user-facing string; the renderer adds the "推奨" / "Recommended"
// chip itself based on `id === 'large-v3-turbo'`.
const MODEL_META: Array<{ id: WhisperModelId; displayName: string; expectedSizeBytes: number }> = [
  { id: 'large-v3-turbo', displayName: 'large-v3-turbo', expectedSizeBytes: 1_550_000_000 },
  { id: 'large-v3',       displayName: 'large-v3',       expectedSizeBytes: 3_000_000_000 },
]

function getDiskFree(dirPath: string): { freeBytes: number; drive: string } {
  const { root } = parse(dirPath)
  const drive = root || 'C:\\'
  const statPath = existsSync(dirPath) ? dirPath : (existsSync(drive) ? drive : '.')
  try {
    const stats = statfsSync(statPath)
    return { freeBytes: stats.bavail * stats.bsize, drive }
  } catch {
    return { freeBytes: 0, drive }
  }
}

async function buildModelsState(): Promise<ModelsState> {
  const modelsDir = getModelsDir()
  const settings = await loadSettings()

  // REQ-20260615-077 — reconcile `activeModelId` against the actual model
  // files on disk before trusting it.  See `resolve-active-model.ts` for
  // the full decision tree.  Two real-world failures motivate this:
  //   - MSIX installs where the OS AppData merge surfaces an NSIS
  //     install's `settings.json` (with `activeModelId='large-v3-turbo'`)
  //     into the MSIX virtualized environment whose `models/` is empty.
  //   - NSIS users who delete model files via Explorer rather than the
  //     in-app uninstall button.
  // Both end up with an `activeModelId` pointing at a model whose files
  // are absent, which used to flip REQ-072's auto-open into 'inputVideo'
  // and let `canStart` lie.  Reverting to null fixes both.
  const resolved = resolveActiveModelId(
    settings.activeModelId,
    settings.transcriptionDefaults.whisperModel,
    (id) => checkModelInstalled(id, modelsDir).installed,
  )
  const activeModelId = resolved.activeModelId
  if (resolved.source === 'corrected-null') {
    // Option A — do NOT persist this correction.  In the MSIX +
    // coexisting NSIS case the settings.json we'd write would clobber
    // the NSIS install's value on disk via the AppData merge.  The
    // log line firing each launch is the accepted cost.
    log.info(
      `[ipc/transcription] settings.activeModelId="${resolved.correctedFrom}" ` +
      `but files missing under ${modelsDir} — reverting to null (REQ-077)`,
    )
  } else if (resolved.source === 'migrated-from-whisper-model') {
    // Pre-existing v1.3.0 behavior: synthesize activeModelId from the
    // legacy `whisperModel` field for users on older settings versions.
    // Persist so the synthesis only runs once.
    settings.activeModelId = activeModelId
    await saveSettings(settings)
  }

  const { freeBytes: diskFreeBytes, drive: diskDrive } = getDiskFree(modelsDir)
  let totalUsedBytes = 0

  const models: ModelInfo[] = MODEL_META.map((meta) => {
    const { installed, sizeMB } = checkModelInstalled(meta.id, modelsDir)
    const sizeBytes = installed ? sizeMB * 1_000_000 : 0
    totalUsedBytes += sizeBytes
    const status: ModelStatus = !installed
      ? 'not-installed'
      : activeModelId === meta.id ? 'active' : 'installed'

    // REQ-20260615-065 S-6 — log-only stale-format detection.  Pre-
    // v1.3.0 downloads lack a meta file and are NOT flagged (Phase 0
    // confirmed Systran CT2 layout is unchanged from fw 1.0.3).  Only
    // meta files whose `formatGeneration` is strictly below the
    // current constant surface here, and only via the main-process
    // log — there is no UI prompt in v1.3.0.
    if (installed) {
      const modelDir = join(modelsDir, meta.id)
      if (isModelFormatStale(modelDir)) {
        log.warn(
          `[ipc/transcription] model ${meta.id} was downloaded under an older format generation. ` +
          `Consider re-downloading from Settings -> Whisper.`
        )
      }
    }

    return {
      id: meta.id,
      displayName: meta.displayName,
      sizeBytes,
      expectedSizeBytes: meta.expectedSizeBytes,
      status
    }
  })

  return { models, activeModelId, totalUsedBytes, diskFreeBytes, diskDrive, modelsDir }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

// REQ-20260615-065 S-2 — the IPC-boundary allowlist is now just the
// v1.3.0 ship models.  Pre-1.3 IDs ('small' / 'medium') would already
// have been migrated to 'large-v3-turbo' by the settings-store
// hydrate pass (REQ-065 S-4) before they reach this point; a stray
// deprecated ID arriving here is treated as invalid and rejected,
// which surfaces sooner than letting it flow into a 404 download.
const VALID_MODEL_IDS: ReadonlySet<string> = new Set(['large-v3', 'large-v3-turbo'])

function assertValidModelId(modelId: unknown): asserts modelId is WhisperModelId {
  if (typeof modelId !== 'string' || !VALID_MODEL_IDS.has(modelId)) {
    throw new Error(`Invalid modelId: ${String(modelId)}`)
  }
}

// REQ-086 — module-scope registry of in-flight transcription runs so the
// `transcriptionCancel` handler can abort the preview-mix ffmpeg step in
// addition to terminating the Whisper sidecar.  Only the post-Whisper
// mix phase is represented here; the Whisper phase cancel still routes
// through `terminateSidecar()` (signal-based, no controller).
interface ActiveTranscriptionRun {
  previewMixAbort: AbortController
}
const activeRuns = new Set<ActiveTranscriptionRun>()

export function registerTranscriptionHandlers(): void {
  ipcMain.handle(Channels.transcriptionCheckModel, (_event, modelId: string): OkResult<{ installed: boolean; sizeMB: number }> | ErrResult => {
    try {
      assertValidModelId(modelId)
      const modelsDir = getModelsDir()
      const result = checkModelInstalled(modelId, modelsDir)
      return { ok: true, data: result }
    } catch (err) {
      const e = err as Error
      return { ok: false, error: { code: 'MODEL_CHECK_ERROR', message: e.message } }
    }
  })

  ipcMain.handle(Channels.transcriptionStart, async (event, request: TranscriptionStartRequest): Promise<OkResult<{ channelId: string }> | ErrResult> => {
    const channelId = `transcription:event:${randomUUID()}`
    const modelsDir = getModelsDir()
    const ffmpegPath = getBinPath('ffmpeg')

    // REQ-0210 — enforce MSIX-only paid-tier features at the IPC
    // boundary before anything else touches the request.  The renderer
    // disables the checkbox in NSIS (see `transcription-drawer.tsx`),
    // but a DevTools user could flip the local state; this main-side
    // gate strips `wordSubtitle: true` on NSIS builds so the sidecar
    // never sees the flag.  MSIX builds pass through unchanged.
    const isMsix = isPackagedAsMsix(getCurrentProcessContext())
    const gatedRequest = applyTranscriptionTierGate(request, isMsix)

    const fullRequest: TranscriptionStartRequest = {
      ...gatedRequest,
      modelsDir,
      ffmpegPath
    }

    const startedAt = Date.now()
    log.info(
      `[ipc/transcription] start: model=${request.modelId} track=${request.trackIndex} ` +
      `audioTrackCount=${request.audioTrackCount ?? 0} channelId=${channelId}`
    )

    // REQ-086 — intercept the Whisper sidecar's `completed` event so it
    // is held back until the (optional) preview-mix step also finishes.
    // The renderer therefore stays in its "transcribing" state through
    // both Whisper and the audio-mix pass, and a failure in either
    // surfaces as a single `failed` event (no degraded mode).
    const audioTrackCount = request.audioTrackCount ?? 0
    const needsPreviewMix = audioTrackCount >= 2
    let whisperCompletedSegments: number | null = null

    // AbortController for the post-Whisper preview-mix ffmpeg run.
    // Registered into `activeRuns` so the existing transcriptionCancel
    // handler can abort the mix as well as the sidecar.
    const mixAbort = new AbortController()
    const runHandle: ActiveTranscriptionRun = {
      previewMixAbort: mixAbort,
    }
    activeRuns.add(runHandle)

    const finish = () => {
      activeRuns.delete(runHandle)
    }

    transcribe(fullRequest, (evt) => {
      if (evt.event === 'failed') {
        log.error(`[ipc/transcription] failed (whisper): model=${request.modelId} reason=${evt.error}`)
      }
      if (evt.event === 'completed') {
        // Hold the event; emit later after preview-mix is done.
        whisperCompletedSegments = evt.segmentCount
        return
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, evt)
      }
    }).then(async () => {
      // Whisper succeeded.  If a preview mix is needed, run it now.
      if (whisperCompletedSegments === null) {
        // Defensive: transcribe() resolved without a `completed` event
        // (should not happen, but guard against shape changes in the
        // sidecar protocol).  Treat as failure.
        if (!event.sender.isDestroyed()) {
          event.sender.send(channelId, {
            event: 'failed',
            error: 'Sidecar resolved without a completed event',
          })
        }
        return
      }

      let previewMixUrl: string | null = null
      if (needsPreviewMix) {
        if (!event.sender.isDestroyed()) {
          event.sender.send(channelId, { event: 'phase', phase: 'preview-mix' })
        }
        try {
          await generatePreviewMix(
            { inputPath: request.videoPath, audioTrackCount },
            mixAbort.signal,
          )
          previewMixUrl = `mojioko-preview-mix://current?t=${Date.now()}`
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          log.error(`[ipc/transcription] failed (preview-mix): model=${request.modelId} reason=${reason}`)
          if (!event.sender.isDestroyed()) {
            // Cancelled mid-mix surfaces the same sentinel string the
            // sidecar uses for user-initiated cancels, so the renderer's
            // existing `String(err).includes('Cancelled')` check fires.
            const isCancel = reason === 'Cancelled'
            event.sender.send(channelId, {
              event: 'failed',
              error: isCancel
                ? 'Cancelled'
                : `Preview audio generation failed: ${reason}`,
            })
          }
          return
        }
      }

      const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
      log.info(
        `[ipc/transcription] completed: model=${request.modelId} track=${request.trackIndex} ` +
        `segments=${whisperCompletedSegments} previewMix=${previewMixUrl !== null} elapsed=${elapsedSec}s`
      )
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, {
          event: 'completed',
          segmentCount: whisperCompletedSegments,
          previewMixUrl,
        })
      }
    }).catch((err) => {
      log.error('[ipc/transcription] error', err)
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, { event: 'failed', error: String(err) })
      }
    }).finally(finish)

    return { ok: true, data: { channelId } }
  })

  ipcMain.handle(Channels.transcriptionCancel, async (): Promise<void> => {
    // REQ-0219 — cancel now goes through `cancelTranscription`, which
    // (a) settles the in-flight `transcribe()` promise with the
    // shared `'Cancelled'` sentinel so the parent chain's `.finally`
    // fires and `activeRuns` cleans up, and (b) uses the SIGKILL-
    // escalating `terminateSidecarAndWait` so a hung sidecar that
    // ignores `SIGTERM` still dies within the 3-second deadline.
    // The old `terminateSidecar()` path fired SIGTERM only and left
    // the parent promise pending indefinitely.
    const { cancelTranscription } = await import('../services/transcription-sidecar')
    await cancelTranscription()
    // REQ-086 — also abort any in-flight preview-mix ffmpeg run.  The
    // mix runs AFTER the Whisper sidecar exits, so a user pressing
    // Cancel during the audio-mix phase needs this second signal too;
    // `cancelTranscription` alone would leave ffmpeg running.
    for (const run of activeRuns) {
      run.previewMixAbort.abort()
    }
  })

  const activeDownloads = new Map<string, AbortController>()

  ipcMain.handle(Channels.transcriptionDownloadModel, async (event, modelId: string): Promise<OkResult<{ channelId: string }> | ErrResult> => {
    try { assertValidModelId(modelId) } catch (err) {
      return { ok: false, error: { code: 'INVALID_MODEL_ID', message: (err as Error).message } }
    }
    const channelId = `transcription:download:${randomUUID()}`
    const controller = new AbortController()
    activeDownloads.set(channelId, controller)

    const modelsDir = getModelsDir()
    log.info(`[ipc/transcription] downloadModel ${modelId}, channelId=${channelId}`)

    downloadModel(modelId, modelsDir, (evt) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, evt)
      }
    }, controller.signal).catch((err) => {
      log.error('[ipc/transcription] downloadModel error', err)
      if (!event.sender.isDestroyed()) {
        // REQ-20260615-081 — carry the typed code on the IPC payload so
        // the renderer can localize without re-parsing the message
        // string.  Non-DownloadError throws (e.g., unexpected bugs)
        // surface as `fatal` with the raw message — matches the v1.3.1
        // toast wording so a regression is visually loud.
        const errorCode = err instanceof DownloadError ? err.code : 'fatal'
        const inner = err instanceof DownloadError ? err.inner : err
        const innerMsg = inner instanceof Error ? inner.message : String(inner)
        event.sender.send(channelId, {
          event: 'failed',
          error: innerMsg,
          errorCode,
        })
      }
    }).finally(() => {
      activeDownloads.delete(channelId)
    })

    return { ok: true, data: { channelId } }
  })

  ipcMain.handle(`${Channels.transcriptionDownloadModel}:cancel`, (_event, channelId: string): void => {
    activeDownloads.get(channelId)?.abort()
    activeDownloads.delete(channelId)
  })

  // ---- New model management handlers ----

  ipcMain.handle(Channels.transcriptionListModels, async (): Promise<OkResult<ModelsState> | ErrResult> => {
    try {
      const state = await buildModelsState()
      return { ok: true, data: state }
    } catch (err) {
      const e = err as Error
      log.error('[ipc/transcription] listModels error', err)
      return { ok: false, error: { code: 'LIST_MODELS_ERROR', message: e.message } }
    }
  })

  ipcMain.handle(Channels.transcriptionUninstallModel, async (_event, modelId: WhisperModelId): Promise<OkResult<ModelsState> | ErrResult> => {
    try {
      assertValidModelId(modelId)
      const modelsDir = getModelsDir()
      const modelDir = join(modelsDir, modelId)

      if (existsSync(modelDir)) {
        rmSync(modelDir, { recursive: true, force: true })
        log.info(`[ipc/transcription] uninstalled model ${modelId}`)
      }

      const settings = await loadSettings()
      if (settings.activeModelId === modelId) {
        // Auto-activate another installed model.  REQ-20260615-066:
        // priority order now reads large-v3 → turbo, matching the
        // user-facing "recommended" mark.  This keeps the auto-
        // activated next-model consistent with whichever line the
        // user sees badged in the UI.
        const PRIORITY: WhisperModelId[] = ['large-v3', 'large-v3-turbo']
        let next: WhisperModelId | null = null
        for (const candidate of PRIORITY) {
          if (candidate !== modelId) {
            const { installed } = checkModelInstalled(candidate, modelsDir)
            if (installed) { next = candidate; break }
          }
        }
        settings.activeModelId = next
        settings.transcriptionDefaults = { ...settings.transcriptionDefaults, whisperModel: next ?? settings.transcriptionDefaults.whisperModel }
      }
      await saveSettings(settings)

      const state = await buildModelsState()
      return { ok: true, data: state }
    } catch (err) {
      const e = err as Error
      log.error('[ipc/transcription] uninstallModel error', err)
      return { ok: false, error: { code: 'UNINSTALL_ERROR', message: e.message } }
    }
  })

  ipcMain.handle(Channels.transcriptionSetActiveModel, async (_event, modelId: WhisperModelId): Promise<OkResult<ModelsState> | ErrResult> => {
    try {
      assertValidModelId(modelId)
      const modelsDir = getModelsDir()
      const { installed } = checkModelInstalled(modelId, modelsDir)
      if (!installed) {
        return { ok: false, error: { code: 'NOT_INSTALLED', message: `Model ${modelId} is not installed` } }
      }

      const settings = await loadSettings()
      settings.activeModelId = modelId
      settings.transcriptionDefaults = { ...settings.transcriptionDefaults, whisperModel: modelId }
      await saveSettings(settings)

      log.info(`[ipc/transcription] setActiveModel → ${modelId}`)
      const state = await buildModelsState()
      return { ok: true, data: state }
    } catch (err) {
      const e = err as Error
      log.error('[ipc/transcription] setActiveModel error', err)
      return { ok: false, error: { code: 'SET_ACTIVE_ERROR', message: e.message } }
    }
  })

}
