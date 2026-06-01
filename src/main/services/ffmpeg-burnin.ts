import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { getBinPath, getFontResolveDir } from '../lib/paths'
import { generateAss } from './ass-generator'
import { getBestEncoder, buildEncoderArgs } from './encoder-detector'
import { getFontMeta, DEFAULT_FONT_ID, isFontId } from '../../shared/fonts'
import type { BurninStartRequest, BurninEvent } from '../../shared/ipc-contracts'
import { FfmpegError } from '../../shared/errors'
import log from '../lib/logger'

export type BurninEventCallback = (event: BurninEvent) => void

/** Escape a Windows path for use in ffmpeg's subtitles= filter value. */
function escapeAssPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

export async function startBurnin(
  request: BurninStartRequest,
  onEvent: BurninEventCallback,
  signal: AbortSignal
): Promise<void> {
  const { inputPath, outputPath, entries, video, burnin, encoderSetting, audioMode, fadeDurationSec, subtitleBackground, outputContainer, fontId } = request

  // Resolve font choice.  Defensive: an unknown / missing fontId falls back
  // to the bundled default so a stale renderer never blocks a burn-in.
  const resolvedFontId = (fontId && isFontId(fontId)) ? fontId : DEFAULT_FONT_ID
  const fontMeta = getFontMeta(resolvedFontId)

  // Write ASS to temp file
  const assContent = generateAss(entries, video, burnin, fadeDurationSec, subtitleBackground, fontMeta.assFontName)
  const assPath = join(tmpdir(), `mojioko-${randomUUID()}.ass`)
  await fs.writeFile(assPath, assContent, 'utf-8')

  const ffmpeg = getBinPath('ffmpeg')
  // Multi-fontsdir strategy: a single burn-in always uses one selected font,
  // so we point fontsdir at the *exact* directory containing that font's
  // TTF — `resources/fonts/<bundledRelativeDir>/` for bundled fonts,
  // `%APPDATA%/MOJIOKO/fonts/<font-id>/` for user-downloaded fonts.  This
  // sidesteps the libass quirk that `fontsdir=` is a single directory
  // (not colon-separated) and eliminates the chance of two same-name fonts
  // colliding.  If a future feature wants per-row fonts, the plan is to
  // assemble a temp directory at burn-in start with symlinks to every font
  // referenced in the project and pass that combined directory instead.
  const fontsDir = getFontResolveDir(fontMeta)
  const subtitlesFilter = `subtitles='${escapeAssPath(assPath)}':fontsdir='${escapeAssPath(fontsDir)}'`
  log.info(`[ffmpeg-burnin] font: ${fontMeta.displayName} (${resolvedFontId}); fontsdir=${fontsDir}`)

  const encoder = await getBestEncoder(encoderSetting ?? 'auto')
  const encoderArgs = buildEncoderArgs(encoder)
  log.info(`[ffmpeg-burnin] encoder: ${encoder} (setting: ${encoderSetting ?? 'auto'}), audioMode: ${audioMode ?? 'simple'}, outputContainer: ${outputContainer}`)

  // Container override.  When the user selects "MP4 で書き出し" we add an
  // explicit `-f mp4` (defensive — the filename extension already implies it)
  // and `-movflags +faststart` so the moov atom moves to the head of the file,
  // letting SNS/Web players start streaming before the download completes.
  // For `'sameAsInput'`, leave format to ffmpeg's filename auto-detection.
  const containerArgs: string[] = outputContainer === 'mp4'
    ? ['-f', 'mp4', '-movflags', '+faststart']
    : []

  let args: string[]
  if (audioMode === 'preserve') {
    args = [
      '-y',
      '-i', inputPath,
      '-vf', subtitlesFilter,
      ...encoderArgs,
      '-c:a', 'copy',
      ...containerArgs,
      '-progress', 'pipe:1',
      outputPath
    ]
  } else {
    const N = video.audioTracks.length
    if (N === 0) {
      args = [
        '-y',
        '-i', inputPath,
        '-vf', subtitlesFilter,
        ...encoderArgs,
        '-an',
        ...containerArgs,
        '-progress', 'pipe:1',
        outputPath
      ]
    } else {
      const inputLabels = Array.from({ length: N }, (_, i) => `[0:a:${i}]`).join('')
      const audioFilter = `${inputLabels}amix=inputs=${N}:duration=longest:normalize=0[aout]`
      const filterComplex = `[0:v]${subtitlesFilter}[vout];${audioFilter}`
      args = [
        '-y',
        '-i', inputPath,
        '-filter_complex', filterComplex,
        '-map', '[vout]',
        '-map', '[aout]',
        ...encoderArgs,
        '-c:a', 'aac', '-b:a', '192k',
        ...containerArgs,
        '-progress', 'pipe:1',
        outputPath
      ]
    }
  }

  log.info(`[ffmpeg-burnin] start: ${inputPath} → ${outputPath}`)
  // Full argv at debug level so it is on the user's disk only when verbose
  // logging is enabled, but available for triaging encoder/filter issues.
  log.debug(`[ffmpeg-burnin] argv: ${ffmpeg} ${args.join(' ')}`)

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args)
    // Cleanup of the (potentially partial) output file is centralised in the
    // 'close' handler — we never unlink from inside the abort listener,
    // because ffmpeg may have already finished and exited cleanly between the
    // moment the user pressed Cancel and the OS delivering the signal.
    // Deleting in that race would destroy a fully-rendered file.
    let wasAborted = false

    signal.addEventListener('abort', () => {
      wasAborted = true
      proc.kill()
      // No unlink here — handled in 'close'.
    }, { once: true })

    let progressBuffer = ''
    const durationMs = video.durationSec * 1000

    proc.stdout.on('data', (chunk: Buffer) => {
      progressBuffer += chunk.toString()
      const lines = progressBuffer.split('\n')
      progressBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const [key, value] = line.split('=')
        if (key === 'out_time_ms' && value) {
          const currentMs = parseInt(value, 10) / 1000
          const percent = durationMs > 0 ? Math.min(99, (currentMs / durationMs) * 100) : 0
          onEvent({ event: 'progress', percent: Math.round(percent * 10) / 10, currentTimeMs: Math.round(currentMs) })
        }
      }
    })

    let stderrAccum = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrAccum += chunk.toString()
    })

    proc.on('close', async (code) => {
      // Always remove the temp ASS file — it has no value outside this run.
      try {
        await fs.unlink(assPath)
      } catch {
        // ignore cleanup failure
      }

      // Decide what to do with the output file.
      // - code === 0 AND not aborted → keep, treat as success.
      // - aborted (regardless of exit code) → partial output, delete it.
      // - non-zero exit (ffmpeg crash, invalid input, etc) → partial output, delete it.
      //
      // The unlink itself is wrapped so a permission failure or disk error
      // never crashes the burn-in promise — the user already sees a clear
      // "failed" event.
      const succeeded = code === 0 && !wasAborted

      if (!succeeded) {
        try {
          await fs.unlink(outputPath)
        } catch (unlinkErr) {
          // File may not exist (ffmpeg failed before writing anything) or be
          // locked.  Log at warn level and continue.
          log.warn(`[ffmpeg-burnin] could not unlink partial output ${outputPath}: ${String(unlinkErr)}`)
        }
      }

      if (succeeded) {
        let sizeMB = 0
        try {
          const stat = await fs.stat(outputPath)
          sizeMB = Math.round((stat.size / 1_000_000) * 10) / 10
        } catch {
          // ignore stat failure
        }
        onEvent({ event: 'completed', outputPath, sizeMB })
        resolve()
      } else if (wasAborted) {
        // User-initiated cancel.  Emit a 'failed' event with a stable marker
        // string so the renderer can distinguish from real ffmpeg errors.
        onEvent({ event: 'failed', error: 'Cancelled' })
        reject(new Error('Cancelled'))
      } else {
        const errMsg = stderrAccum.slice(-600)
        log.error(`[ffmpeg-burnin] failed (code ${code}): ${errMsg}`)
        onEvent({ event: 'failed', error: errMsg })
        reject(new FfmpegError(`ffmpeg exited with code ${code}`, { stderr: errMsg }))
      }
    })

    proc.on('error', (err) => {
      log.error('[ffmpeg-burnin] spawn error', err)
      reject(new FfmpegError(`Failed to spawn ffmpeg: ${err.message}`))
    })
  })
}
