import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import { getBinPath, getFontResolveDir } from '../lib/paths'
import { generateAss } from './ass-generator'
import { getBestEncoder, buildEncoderArgs } from './encoder-detector'
import { buildTrimConcatFilter } from './ffmpeg-trim-filter'
import { getFontMeta, DEFAULT_FONT_ID, isFontId, type FontId, type FontMeta } from '../../shared/fonts'
import {
  applyCutsToEntry,
  editedDuration,
  origToEdited
} from '../../shared/cuts'
import type { SubtitleEntry } from '../../shared/types'
import type { BurninStartRequest, BurninEvent } from '../../shared/ipc-contracts'
import { FfmpegError } from '../../shared/errors'
import log from '../lib/logger'

/**
 * Collect every unique FontId referenced by this burn-in: the project
 * default plus any per-row override.  Returns `[defaultFontId, ...overrides]`
 * with duplicates removed.  Order is stable for log-readability — the
 * project default is always first.
 */
function collectReferencedFontIds(
  defaultFontId: FontId,
  entries: BurninStartRequest['entries']
): FontId[] {
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

/**
 * Stage every referenced font's TTF into a single directory and return its
 * path.  We copy (not symlink) because:
 *
 *  - Windows symlink creation requires either Developer Mode or the
 *    `SeCreateSymbolicLinkPrivilege`, neither of which we can rely on for an
 *    installer-delivered desktop app.
 *  - The bundled font tree lives inside `app.asar.unpacked` / `resources/`
 *    where we don't want to mutate.
 *  - The copy cost is negligible (a few MB even for the largest CJK font).
 *
 * Throws `FfmpegError` when any referenced font lacks a TTF on disk — the
 * renderer should already be enforcing this in REQ-021's UI, but a
 * defensive backend check stops a bad request from spawning ffmpeg with a
 * fontsdir that libass would silently fall through on.
 *
 * Caller is responsible for `fs.rm(tempDir, { recursive: true })` in a
 * `finally` block, even on failure.
 */
async function stageFontsDir(fontIds: FontId[]): Promise<string> {
  const tempDir = join(tmpdir(), `mojioko-fonts-${randomUUID()}`)
  await fs.mkdir(tempDir, { recursive: true })

  for (const id of fontIds) {
    const meta: FontMeta = getFontMeta(id)
    const srcDir = getFontResolveDir(meta)
    const srcPath = join(srcDir, meta.fileName)
    const dstPath = join(tempDir, meta.fileName)
    try {
      await fs.copyFile(srcPath, dstPath)
    } catch (err) {
      // Best effort cleanup before reporting — leaving a half-populated
      // tempDir behind on the first failure path defeats the whole
      // try/finally contract.
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw new FfmpegError(
        `font asset missing for "${meta.displayName}" (${id}) — expected at ${srcPath}: ${String(err)}`
      )
    }
  }

  return tempDir
}

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
  const { inputPath, outputPath, entries, video, burnin, encoderSetting, audioMode, fadeDurationSec, subtitleBackground, outputContainer, fontId, cuts } = request

  // REQ-074 1d: when cuts is non-empty the ffmpeg run is rebuilt around
  // filter_complex trim+concat (audio + video).  When empty / absent we
  // fall back to the legacy single-input argv byte-for-byte so every
  // pre-REQ-074 caller is unaffected.
  const cutsList = cuts ?? []
  const hasCuts = cutsList.length > 0
  const effectiveDurationSec = hasCuts
    ? editedDuration(video.durationSec, cutsList)
    : video.durationSec

  // Resolve project default font.  Defensive: an unknown / missing fontId
  // falls back to the bundled default so a stale renderer never blocks a
  // burn-in.
  const resolvedFontId = (fontId && isFontId(fontId)) ? fontId : DEFAULT_FONT_ID
  const fontMeta = getFontMeta(resolvedFontId)

  // Collect every font referenced by this run (default + per-row overrides
  // from REQ-021) and stage them into a single directory that libass will
  // read on init.  Copy-based (not symlink) to dodge the Windows symlink
  // privilege requirement.
  const referencedFontIds = collectReferencedFontIds(resolvedFontId, entries)
  const fontsDir = await stageFontsDir(referencedFontIds)
  log.info(
    `[ffmpeg-burnin] referenced fonts: ${referencedFontIds.length} — ${referencedFontIds.join(', ')}; staged at ${fontsDir}`
  )

  // REQ-074 1d: when cuts are present, drop entries fully contained in any
  // cut and clamp head/tail overlaps via applyCutsToEntry, then translate
  // the surviving timestamps to the EDITED axis (origToEdited) — the ASS
  // Dialogue Start/End must match the post-concat frame positions because
  // subtitles= is applied to the concat output (§5.3).  When no cuts are
  // present this transformation is the identity, so the assContent is
  // byte-identical to pre-1d output.
  const entriesForAss: SubtitleEntry[] = hasCuts
    ? entries.flatMap((e) => {
        const clamped = applyCutsToEntry(e, cutsList)
        if (clamped === null) return []
        return [{
          ...e,
          startSec: origToEdited(clamped.startSec, cutsList),
          endSec: origToEdited(clamped.endSec, cutsList),
        }]
      })
    : entries
  log.info(
    `[ffmpeg-burnin] cuts=${cutsList.length} effectiveDuration=${effectiveDurationSec.toFixed(3)}s ` +
    `entries=${entries.length}→${entriesForAss.length}`
  )

  // Write ASS to temp file (project default goes into Style:, per-row
  // overrides come through as \fn<family> inline tags — see ass-generator).
  const assContent = generateAss(entriesForAss, video, burnin, fadeDurationSec, subtitleBackground, fontMeta.assFontName)
  const assPath = join(tmpdir(), `mojioko-${randomUUID()}.ass`)
  await fs.writeFile(assPath, assContent, 'utf-8')

  // === DIAG-20260614-015 BEGIN — REQ-20260614-001 補遺⑮ 一時計測（REVERT 予定）
  // 焼き込み位置リグレッションの原因切り分けのため、生成 ASS 全文 / .ass の
  // パス保全 / ffmpeg コマンド を info ログ + ファイルとして残す。
  // 原因確定後、補遺⑭・⑮ 起票と同じ要領で revert する。
  log.info('[diag-15] ===== generated ASS begin =====')
  for (const line of assContent.split('\n')) {
    log.info(`[diag-15] ${line}`)
  }
  log.info('[diag-15] ===== generated ASS end =====')
  // 出力動画の隣に <outputPath>.diag.ass を残す。tmpdir の .ass は後段で
  // unlink されるが、こちらは出力と同じディレクトリにあり、ユーザーが
  // 出力動画と一緒に拾い上げやすい。
  const diagAssPath = `${outputPath}.diag.ass`
  try {
    await fs.copyFile(assPath, diagAssPath)
    log.info(`[diag-15] preserved ASS copy at: ${diagAssPath}`)
  } catch (copyErr) {
    log.warn(`[diag-15] could not preserve ASS copy at ${diagAssPath}: ${String(copyErr)}`)
  }
  log.info(`[diag-15] tmpdir ASS path: ${assPath} (unlink skipped below, see close handler)`)
  // === DIAG-20260614-015 END

  const ffmpeg = getBinPath('ffmpeg')
  const subtitlesFilter = `subtitles='${escapeAssPath(assPath)}':fontsdir='${escapeAssPath(fontsDir)}'`
  log.info(`[ffmpeg-burnin] default font: ${fontMeta.displayName} (${resolvedFontId}); fontsdir=${fontsDir}`)

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
  if (hasCuts) {
    // REQ-074 1d: trim+concat path.  Falls through to one shape for both
    // audioMode values — preserve maps source tracks 1:1 (aac), simple
    // amixes them — and emits `-an` when the source has no audio.
    // Note: preserve+cuts cannot honour `-c:a copy` because trim is a
    // filtergraph operation; we fall back to aac re-encode here.  Spec §5.2.
    const audioModeForFilter: 'simple' | 'preserve' = audioMode === 'preserve' ? 'preserve' : 'simple'
    const N = video.audioTracks.length
    const built = buildTrimConcatFilter(
      video.durationSec,
      cutsList,
      audioModeForFilter,
      N,
      subtitlesFilter
    )
    args = [
      '-y',
      '-i', inputPath,
      '-filter_complex', built.filterComplex,
      ...built.mapArgs,
      ...encoderArgs,
      ...built.outputCodecArgs,
      ...containerArgs,
      '-progress', 'pipe:1',
      outputPath
    ]
    log.info(
      `[ffmpeg-burnin] trim path: cuts=${cutsList.length} audioTracks=${N} audioModeForFilter=${audioModeForFilter}`
    )
  } else if (audioMode === 'preserve') {
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

  // === DIAG-20260614-015 BEGIN — REQ-20260614-001 補遺⑮ 一時計測（REVERT 予定）
  // info-level に argv を出す。空白を含む引数は単一引用符で包んでコピペ可能に
  // し、subtitles=... のような特殊文字を含むフィルタ式もそのまま再現できる
  // ようにする。
  function quoteArg(a: string): string {
    return /[\s'"\\]|^$/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a
  }
  const ffmpegCmd = `${quoteArg(ffmpeg)} ${args.map(quoteArg).join(' ')}`
  log.info(`[diag-15] ffmpeg invocation: ${ffmpegCmd}`)
  log.info('[diag-15] argv (one per line for readability):')
  log.info(`[diag-15]   ${quoteArg(ffmpeg)}`)
  for (const a of args) {
    log.info(`[diag-15]   ${quoteArg(a)}`)
  }
  // === DIAG-20260614-015 END

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
    // REQ-074 1d: progress denominator must be the EDITED duration when
    // cuts are present — ffmpeg's `out_time_ms` advances against the
    // concat output's timeline, which is exactly `editedDuration`.
    const durationMs = effectiveDurationSec * 1000

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
      // Always remove the temp ASS file + staged fontsdir — neither has any
      // value outside this run.  Best-effort cleanup: a failure here must
      // not bubble up because the user already sees ffmpeg's own status
      // via the events emitted below.
      // === DIAG-20260614-015 BEGIN — REQ-20260614-001 補遺⑮ 一時計測（REVERT 予定）
      // 一時計測中は tmpdir の .ass を **削除しない**。残骸として残るが、
      // オーナーが採取できるようにするため。別途出力動画の隣にも .diag.ass
      // を残してある (生成直後の copyFile)。
      log.info(`[diag-15] skipping tmpdir ASS unlink to preserve it: ${assPath}`)
      // try {
      //   await fs.unlink(assPath)
      // } catch {
      //   // ignore cleanup failure
      // }
      // === DIAG-20260614-015 END
      try {
        await fs.rm(fontsDir, { recursive: true, force: true })
      } catch (cleanupErr) {
        log.warn(`[ffmpeg-burnin] could not remove staged fontsdir ${fontsDir}: ${String(cleanupErr)}`)
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
