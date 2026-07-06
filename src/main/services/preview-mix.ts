import { promises as fs } from 'fs'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { dirname } from 'path'
import { spawn } from 'child_process'
import { getBinPath, getPreviewMixDir, getPreviewMixPath, getPreviewMixTmpPath } from '../lib/paths'
import { buildAmixAudioFilter } from './preview-mix-filter'
import { renameWithRetryInternal, defaultWait } from './rename-with-retry'
import { FfmpegError } from '../../shared/errors'
import log from '../lib/logger'

/**
 * REQ-086 — pre-generate a multi-track preview audio file.
 *
 * Why pre-generated and not on-the-fly:
 *
 *   Chromium's `<video>` plays exactly ONE audio track from a multi-
 *   audio container — the container's default track.  For a configuration
 *   like "Track 0 = game audio, Track 1 = mic" the user hears only Track
 *   0 in the editor preview, even though the burn-in (which uses
 *   `ffmpeg-burnin.ts`'s amix path) correctly mixes both.  This file is
 *   loaded into a hidden `<audio>` element that the renderer synchronises
 *   against `<video muted>`, restoring "what you hear in preview = what
 *   you get on burn-in" parity.
 *
 * Output shape:
 *
 *   - Full-length AAC LC at 192 kbps in an M4A (mp4) container.
 *   - `-vn` (no video) keeps the file small — typical 1h clip ≈ 85 MB.
 *   - `-movflags +faststart` so `<audio>` can begin playback before the
 *     whole file is fetched.
 *   - `amix=inputs=N:duration=longest:normalize=0` — same filter shape
 *     used by `ffmpeg-burnin.ts`'s simple audio mode, so the preview
 *     mix is the same mix the user will hear on burn-in.
 *
 * Output path:
 *
 *   `<getPreviewMixDir()>/preview-mix.m4a` — fixed file name, always
 *   overwritten in place.  Never one-file-per-video, so the directory
 *   never grows beyond a single mix.
 *
 * Crash safety:
 *
 *   ffmpeg writes to `preview-mix.m4a.tmp` first; we `fs.rename` only on
 *   exit code 0.  A force-quit during generation leaves the `.tmp`
 *   behind and the prior finalised `.m4a` intact (or absent if this was
 *   the first run) — the next transcription run will overwrite both.
 *   Boot-time cleanup (`cleanupStalePreviewMixTmp`) removes the orphan.
 *
 * Cancellation:
 *
 *   The `AbortSignal` is propagated by killing the ffmpeg process.  On
 *   abort we still attempt to clean up the `.tmp` so the orphan does
 *   not persist (defence in depth — `cleanupStalePreviewMixTmp` would
 *   handle it on the next boot anyway).
 *
 * Caller contract:
 *
 *   - Skip the call entirely when `audioTrackCount < 2`.  N <= 1 needs
 *     no mix (the single track is what `<video>` plays anyway).
 *   - On rejection, treat the WHOLE transcription run as failed.
 *     `ipc/transcription.ts` does this by letting the rejection bubble
 *     up into the existing `failed` event path; the renderer's toast
 *     pipeline does not need to know about preview-mix vs whisper.
 */
export interface GeneratePreviewMixOptions {
  inputPath: string
  audioTrackCount: number
}

export interface GeneratePreviewMixResult {
  outputPath: string
  sizeBytes: number
}

