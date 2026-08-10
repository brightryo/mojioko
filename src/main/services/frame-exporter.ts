import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { getBinPath, getFontResolveDir } from '../lib/paths'
import { generateAss } from './ass-generator'
import { isPackagedAsMsix, getCurrentProcessContext } from '../lib/msix'
import { getFontMeta, DEFAULT_FONT_ID, isFontId, type FontId, type FontMeta } from '../../shared/fonts'
import { ASS_MARGIN_LR_PX } from '../../shared/constants'
import type { ExportFrameRequest, ExportFrameResult } from '../../shared/ipc-contracts'
import type { SubtitleEntry } from '../../shared/types'
import { FfmpegError } from '../../shared/errors'
import { displayedFrameSeekSec, frameExportSubtitleFilter } from '../../shared/frame-seek'
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
    subtitleBackground,
    fontId,
    karaokeStyle,
    scaleTo,
    marginLrPx,
  } = req

  const ffmpeg = getBinPath('ffmpeg')

  // REQ-0375 §3 — align the extracted frame with the one the preview shows.
  // The preview <video> at `currentTime = timeSec` displays the frame with
  // pts <= timeSec, but output-side `-ss timeSec` selects the first frame with
  // pts >= timeSec — the NEXT frame whenever the playhead is between boundaries
  // (owner's §3 repro).  `displayedFrameSeekSec` snaps the seek so ffmpeg
  // extracts the displayed frame instead.
  const seekSec = displayedFrameSeekSec(timeSec, req.video.fps)

  // Codec choice — ffmpeg auto-picks by extension when the output filename
  // matches, but we set it explicitly for predictability and consistency
  // with the existing thumbnail-extraction path.
  const codecArgs: string[] = format === 'jpg'
    ? ['-c:v', 'mjpeg', '-q:v', '2']
    : ['-c:v', 'png']

  let assPath: string | null = null
  let fontsDir: string | null = null
  // REQ-0381 — pass-1 still for the two-pass subtitle export (see below).
  let rawFramePath: string | null = null

  // Spawn ffmpeg once with the given args and resolve on exit code 0.  Shared
  // by the single-pass (no-subtitle) path and both passes of the two-pass
  // subtitle path so error handling and logging stay identical.
  const runFfmpeg = (args: string[]): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      // REQ-0103 — explicit `shell: false` (see ffmpeg-burnin.ts for rationale).
      const proc = spawn(ffmpeg, args, { shell: false })
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

  try {
    log.info(`[frame-exporter] start: ${inputPath} @ ${timeSec.toFixed(3)}s → ${outputPath} (format=${format}, includeSubtitles=${includeSubtitles})`)

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
        subtitleBackground,
        fontMeta.assFontName,
        // REQ-0286 — pass tier flag so karaoke gate applies to frame
        // exports too.  Frame at time T renders the karaoke state at T
        // (some words highlighted, some not); libass handles the time-
        // slicing naturally when we render a single frame.
        isPackagedAsMsix(getCurrentProcessContext()),
        // REQ-0344 §2-2 — the seventh argument this call used to omit, so a
        // still was written with whatever `generateAss` defaulted to while the
        // burn-in used the requested value.  Both now come from the caller.
        karaokeStyle,
        // REQ-0468 — `forceSelfPositionAll` (production default) + `marginLrPx`
        // from `--margin-x`, matching what `ffmpeg-burnin` passes so the still's
        // ASS MarginL/R and self-positioning are identical to the burn.
        true,
        marginLrPx ?? ASS_MARGIN_LR_PX,
      )
      assPath = join(tmpdir(), `mojioko-frame-${randomUUID()}.ass`)
      await fs.writeFile(assPath, assContent, 'utf-8')

      const subtitlesFilter = `subtitles='${escapeAssPath(assPath)}':fontsdir='${escapeAssPath(fontsDir)}'`

      // REQ-0381 — TWO-PASS so the burned subtitle matches the preview at the
      // playhead.  The `subtitles` (libass) filter evaluates karaoke `\k`/`\kf`
      // and animation `\fad`/`\t` at the frame's pts; a single-pass render with
      // output-side `-ss` leaves that pts at the extracted frame's own time
      // (`floor(timeSec·fps)/fps`), so the colouring lags the playhead by up to
      // one frame.  It cannot be fixed in one pass: output `-ss` trims frames on
      // the POST-filter pts, so any `setpts` that moves the clock to `timeSec`
      // also discards the wrong frames.
      //
      // Pass 1 extracts the displayed frame with NO filters — byte-identical to
      // the no-subtitle path below, so §3 (REQ-0375) frame selection is exactly
      // preserved — into a lossless PNG.  Pass 2 burns the subtitle onto that
      // still at the continuous playhead time (`frameExportSubtitleFilter` →
      // `settb=AVTB,setpts=<timeSec>/TB,subtitles=…`).  The still carries no
      // meaningful pts, so `setpts` here is safe and only sets libass's clock.
      rawFramePath = join(tmpdir(), `mojioko-frame-raw-${randomUUID()}.png`)
      await runFfmpeg([
        '-y',
        '-i', inputPath,
        '-ss', String(seekSec),
        '-frames:v', '1',
        '-c:v', 'png',
        rawFramePath,
      ])

      // REQ-0468 — when a target resolution is requested, scale+pad the source
      // frame into it BEFORE the subtitles filter, exactly as `ffmpeg-burnin`'s
      // `scalePrefix` does, so a `--resolution` / `--preset` still matches the
      // burn (the ASS is already generated at PlayRes = the target `video` dims).
      const scalePrefix = scaleTo
        ? `scale=${scaleTo.w}:${scaleTo.h}:force_original_aspect_ratio=decrease,` +
          `pad=${scaleTo.w}:${scaleTo.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,`
        : ''
      const vf = frameExportSubtitleFilter(timeSec, `${scalePrefix}${subtitlesFilter}`)
      await runFfmpeg([
        '-y',
        '-i', rawFramePath,
        '-vf', vf,
        '-frames:v', '1',
        ...codecArgs,
        outputPath,
      ])
    } else {
      // No subtitles — straight single-frame extract.  Output-side `-ss`
      // is frame-accurate at the cost of decoding from the prior keyframe;
      // `seekSec` is snapped (see above) so the frame matches the preview.
      await runFfmpeg([
        '-y',
        '-i', inputPath,
        '-ss', String(seekSec),
        '-frames:v', '1',
        ...codecArgs,
        outputPath,
      ])
    }

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
    if (rawFramePath) {
      try { await fs.unlink(rawFramePath) } catch (cleanupErr) {
        log.warn(`[frame-exporter] could not unlink temp frame ${rawFramePath}: ${String(cleanupErr)}`)
      }
    }
  }
}
