import { promises as fs } from 'fs'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import {
  getBinPath,
  getPreviewMixDir,
  getPreviewMixFilePath,
  generatePreviewMixFilename,
  isPreviewMixFilename,
} from '../lib/paths'
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
 *   `<getPreviewMixDir()>/preview-mix-YYYYMMDD-HHMMSS-mmm-<rand>.m4a`
 *   (REQ-0231 — unique per run).  The v1.3.2 design used the fixed
 *   name `preview-mix.m4a`, which hit EPERM on rename when the
 *   renderer's `<audio>` from the prior run was still holding the
 *   file open.  Per-run unique names take the collision out of the
 *   critical path entirely; a locked prior file simply sits in the
 *   directory until the next sweep can remove it (see
 *   `sweepPreviewMixDir` below).
 *
 * Crash safety:
 *
 *   ffmpeg writes to `<filename>.m4a.tmp` first; we `fs.rename` only
 *   on exit code 0.  A force-quit during generation leaves the `.tmp`
 *   behind; the next call to `generatePreviewMix` sweeps it up (along
 *   with any prior finalised `.m4a`).  Boot-time cleanup
 *   (`cleanupStalePreviewMixTmp`) also sweeps at app start.
 *
 * Cancellation:
 *
 *   The `AbortSignal` is propagated by killing the ffmpeg process.  On
 *   abort we still attempt to clean up the `.tmp` so the orphan does
 *   not persist (defence in depth — the next-run sweep would handle it
 *   anyway).
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
  /** REQ-0231 — bare filename for the renderer's URL construction. */
  filename: string
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

  const outputDir = getPreviewMixDir()

  // Ensure the directory exists.  Synchronous mkdir is fine here — the
  // path lives under %APPDATA% (or its MSIX virtualised equivalent) and
  // mkdir is cheap.
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true })
  }

  // REQ-0231 — sweep prior runs BEFORE choosing the new filename so
  // this run's output is guaranteed not to be swept away by itself.
  // Best-effort: locked files (Windows EPERM from a still-playing
  // `<audio>`) are skipped and left to the next sweep.
  const sweep = sweepPreviewMixDir()
  if (sweep.removed || sweep.skipped) {
    log.info(
      `[preview-mix] sweep before generation: removed=${sweep.removed} ` +
      `skipped=${sweep.skipped} (skipped = still-locked previous mix; ` +
      `will retry on next run)`,
    )
  }

  const filename = generatePreviewMixFilename()
  const outputPath = getPreviewMixFilePath(filename)
  const tmpPath = outputPath + '.tmp'

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
  // Historical context (pre-REQ-0231): under the fixed-filename design,
  // this rename occasionally hit EPERM when the renderer's `<audio>`
  // from the previous run still held the old `preview-mix.m4a` open,
  // or when ffmpeg's kernel-level handle drop lagged the stdio close.
  // The 100ms → 200ms → 400ms backoff sometimes broke through, but
  // the `<audio>`-held case could persist much longer than 700 ms and
  // still surfaced as a user-visible transcription failure.
  //
  // REQ-0231 removed the `<audio>`-held root cause by giving every run
  // its own unique filename, so this rename now targets a path that
  // no prior process has ever opened.  The retry stays as belt-and-
  // braces for the ffmpeg-side handle-lag case (still possible on
  // Windows) and for the vanishingly rare case where two runs pick
  // the same random suffix within the same millisecond.
  await renameWithRetry(tmpPath, outputPath)

  const stat = await fs.stat(outputPath)
  log.info(
    `[preview-mix] completed: ${outputPath} (${(stat.size / 1_000_000).toFixed(1)} MB)`,
  )
  return { outputPath, filename, sizeBytes: stat.size }
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
 * REQ-0231 — sweep the preview-mix directory of prior-run files.
 *
 * Best-effort: any file whose delete throws (typically Windows EPERM
 * from a still-playing `<audio>` handle in this or another process)
 * is logged and skipped.  The critical path — generating THIS run's
 * mix — MUST NOT be gated on the sweep succeeding, so the caller
 * ignores the return value; it exists for logging only.
 *
 * Only files matching `isPreviewMixFilename` are considered.  This
 * includes:
 *  - `preview-mix.m4a` and `preview-mix.m4a.tmp` (legacy REQ-086 shape)
 *  - `preview-mix-YYYYMMDD-HHMMSS-mmm-<rand>.m4a(.tmp)` (REQ-0231 shape)
 *
 * Anything else (unexpected files a user may have dropped in) is left
 * alone — the sweep is not authorised to touch non-preview-mix files.
 */
export function sweepPreviewMixDir(): { removed: number; skipped: number } {
  const dir = getPreviewMixDir()
  if (!existsSync(dir)) return { removed: 0, skipped: 0 }
  let removed = 0
  let skipped = 0
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch (err) {
    log.warn(`[preview-mix] sweep: could not read dir ${dir}: ${String(err)}`)
    return { removed: 0, skipped: 0 }
  }
  for (const name of entries) {
    if (!isPreviewMixFilename(name)) continue
    try {
      rmSync(join(dir, name), { force: true })
      removed++
    } catch (err) {
      log.warn(`[preview-mix] sweep: could not remove ${name}: ${String(err)}`)
      skipped++
    }
  }
  return { removed, skipped }
}

/**
 * Boot-time cleanup — sweep the preview-mix directory of any leftover
 * files (`.tmp` from a force-quit mid-generation, prior-run `.m4a`s
 * whose next-run sweep never happened because the app was closed
 * before the next transcription, or REQ-086 legacy fixed-name files
 * from a pre-upgrade install).
 *
 * Name kept for backward compatibility with `src/main/index.ts`; the
 * body is now the same directory sweep as the per-run one so that
 * `.m4a` remnants don't accumulate indefinitely on installs that
 * frequently launch and close without transcribing.
 */
export function cleanupStalePreviewMixTmp(): void {
  const result = sweepPreviewMixDir()
  if (result.removed || result.skipped) {
    log.info(
      `[preview-mix] boot sweep: removed=${result.removed} skipped=${result.skipped}`,
    )
  }
}
