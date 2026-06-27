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
import {
  MAX_DOWNLOAD_ATTEMPTS,
  classifyDownloadError,
  toErrorCode,
  shouldRetry,
  nextBackoffMs,
  type DownloadErrorCode,
} from './download-retry'
import log from '../lib/logger'

/**
 * REQ-20260615-081 — typed error the downloader throws on permanent
 * failure (abort or retries exhausted).  The IPC layer reads `.code`
 * to populate the renderer's localized toast without re-classifying
 * the underlying network error.  `inner` carries the original error
 * message for log files / bug reports.
 */
export class DownloadError extends Error {
  readonly code: DownloadErrorCode
  readonly inner: unknown
  constructor(code: DownloadErrorCode, inner: unknown) {
    const innerMsg = inner instanceof Error ? inner.message : String(inner)
    super(`DownloadError(${code}): ${innerMsg}`)
    this.name = 'DownloadError'
    this.code = code
    this.inner = inner
  }
}

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

/**
 * REQ-20260615-081 — download a single file with HTTP Range resume
 * and a bounded exponential-backoff retry loop.
 *
 * Behaviour:
 *
 *   - First attempt: fetch without a Range header; open destination
 *     in write mode (truncate).  `received` starts at 0.
 *
 *   - Mid-stream failure: classify the error.  If transient AND the
 *     retry budget is not exhausted AND the signal is not aborted,
 *     sleep ({@link nextBackoffMs}), then reissue with
 *     `Range: bytes=<received>-`.  The destination is reopened in
 *     append mode so previously-received bytes survive across retries
 *     (the central REQ-081 contract: "session-scoped resume").
 *
 *   - Range response handling: `206 Partial Content` → append bytes
 *     onto the existing partial (the normal resume path).  `200 OK` →
 *     server ignored Range; truncate and restart from zero (rare; the
 *     log line surfaces it).  Any other non-2xx → fatal, no retry.
 *
 *   - Abort (user cancel): throw a `DownloadError('aborted', ...)`
 *     without sleeping.  Cleanup of the partial file happens at the
 *     outer `downloadModel` catch block alongside the REQ-078
 *     directory wipe.
 *
 *   - Retries exhausted: throw a `DownloadError` whose code reflects
 *     the LAST attempt's classification (`network` for transient,
 *     `fatal` for anything else).  Outer catch wipes the dir.
 *
 *   - Content-Length integrity check: kept from v1.3.1 (±10 %
 *     tolerance) and runs against the cumulative `received` after
 *     the loop returns success, so a truncated resume is still
 *     caught.  Failure throws fatal (no further retry — we don't
 *     have a way to know the server is misbehaving vs we are).
 */
