import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { getBinPath, getFontResolveDir } from '../lib/paths'
import { generateAss } from './ass-generator'
import { getFontMeta, DEFAULT_FONT_ID, isFontId, type FontId, type FontMeta } from '../../shared/fonts'
import type { ExportFrameRequest, ExportFrameResult } from '../../shared/ipc-contracts'
import type { SubtitleEntry } from '../../shared/types'
import { FfmpegError } from '../../shared/errors'
import log from '../lib/logger'

/**
 * REQ-20260615-021: extract a single video frame at `timeSec` (source /
 * original axis, the <video> element's `currentTime`) and save it to
 * `outputPath`.  When `includeSubtitles` is true the same ASS generator +
 * libass `subtitles=` filter as burn-in is used, so the output still
 * matches what a future burned video would render at that instant.
 *
 * Cuts handling: deliberately ignored.  The renderer hands the source-axis
 * time directly, so ffmpeg seeks against the raw video and ASS uses raw
 * (= original-axis) entry timestamps — the subtitle visible at `timeSec`
 * is the one whose [startSec, endSec] contains it.  This matches what the
 * user sees in the preview, since the preview's `<video>` element also
 * runs on the original axis.
 */
async function stageFontsDir(fontIds: FontId[]): Promise<string> {
  const tempDir = join(tmpdir(), `mojioko-frame-fonts-${randomUUID()}`)
  await fs.mkdir(tempDir, { recursive: true })
  for (const id of fontIds) {
    const meta: FontMeta = getFontMeta(id)
    const srcDir = getFontResolveDir(meta)
    const srcPath = join(srcDir, meta.fileName)
    const dstPath = join(tempDir, meta.fileName)
    try {
      await fs.copyFile(srcPath, dstPath)
    } catch (err) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new FfmpegError(
        `font asset missing for "${meta.displayName}" (${id}) — expected at ${srcPath}: ${String(err)}`
      )
    }
  }
  return tempDir
}

function escapeAssPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
}

function collectReferencedFontIds(defaultFontId: FontId, entries: SubtitleEntry[]): FontId[] {
  const seen = new Set<FontId>([defaultFontId])
  const ordered: FontId[] = [defaultFontId]
  for (const e of entries) {
    if (isFontId(e.fontId) && !seen.has(e.fontId)) {
      seen.add(e.fontId)
      ordered.push(e.fontId)
    }
  }
  return ordered
}

export async function exportFrame(req: ExportFrameRequest): Promise<ExportFrameResult> {
  const {
    inputPath,
    outputPath,
    timeSec,
    video,
    format,
    includeSubtitles,
    entries = [],
    fadeDurationSec = 0,
    subtitleBackground,
    fontId
  } = req

  const ffmpeg = getBinPath('ffmpeg')

  // Codec choice — ffmpeg auto-picks by extension when the output filename
  // matches, but we set it explicitly for predictability and consistency
  // with the existing thumbnail-extraction path.
  const codecArgs: string[] = format === 'jpg'
    ? ['-c:v', 'mjpeg', '-q:v', '2']
    : ['-c:v', 'png']

  let assPath: string | null = null
  let fontsDir: string | null = null

  try {
    const args: string[] = ['-y']

    if (includeSubtitles && entries.length > 0) {
      // Reuse the burn-in font staging + ASS generation so the still is
      // pixel-equivalent to whatever the burn-in would emit at this instant.
      const resolvedFontId: FontId = isFontId(fontId) ? fontId : DEFAULT_FONT_ID
      const fontMeta = getFontMeta(resolvedFontId)
      const referencedFontIds = collectReferencedFontIds(resolvedFontId, entries)
      fontsDir = await stageFontsDir(referencedFontIds)

      const assContent = generateAss(
        entries,
        video,
        // `burnin` (BurninPosition) is vestigial in generateAss — pass any
        // legal value so the signature is satisfied (matches ENTRY_LAYOUT_DEFAULTS).
        { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 },
        fadeDurationSec,
        subtitleBackground,
        fontMeta.assFontName
      )
      assPath = join(tmpdir(), `mojioko-frame-${randomUUID()}.ass`)
      await fs.writeFile(assPath, assContent, 'utf-8')

      const subtitlesFilter = `subtitles='${escapeAssPath(assPath)}':fontsdir='${escapeAssPath(fontsDir)}'`

      // Two-pass seek: coarse `-ss` before `-i` for speed, then a
      // frame-accurate `-ss 0` after `-i` would normally be needed for
      // precision.  Here we put `-ss` AFTER `-i` so ffmpeg decodes from
      // the previous keyframe up to timeSec — slower but exact and
      // required for the subtitles filter to see the correct time.
      args.push(
        '-i', inputPath,
        '-ss', String(timeSec),
        '-frames:v', '1',
        '-vf', subtitlesFilter,
        ...codecArgs,
        outputPath
      )
    } else {
      // No subtitles — straight single-frame extract.  Output-side `-ss`
      // is frame-accurate at the cost of decoding from the prior keyframe.
      args.push(
        '-i', inputPath,
        '-ss', String(timeSec),
        '-frames:v', '1',
        ...codecArgs,
        outputPath
      )
    }

    log.info(`[frame-exporter] start: ${inputPath} @ ${timeSec.toFixed(3)}s → ${outputPath} (format=${format}, includeSubtitles=${includeSubtitles})`)

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(ffmpeg, args)
      let stderrAccum = ''
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrAccum += chunk.toString()
      })
      proc.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          const errMsg = stderrAccum.slice(-600)
          log.error(`[frame-exporter] failed (code ${code}): ${errMsg}`)
          reject(new FfmpegError(`ffmpeg exited with code ${code}`, { stderr: errMsg }))
        }
      })
      proc.on('error', (err) => {
        reject(new FfmpegError(`Failed to spawn ffmpeg: ${err.message}`))
      })
    })

    const stat = await fs.stat(outputPath)
    return { outputPath, sizeBytes: stat.size }
  } finally {
    // Best-effort cleanup of temp ASS file + staged fonts dir.  Failures
    // here are logged at warn level but never bubble up since the user
    // already has their output file (or already saw the failure path).
    if (assPath) {
      try { await fs.unlink(assPath) } catch (cleanupErr) {
        log.warn(`[frame-exporter] could not unlink temp ASS ${assPath}: ${String(cleanupErr)}`)
      }
    }
    if (fontsDir) {
      try { await fs.rm(fontsDir, { recursive: true, force: true }) } catch (cleanupErr) {
        log.warn(`[frame-exporter] could not remove staged fontsdir ${fontsDir}: ${String(cleanupErr)}`)
      }
    }
  }
}
