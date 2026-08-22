/**
 * REQ-0457 A4 — `mojioko export_frame <video> <subtitle> -o <out.png> --time <sec>`.
 *
 * Renders ONE frame (video + burned subtitle at `timeSec`) so an agent can
 * VISUALLY verify the burn without spending minutes encoding a whole video.
 * Reuses the burn-in ass-generator + REQ-0375/0381 two-pass frame exporter, so
 * karaoke phase / animation are pixel-accurate at the playhead.
 *
 * REQ-0468 — export_frame now runs the SAME placement/layout resolver as `burn`
 * (`resolvePlacementAndLayout`): `--position`, `--margin-x`/`--margin-y`,
 * `--overflow`, `--resolution`/`--preset`, `--style`, and the REQ-0461 per-cue
 * style overrides all resolve identically, so a still is a faithful preview of
 * what the burn will render (pinned by the preview==burn pixel gate in cli-smoke).
 */
import { existsSync, readFileSync } from 'node:fs'
import { exportFrame } from '../../services/frame-exporter'
import { probeVideo } from '../../services/ffprobe'
import { loadSettings } from '../../services/settings-store'
import { parseProjectFile } from '../../../shared/project-file'
// REQ-0531 §2 — `--time` is on the edited axis; both the ceiling and the
// cue-visibility answer come from the shared cut arithmetic.
import { editedDuration, translateEntriesToEditedAxis } from '../../../shared/cuts'
import { parseSrt } from '../../../renderer/lib/srt-parse'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'
import { KARAOKE_STYLE_DEFAULT } from '../../../shared/karaoke-style'
import type { ExportFrameRequest } from '../../../shared/ipc-contracts'
import type { SubtitleEntry, VideoInfo } from '../../../shared/types'
import type { FontId } from '../../../shared/fonts'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext } from '../output'
import { assertWritable } from '../overwrite'
import { detectFormat, entriesFromSegments } from '../subtitle-io'
import { resolvePlacementAndLayout } from '../placement'
import { detectNoOpCombinations, detectIgnoredFlags, detectFontSubstitutions } from '../no-op-warnings'
import { resolveTier } from '../../lib/tier'
import { createInstalledFontProbe } from '../../lib/font-availability'
// REQ-0502 §1 — pure helpers live in their own electron-free module so the
// cap / rejection rules / filename scheme are unit-testable; re-exported so
// this command stays the single import site.
import { EXPORT_FRAME_MAX_TIMES, frameOutputPath, parseTimes } from '../frame-times'
export { EXPORT_FRAME_MAX_TIMES, frameOutputPath, parseTimes }