/**
 * Exported for `tests/unit/download-file.test.ts` (REQ-081 retry +
 * Range resume integration coverage).  Not part of the public IPC
 * surface — production callers go through `downloadModel`.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
  signal: AbortSignal
): Promise<void> {
  // Persistent state across retries within a single downloadFile call.
  // Survives reopen of the dest stream; the next attempt reissues
  // `Range: bytes=${received}-` so the server picks up where we left
  // off and we append onto the existing on-disk partial.
  let received = 0
  let contentLengthTotal = 0
  let attempt = 0
  let lastErr: unknown = null

  while (attempt < MAX_DOWNLOAD_ATTEMPTS) {
    attempt++

    if (signal.aborted) {
      throw new DownloadError('aborted', new Error('Cancelled'))
    }

    const isResume = received > 0
    const headers: Record<string, string> = {}
    if (isResume) headers['Range'] = `bytes=${received}-`

    let resp: Response
    try {
      resp = await fetch(url, { signal, redirect: 'follow', headers })
    } catch (err) {
      lastErr = err
      const cls = classifyDownloadError(err)
      if (cls === 'abort') throw new DownloadError('aborted', err)
      if (shouldRetry(attempt, cls)) {
        const sleep = nextBackoffMs(attempt)
        log.warn(
          `[downloader] fetch failed for ${url} (attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}, ` +
          `received=${received}B): ${err instanceof Error ? err.message : String(err)} — ` +
          `retrying in ${sleep}ms`,
        )
        await delay(sleep, signal)
        continue
      }
      throw new DownloadError(toErrorCode(cls), err)
    }

    if (!resp.ok && resp.status !== 206) {
      // 4xx / 5xx are fatal — a renamed model URL, an auth requirement,
      // or sustained server outage all live here.  No retry.
      throw new DownloadError('fatal', new Error(
        `HTTP ${resp.status} fetching ${new URL(url).pathname.split('/').pop()}`,
      ))
    }

    // 206 Partial Content: server honoured Range → keep `received`
    // and append bytes.
    // 200 OK with isResume=true: server ignored Range → reset
    // `received` to 0 and truncate the file.  Log so we notice
    // surprise behaviour (HF in practice always honours Range).
    let resumeMode: 'append' | 'truncate'
    if (isResume) {
      if (resp.status === 206) {
        resumeMode = 'append'
        log.info(`[downloader] resuming ${url} from byte ${received} (attempt ${attempt})`)
      } else {
        log.warn(
          `[downloader] ${url} returned HTTP ${resp.status} instead of 206 on Range request — ` +
          `server ignored Range, restarting from zero`,
        )
        received = 0
        resumeMode = 'truncate'
      }
    } else {
      resumeMode = 'truncate'
    }

    const cl = parseInt(resp.headers.get('content-length') ?? '0', 10)
    if (cl > 0) {
      // For 206 the Content-Length describes the REMAINING bytes (the
      // range we asked for).  Total = already-received + range size.
      // For 200 it describes the whole body.
      contentLengthTotal = resumeMode === 'append' ? received + cl : cl
    }

    if (!resp.body) {
      throw new DownloadError('fatal', new Error(`No response body for ${url}`))
    }

    const dest = createWriteStream(destPath, {
      flags: resumeMode === 'append' ? 'a' : 'w',
    })
    const reader = resp.body.getReader()

    let streamError: unknown = null
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        dest.write(value)
        received += value.length
        if (contentLengthTotal > 0) onProgress(received, contentLengthTotal)
      }
      await new Promise<void>((res, rej) =>
        dest.end((err: Error | null | undefined) => (err ? rej(err) : res())),
      )
    } catch (err) {
      streamError = err
      // `dest.write(value)` returns sync but the underlying disk write
      // is queued.  If we `destroy()` here while writes are still in
      // flight, those writes reject async with ERR_STREAM_DESTROYED.
      // `end()` flushes the queue first, then closes — so the partial
      // bytes already on disk survive into the retry, which is exactly
      // what the Range resume relies on.
      await new Promise<void>((resolve) => {
        dest.end(() => resolve())
      }).catch(() => { /* ignore secondary close errors */ })
    } finally {
      try { reader.releaseLock() } catch { /* ignore */ }
    }

    if (streamError !== null) {
      lastErr = streamError
      const cls = classifyDownloadError(streamError)
      if (cls === 'abort') throw new DownloadError('aborted', streamError)
      if (shouldRetry(attempt, cls)) {
        const sleep = nextBackoffMs(attempt)
        log.warn(
          `[downloader] stream interrupted for ${url} ` +
          `(attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}, received=${received}B): ` +
          `${streamError instanceof Error ? streamError.message : String(streamError)} — ` +
          `retrying in ${sleep}ms with Range resume`,
        )
        await delay(sleep, signal)
        continue
      }
      throw new DownloadError(toErrorCode(cls), streamError)
    }

    // Stream finished cleanly.  Verify the Content-Length sanity
    // gate before declaring success.  The ±10 % tolerance is held
    // over from v1.3.1; HF in practice matches exactly.
    if (contentLengthTotal > 0 && Math.abs(received - contentLengthTotal) > contentLengthTotal * 0.1) {
      throw new DownloadError('fatal', new Error(
        `Truncated download for ${url}: received ${received} / ${contentLengthTotal}`,
      ))
    }

    return
  }

  // While-loop fell through without returning — retries exhausted.
  // This is unreachable in practice because the loop body throws
  // when retries are exhausted, but TypeScript can't prove it.
  const cls = lastErr === null ? 'fatal' : classifyDownloadError(lastErr)
  throw new DownloadError(toErrorCode(cls), lastErr ?? new Error('Retries exhausted'))
}

/**
 * AbortSignal-aware sleep used for backoff between download retries.
 * Resolves on timeout or rejects (with the abort reason) when the
 * signal fires mid-sleep — so a user cancel during the backoff window
 * is honoured without waiting for the timeout to elapse.
 */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(new DownloadError('aborted', new Error('Cancelled')))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort)
  })
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
