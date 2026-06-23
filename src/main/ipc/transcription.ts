import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, rmSync, statfsSync } from 'fs'
import { join, parse } from 'path'
import { Channels } from '../../shared/ipc-channels'
import { transcribe, checkModelInstalled } from '../services/transcription-sidecar'
import { downloadModel, isModelFormatStale } from '../services/model-downloader'
import { getModelsDir, getBinPath } from '../lib/paths'
import { loadSettings, saveSettings } from '../services/settings-store'
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
  let activeModelId = settings.activeModelId ?? null

  // Migration: if activeModelId not set but whisperModel is installed, use it
  if (!activeModelId && settings.transcriptionDefaults.whisperModel) {
    const candidate = settings.transcriptionDefaults.whisperModel
    const { installed } = checkModelInstalled(candidate, modelsDir)
    if (installed) {
      activeModelId = candidate
      settings.activeModelId = candidate
      await saveSettings(settings)
    }
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

    const fullRequest: TranscriptionStartRequest = {
      ...request,
      modelsDir,
      ffmpegPath
    }

    const startedAt = Date.now()
    log.info(
      `[ipc/transcription] start: model=${request.modelId} track=${request.trackIndex} ` +
      `channelId=${channelId}`
    )

    transcribe(fullRequest, (evt) => {
      if (evt.event === 'completed') {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
        log.info(
          `[ipc/transcription] completed: model=${request.modelId} track=${request.trackIndex} ` +
          `segments=${evt.segmentCount} elapsed=${elapsedSec}s`
        )
      } else if (evt.event === 'failed') {
        log.error(`[ipc/transcription] failed: model=${request.modelId} reason=${evt.error}`)
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, evt)
      }
    }).catch((err) => {
      log.error('[ipc/transcription] error', err)
      if (!event.sender.isDestroyed()) {
        event.sender.send(channelId, { event: 'failed', error: String(err) })
      }
    })

    return { ok: true, data: { channelId } }
  })

  ipcMain.handle(Channels.transcriptionCancel, async (): Promise<void> => {
    const { terminateSidecar } = await import('../services/transcription-sidecar')
    terminateSidecar()
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
        event.sender.send(channelId, { event: 'failed', error: String(err) })
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
        // Auto-activate another installed model.  REQ-20260615-065 S-2:
        // priority order now matches the v1.3.0 ship-model line-up
        // (turbo = recommended → large-v3 = higher quality).
        const PRIORITY: WhisperModelId[] = ['large-v3-turbo', 'large-v3']
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