export async function runExportFrameCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const videoPath = args.positionals[0]
  const subPath = args.positionals[1]
  if (!videoPath || !subPath) {
    throw new CliError('USAGE', 'video と subtitle が必要です。', 'mojioko export_frame <video> <subtitle> -o <out.png> --time <sec>')
  }
  if (!existsSync(videoPath)) throw new CliError('INPUT_NOT_FOUND', `動画が見つかりません: ${videoPath}`, '動画パスを確認してください。')
  if (!existsSync(subPath)) throw new CliError('INPUT_NOT_FOUND', `字幕が見つかりません: ${subPath}`, '字幕パスを確認してください。')

  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out.png|.jpg>）が必要です。')

  // REQ-0502 §1 — `--time` accepts a comma-separated list.  Extending the
  // EXISTING flag rather than adding `--times` keeps `--time 1.5` (and the
  // `--at` alias) byte-identical in behaviour, so nothing that works today
  // changes, and there is no second spelling for an agent to choose between.
  const times = parseTimes(optString(args.opts, 'time', 'at'))
  const multi = times.length > 1
  // Single time keeps the exact `-o` path; only a multi-shot derives names.
  if (!multi) assertWritable(out, args.opts) // REQ-0457 D13

  const subFmt = detectFormat(subPath, optString(args.opts, 'format'))
  if (!subFmt) throw new CliError('UNSUPPORTED_FORMAT', `字幕フォーマット不明: ${subPath}`, '.mojioko / .srt を指定してください。')

  const lower = out.toLowerCase()
  const format: 'png' | 'jpg' = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'jpg' : 'png'

  const settings = await loadSettings()

  let video: VideoInfo
  try {
    video = await probeVideo(videoPath)
  } catch (e) {
    throw new CliError('UNSUPPORTED_FORMAT', `動画を読み取れません: ${videoPath}`, 'サポートされた動画ですか？', { error: e instanceof Error ? e.message : String(e) })
  }

  const fontId = (settings.activeFontId ?? 'noto-sans-jp-semibold') as FontId
  let entries: SubtitleEntry[]
  /**
   * REQ-0531 §2-1 — the line `burn` has had since REQ-074 and this command
   * never got.  Without it `--time` addressed the SOURCE while `burn` produced
   * the edited timeline, so the two commands disagreed about what "6 seconds"
   * meant for the very same `.mojioko`.
   *
   * SRT carries no cuts, so that branch leaves this empty and is unaffected.
   */
  let cuts: ExportFrameRequest['cuts'] = []
  if (subFmt === 'mojioko') {
    const parsed = parseProjectFile(readFileSync(subPath, 'utf-8'))
    if (!parsed.ok) throw new CliError('UNSUPPORTED_FORMAT', `.mojioko を読み取れません（${parsed.reason}）。`)
    entries = parsed.project.editing.subtitles
    cuts = parsed.project.editing.cuts ?? []
  } else {
    const { cues, errors } = parseSrt(readFileSync(subPath, 'utf-8'))
    if (errors.length > 0) throw new CliError('UNSUPPORTED_FORMAT', `SRT の解析に失敗: ${errors[0]}`, 'SRT の書式を確認してください。')
    entries = entriesFromSegments(
      cues.map((c) => ({ startSec: c.startSec, endSec: c.endSec, text: c.text })),
      settings.transcriptionDefaults,
      video,
      fontId,
      settings.fadeDurationSec ?? 0,
    )
  }

  // REQ-0468 — the SAME placement/layout resolution `burn` runs: style preset,
  // per-cue style overrides (REQ-0461), `--position`, `--margin-x`/`--margin-y`,
  // `--overflow`, and `--resolution`/`--preset` scaling + auto line-break.  This
  // is what makes the still a faithful preview of the burn.
  const placement = resolvePlacementAndLayout(args.opts, video, settings, fontId, entries)
  entries = placement.entries
  const { renderVideo, scaleTo, resized, overflow, marginX, appliedStylePreset, subtitleStyle } = placement

  // REQ-0502 §2 — flag combinations that render nothing. Computed on the
  // RESOLVED cues, so it catches both a CLI flag and a `.mojioko` that already
  // carried the combination.
  const noOpWarnings = [
    ...placement.warnings,
    ...detectNoOpCombinations(entries),
    ...detectIgnoredFlags(args.opts, entries),
    // REQ-0508 §1-3 / REQ-0509 §2 — a font was replaced (tier-locked, or its
    // file is missing). Computed from the SAME pure policy and the SAME probe
    // the renderer uses, so the warning and the pixels cannot disagree.
    ...detectFontSubstitutions(entries, fontId, resolveTier(), createInstalledFontProbe()),
  ]

  // Parity with `burn`: `--overflow error` rejects instead of rendering.
  if (placement.overflowMode === 'error' && overflow.overflowCueCount > 0) {
    throw new CliError(
      'SUBTITLE_OVERFLOW',
      `縦にはみ出す字幕が ${overflow.overflowCueCount} 件あります（--overflow error）。`,
      '--overflow shrink で自動縮小するか、--margin-y を小さく／フォントサイズを下げてください。',
      { overflowCueCount: overflow.overflowCueCount },
    )
  }

  // REQ-0502 §1-4 — reject a time past the end instead of letting ffmpeg fail.
  // Before this the call reached ffmpeg and came back as
  // `BURN_FAILED: ffmpeg exited with code 4294967294`, which tells the caller
  // nothing. Rejecting (rather than clamping to the last frame) keeps the rule
  // that a result never silently describes something other than the request.
  //
  // REQ-0531 §2-5 — measured on the EDITED duration, because that is the axis
  // `--time` is on. The window [editedDuration, sourceDuration) used to be
  // ACCEPTED and returned a frame that exists nowhere in the burn — the same
  // "a result describes something other than the request" failure this check
  // was written to remove, on the other side of the boundary. Identical to the
  // old check (value and message) when there are no cuts.
  const durationSec = editedDuration(video.durationSec, cuts)
  if (durationSec > 0) {
    const past = times.filter((t) => t >= durationSec)
    if (past.length > 0) {
      throw new CliError(
        'USAGE',
        `動画の尺（${durationSec.toFixed(3)} 秒）を超える時刻です: ${past.map((t) => t.toFixed(3)).join(', ')}`,
        `0 以上 ${durationSec.toFixed(3)} 秒未満で指定してください。`,
        // `sourceDurationSec` is reported alongside so a caller that hits this
        // on a trimmed project can see WHY the ceiling is lower than the file's
        // length, instead of concluding the number is wrong.
        {
          durationSec,
          outOfRange: past,
          ...(cuts.length > 0 ? { sourceDurationSec: video.durationSec, cutCount: cuts.length } : {}),
        },
      )
    }
  }

  // REQ-0502 §1-2 — placement/layout is resolved ONCE, above, and every frame
  // reuses those entries. That single resolution is the reason batching is
  // worth having: the per-frame work is just the two-pass ffmpeg extract.
  //
  // REQ-0531 §2-1 — `cueVisible` answers "was a cue on screen at `timeSec`?",
  // and `timeSec` is edited-axis, so it has to be asked of edited-axis cues.
  // Comparing an edited time against raw cue times reported the wrong cue
  // whenever a cut preceded the instant, and reported `true` for cues a cut had
  // fully consumed. Same fold the renderer runs, so the flag and the pixels
  // cannot disagree. Identity (by reference) when there are no cuts.
  const { entries: cueVisibilityEntries } = translateEntriesToEditedAxis(entries, cuts)
  const frames: { timeSec: number; outputPath: string; sizeBytes: number; cueVisible: boolean }[] = []
  for (const [i, timeSec] of times.entries()) {
    const target = multi ? frameOutputPath(out, i, timeSec) : out
    if (multi) assertWritable(target, args.opts)

    const req: ExportFrameRequest = {
      inputPath: videoPath,
      outputPath: target,
      timeSec,
      // REQ-0468 — render canvas = the post-scaling target (PlayRes for the ASS),
      // with `scaleTo` telling the exporter to scale+pad the source frame into it.
      video: renderVideo,
      format,
      includeSubtitles: true,
      entries,
      // REQ-0531 §2-1 — raw cues + the cut list; the exporter runs the same
      // translation the burn does. Passing pre-translated cues instead would
      // put the fold in two places, which §2-2 exists to prevent.
      cuts,
      subtitleBackground: BURNIN_DEFAULTS.subtitleBackground,
      fontId,
      karaokeStyle: KARAOKE_STYLE_DEFAULT,
      ...(scaleTo ? { scaleTo } : {}),
      marginLrPx: marginX,
    }

    let result
    try {
      result = await exportFrame(req)
    } catch (e) {
      throw new CliError(
        'BURN_FAILED',
        `フレーム出力に失敗（t=${timeSec}）: ${e instanceof Error ? e.message : String(e)}`,
        'ffmpeg の入力/コーデック/出力先を確認してください。',
      )
    }
    frames.push({
      timeSec,
      outputPath: result.outputPath,
      sizeBytes: result.sizeBytes,
      cueVisible: cueVisibilityEntries.some((e) => !e.isDeleted && e.startSec <= timeSec && timeSec < e.endSec && e.text.trim() !== ''),
    })
  }

  const first = frames[0]
  return emitSuccess(
    ctx,
    'export_frame',
    {
      // Single-frame fields kept at the top level so every existing caller and
      // the REQ-0468 parity gate read exactly what they read before.
      outputPath: first.outputPath,
      sizeBytes: first.sizeBytes,
      timeSec: first.timeSec,
      cueVisible: first.cueVisible,
      // REQ-0502 §1-4 — every frame actually written, with the time it was
      // written AT (not merely the time that was asked for).
      frameCount: frames.length,
      frames,
      format,
      // REQ-0468 — the OUTPUT resolution (post `--resolution`/`--preset`), like burn.
      resolution: { width: renderVideo.widthPx, height: renderVideo.heightPx },
      resized,
      // REQ-0468 — same fields `burn` reports so a still is verifiable the same way.
      overflow,
      subtitleStyle,
      stylePreset: appliedStylePreset,
    },
    noOpWarnings,
  )
}
