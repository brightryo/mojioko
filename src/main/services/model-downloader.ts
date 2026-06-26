import { mkdirSync, createWriteStream, unlinkSync, rmSync } from 'fs'
import { join } from 'path'
import type { DownloadModelEvent } from '../../shared/ipc-contracts'
import { writeModelMeta } from './model-meta'
import { MODEL_FORMAT_GENERATION } from '../../shared/constants'
import {
  checkModelInstalled,
  isModelDirIncomplete,
  MODEL_FILES,
  DEFAULT_MODEL_FILES,
} from './check-model-installed'
import log from '../lib/logger'

// REQ-20260615-065 S-6 — re-export the pure meta helpers from
// `./model-meta` so existing callers (transcription IPC, etc.) keep
// importing from `model-downloader` without changing their import
// paths.  The implementation lives in `model-meta.ts` to keep it
// vitest-friendly (no electron / logger deps).
export type { ModelMeta } from './model-meta'
export { readModelMeta, isModelFormatStale } from './model-meta'

// REQ-20260615-078 — re-export the strict installed-check so existing
// `checkModel` callers in `model-downloader` keep their import path
// unchanged.  The actual implementation lives in
// `check-model-installed.ts`; this file owns the download pipeline.
export type ModelInfo = { installed: boolean; sizeMB: number }
export const checkModel = checkModelInstalled

// REQ-20260615-065 S-2 — per-model HuggingFace repo path.  Pre-1.3.0
// every model lived under `Systran/faster-whisper-${id}`, but Systran
// never published a CT2 conversion of large-v3-turbo, so v1.3.0
// resolves the turbo bits from the de-facto community mirror
// `mobiuslabsgmbh/faster-whisper-large-v3-turbo` (MIT, ~1.4M
// downloads, same 5-file layout as Systran/large-v3 — Phase 0 RES).
// Future model migrations should change this map ONLY, never the
// downloader call sites.
const MODEL_REPOS: Record<string, string> = {
  'large-v3':       'Systran/faster-whisper-large-v3',
  'large-v3-turbo': 'mobiuslabsgmbh/faster-whisper-large-v3-turbo',
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal
): Promise<void> {
  const resp = await fetch(url, { signal, redirect: 'follow' })

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} fetching ${new URL(url).pathname.split('/').pop()}`)
  }

  const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10)
  const dest = createWriteStream(destPath)

  let received = 0
  if (!resp.body) throw new Error(`No response body for ${url}`)
  const reader = resp.body.getReader()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      dest.write(value)
      received += value.length
      if (contentLength > 0) onProgress(received, contentLength)
    }
    await new Promise<void>((res, rej) => dest.end((err: Error | null | undefined) => (err ? rej(err) : res())))
  } catch (err) {
    dest.destroy()
    try { unlinkSync(destPath) } catch { /* ignore */ }
    throw err
  } finally {
    reader.releaseLock()
  }

  // C-3 integrity check: bytes received vs Content-Length, ±10 % tolerance.
  // Catches the truncated-download case where the server reported a length
  // but the stream ended early (proxy hiccup, dropped connection mid-read).
  // Models without Content-Length skip the check — HuggingFace always emits
  // it for these files in practice.
  if (contentLength > 0 && Math.abs(received - contentLength) > contentLength * 0.1) {
    try { unlinkSync(destPath) } catch { /* ignore */ }
    throw new Error(`Truncated download for ${url}: received ${received} / ${contentLength}`)
  }
}

export async function downloadModel(
  modelId: string,
  modelsDir: string,
  onEvent: (evt: DownloadModelEvent) => void,
  signal: AbortSignal
): Promise<void> {
  const modelDir = join(modelsDir, modelId)

  // REQ-20260615-078 — wipe any prior incomplete directory before
  // (re)creating it.  A force-killed download in v1.3.1 left a GB-
  // scale partial `model.bin` plus the small files behind; the next
  // download attempt would otherwise reuse those leftovers in-place,
  // and CT2's whole-file layout cannot recover from a mid-file
  // resume.  A clean slate guarantees the resulting dir matches what
  // `checkModelInstalled` accepts when the run finishes.  We only
  // delete when the directory is INCOMPLETE — a fully-installed dir
  // is left alone so a redundant "install" call (race condition,
  // double-click) does not wipe a working model.
  if (isModelDirIncomplete(modelsDir, modelId)) {
    log.info(`[downloader] wiping incomplete model dir ${modelDir} before re-download (REQ-078)`)
    try { rmSync(modelDir, { recursive: true, force: true }) } catch (e) {
      log.warn(`[downloader] could not wipe ${modelDir}`, e)
    }
  }
  mkdirSync(modelDir, { recursive: true })

  const files = MODEL_FILES[modelId] ?? DEFAULT_MODEL_FILES
  const repo = MODEL_REPOS[modelId]
  if (!repo) {
    throw new Error(`Unknown model id: ${modelId}`)
  }
  const baseUrl = `https://huggingface.co/${repo}/resolve/main`
  const totalFiles = files.length
  const downloadedPaths: string[] = []

  try {
    for (let i = 0; i < files.length; i++) {
      const filename = files[i]
      const url = `${baseUrl}/${filename}`
      const destPath = join(modelDir, filename)

      log.info(`[downloader] downloading ${filename} (${i + 1}/${totalFiles})`)
      onEvent({ event: 'progress', file: filename, fileIndex: i, totalFiles, percent: 0 })

      await downloadFile(
        url,
        destPath,
        (received, total) => {
          const overallPct = Math.floor(((i + received / total) / totalFiles) * 100)
          onEvent({ event: 'progress', file: filename, fileIndex: i, totalFiles, percent: overallPct })
        },
        signal
      )

      downloadedPaths.push(destPath)
    }
  } catch (err) {
    // REQ-20260615-078 — strict cleanup on any abort path.  Previously
    // we only unlinked the files we'd fully written, leaving the dir
    // itself in place (which then read as `installed: true` via the
    // legacy `existsSync` check).  Now we also `rmSync` the dir so a
    // subsequent `checkModelInstalled` returns `installed: false` even
    // before the next download attempt runs.  The dir wipe absorbs the
    // per-file unlinks but we keep them as defence in depth in case
    // `rmSync` fails partway (locked file, AV scanner).
    for (const p of downloadedPaths) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
    try { rmSync(modelDir, { recursive: true, force: true }) } catch { /* ignore */ }
    throw err
  }

  // REQ-20260615-065 S-6 — record a meta sidecar next to the weights
  // so a future format-break can be detected without forcing the user
  // to remember when each model was downloaded.  Best-effort: a write
  // failure here does NOT roll back the download itself.
  if (writeModelMeta(modelDir, modelId)) {
    log.info(`[downloader] wrote model.meta.json (id=${modelId}, generation=${MODEL_FORMAT_GENERATION})`)
  } else {
    log.warn(`[downloader] failed to write model.meta.json for ${modelId}`)
  }

  onEvent({ event: 'completed' })
}