export async function generatePreviewMix(
  opts: GeneratePreviewMixOptions,
  signal: AbortSignal,
): Promise<GeneratePreviewMixResult> {
  const { inputPath, audioTrackCount } = opts
  if (audioTrackCount < 2) {
    throw new Error(`generatePreviewMix: audioTrackCount must be >= 2 (was ${audioTrackCount})`)
  }

  const outputPath = getPreviewMixPath()
  const tmpPath = getPreviewMixTmpPath()
  const outputDir = dirname(outputPath)

  // Ensure the directory exists.  Synchronous mkdir is fine here — the
  // path lives under %APPDATA% (or its MSIX virtualised equivalent) and
  // mkdir is cheap.
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }
  // Defensive: a leftover .tmp from a prior crashed run would confuse the
  // rename step.  Remove it before we start writing.
  if (existsSync(tmpPath)) {
    try {
      rmSync(tmpPath, { force: true })
    } catch (err) {
      log.warn(`[preview-mix] could not remove stale tmp ${tmpPath}: ${String(err)}`)
    }
  }

  const amix = buildAmixAudioFilter(audioTrackCount)
  const ffmpeg = getBinPath('ffmpeg')

  const args = [
    '-y',
    '-i', inputPath,
    '-filter_complex', amix.filterComplex,
    '-vn',
    ...amix.mapArgs,
    ...amix.codecArgs,
    '-movflags', '+faststart',
    '-f', 'mp4',
    tmpPath,
  ]

  log.info(
    `[preview-mix] start: ${inputPath} (${audioTrackCount} tracks) → ${tmpPath}`,
  )
  log.debug(`[preview-mix] argv: ${ffmpeg} ${args.join(' ')}`)

  await new Promise<void>((resolve, reject) => {
    // REQ-0103 — explicit `shell: false` (see ffmpeg-burnin.ts for rationale).
    const proc = spawn(ffmpeg, args, { shell: false })
    let wasAborted = false
    let stderrAccum = ''

    const onAbort = () => {
      wasAborted = true
      proc.kill()
    }
    signal.addEventListener('abort', onAbort, { once: true })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrAccum += chunk.toString()
    })

    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (wasAborted) {
        // Best-effort cleanup of the (partial) tmp.
        try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
        reject(new FfmpegError('Cancelled'))
        return
      }
      if (code !== 0) {
        try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
        const tail = stderrAccum.slice(-600)
        log.error(`[preview-mix] failed (code ${code}): ${tail}`)
        reject(new FfmpegError(`ffmpeg exited with code ${code}`, { stderr: tail }))
        return
      }
      resolve()
    })

    proc.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      try { rmSync(tmpPath, { force: true }) } catch { /* ignore */ }
      log.error('[preview-mix] spawn error', err)
      reject(new FfmpegError(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })

  // REQ-0129 Phase 1 — atomic rename with EPERM / EACCES backoff retry.
  //
  // Symptom (RES-0119 §1): on MSIX Windows, multi-track transcription
  // occasionally fails at this exact rename with EPERM.  App restart
  // clears it, which points at a lingering file handle — either ffmpeg
  // has not fully released `.tmp` when `close` fires (kernel-level
  // handle drop lags the stdio close event on Windows), or the
  // renderer's hidden `<audio>` element is still holding the previous
  // `preview-mix.m4a` open when rename tries to overwrite it.
  //
  // The renderer side already loads via a cache-busting query string
  // (`mojioko-preview-mix://?t=<timestamp>`, per RES-0102) so Chromium
  // is nudged to release the old handle when a new URL lands.  But
  // both windows leave a small race, so we belt-and-braces here with
  // an exponential backoff: 100ms → 200ms → 400ms.  Kernel handle
  // release on Windows is typically < 300ms.
  await renameWithRetry(tmpPath, outputPath)

  const stat = await fs.stat(outputPath)
  log.info(
    `[preview-mix] completed: ${outputPath} (${(stat.size / 1_000_000).toFixed(1)} MB)`,
  )
  return { outputPath, sizeBytes: stat.size }
}

/**
 * REQ-0129 Phase 1 — thin wrapper around the pure `renameWithRetryInternal`
 * that plugs in `fs.rename`, the default setTimeout-based waiter, and
 * routes retry attempts into the app logger.  See `rename-with-retry.ts`
 * for the retry-ladder rationale and the retry-worthy code set.
 */
async function renameWithRetry(src: string, dst: string): Promise<void> {
  try {
    await renameWithRetryInternal(src, dst, fs.rename, defaultWait, (attempt, delayMs, err) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN'
      log.warn(
        `[preview-mix] rename ${src} → ${dst} attempt ${attempt} hit ${code}; ` +
        `retrying after ${delayMs}ms`,
      )
    })
  } catch (err) {
    log.error(`[preview-mix] rename ${src} → ${dst} failed after retries: ${String(err)}`)
    try { rmSync(src, { force: true }) } catch { /* ignore */ }
    throw new FfmpegError(`Failed to finalise preview mix: ${String(err)}`)
  }
}

/**
 * Boot-time cleanup — remove a `.tmp` left behind by a force-quit during
 * a prior preview-mix generation.  The finalised `.m4a` is left in place;
 * it is the most recent successfully-generated mix, and a fresh
 * transcription run will overwrite it via `fs.rename` anyway.
 */
export function cleanupStalePreviewMixTmp(): void {
  const tmpPath = getPreviewMixTmpPath()
  if (existsSync(tmpPath)) {
    try {
      rmSync(tmpPath, { force: true })
      log.info(`[preview-mix] cleaned stale tmp at boot: ${tmpPath}`)
    } catch (err) {
      log.warn(`[preview-mix] could not clean stale tmp ${tmpPath}: ${String(err)}`)
    }
  }
  // Touch the dir lazily — no need to mkdir at boot; generatePreviewMix
  // will create it on first use.  This avoids cluttering the AppData
  // tree on installs where the user never runs a multi-track video.
  void getPreviewMixDir
}
