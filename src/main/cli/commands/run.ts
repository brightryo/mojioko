/**
 * REQ-0447 / spec §3.5 — `mojioko run <video> [--translate <lang>] [--burn] -o <out>`.
 *
 * One-shot: transcribe → (translate) → (burn), chaining the same command
 * implementations via temp files. Intermediate steps run under a `silent`
 * context so only this command's final JSON reaches stdout; any stage failure
 * propagates with its own error code.
 */
import { existsSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext, type CliResult, type CliWarning } from '../output'
import { assertWritable } from '../overwrite'
import { loadSettings } from '../../services/settings-store'
import { resolveDefaultSubtitleStyle } from '../subtitle-style'
import { runTranscribeCommand } from './transcribe'
import { runTranslateCommand } from './translate'
import { runBurnCommand } from './burn'

/** Extract the success `data` object from a captured stage result. */
function dataOf(r: CliResult | null): Record<string, unknown> | null {
  return r && r.ok ? (r.data as Record<string, unknown>) : null
}

/**
 * REQ-0529 §2-1 — the warnings a captured stage produced.
 *
 * `run` swallowed these entirely: it cherry-picked fields out of each stage's
 * `data` and called `emitSuccess` with no warnings argument, so
 * `mojioko run --burn` reported `warnings: []` even when the burn had raised
 * font substitutions or no-op combinations. Found while adding
 * `CUE_BEYOND_VIDEO_END`, which would otherwise have been visible from `burn`
 * and invisible from `run` — the same one-surface blindness REQ-0502 exists to
 * remove. Fixing it here surfaces the pre-existing warnings too.
 */
function warningsOf(r: CliResult | null): CliWarning[] {
  return r && r.ok ? r.warnings : []
}

export async function runRunCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const video = args.positionals[0]
  if (!video) throw new CliError('USAGE', 'video が必要です。', 'mojioko run <video> [--translate <lang>] [--burn] -o <out>')
  if (!existsSync(video)) throw new CliError('INPUT_NOT_FOUND', `動画が見つかりません: ${video}`, '動画パスを確認してください。')
  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out>）が必要です。')
  assertWritable(out, args.opts) // REQ-0457 D13

  const translateTo = optString(args.opts, 'translate')
  const doBurn = args.opts.burn === true
  // REQ-0457 D11 — a pre-existing subtitle skips the transcribe stage.
  const existingSubtitle = optString(args.opts, 'subtitle')
  if (existingSubtitle && !existsSync(existingSubtitle)) {
    throw new CliError('INPUT_NOT_FOUND', `字幕が見つかりません: ${existingSubtitle}`, '字幕パスを確認してください。')
  }

  const workDir = mkdtempSync(join(tmpdir(), 'mojioko-run-'))
  const stages: string[] = []

  // REQ-0457 A2 — capture each stage's structured result (the sink routes the
  // stage's emitSuccess to us instead of stdout) so `run` can transcribe the
  // burn details (resolution/encoder/audio/overflow/sizeMB/subtitleStyle) and
  // the transcribe signals (detectedLanguage/hasWordTimestamps) into its own JSON.
  let transcribeResult: CliResult | null = null
  let translateResult: CliResult | null = null
  let burnResult: CliResult | null = null

  // REQ-0457 B5 — band each stage's local 0–99 progress into a MONOTONIC overall
  // so an agent never sees it jump backwards (transcribe 0→99 then burn 0→99).
  // D11 — no `transcribe` stage when an existing subtitle is supplied.
  const stagePlan = [
    ...(existingSubtitle ? [] : ['transcribe']),
    ...(translateTo ? ['translate'] : []),
    ...(doBurn ? ['burn'] : []),
  ]
  const span = 100 / Math.max(1, stagePlan.length)
  const stageCtx = (stage: string, assign: (r: CliResult) => void): CliContext => {
    const base = stagePlan.indexOf(stage) * span
    return {
      ...ctx,
      silent: true,
      quiet: true,
      sink: assign,
      // The sub-command reports a plain 0–99 percent; report it to OUR parent
      // (the MCP job) as a stage-aware, banded overall.
      onProgress: (p) => ctx.onStageProgress?.(stage, Math.round(p), Math.min(99, Math.round(base + (p / 100) * span))),
      onStageProgress: undefined,
    }
  }

  try {
    // 1) transcribe → temp .mojioko  (skipped when an existing subtitle is given, D11)
    let subtitle: string
    if (existingSubtitle) {
      subtitle = existingSubtitle
      stages.push('subtitle')
    } else {
      const t1 = join(workDir, 'transcribe.mojioko')
      await runTranscribeCommand(stageCtx('transcribe', (r) => { transcribeResult = r }), { positionals: [video], opts: { ...args.opts, out: t1, format: 'mojioko' } })
      stages.push('transcribe')
      subtitle = t1
    }

    // 2) translate (optional) → temp .mojioko
    if (translateTo) {
      const t2 = join(workDir, 'translate.mojioko')
      // REQ-0529 §2-1 — capture rather than discard: the sink was `() => {}`,
      // so this stage's warnings had nowhere to go even once `run` started
      // forwarding them.
      await runTranslateCommand(stageCtx('translate', (r) => { translateResult = r }), { positionals: [subtitle], opts: { ...args.opts, to: translateTo, out: t2, format: 'mojioko' } })
      stages.push('translate')
      subtitle = t2
    }

    // 3) burn (optional) → out.mp4, else copy the subtitle to out
    if (doBurn) {
      await runBurnCommand(stageCtx('burn', (r) => { burnResult = r }), { positionals: [video, subtitle], opts: { ...args.opts, out } })
      stages.push('burn')
    } else {
      copyFileSync(subtitle, out)
    }

    const tData = dataOf(transcribeResult)
    const bData = dataOf(burnResult)
    const subtitleStyle = bData?.subtitleStyle ?? resolveDefaultSubtitleStyle(await loadSettings())

    // REQ-0500 §3-1 — `--dry-run` is forwarded to the burn stage, which then
    // writes nothing.  `run` still reported `burned: true` and an `outputPath`
    // for a file that does not exist, so a caller checking the result believed
    // the burn had happened.  Report the dry run and stop claiming a burn.
    const dryRun = args.opts['dry-run'] === true

    return emitSuccess(ctx, 'run', {
      outputPath: out,
      stages,
      dryRun,
      burned: doBurn && !dryRun,
      translatedTo: translateTo ?? null,
      detectedLanguage: tData?.detectedLanguage ?? null,
      hasWordTimestamps: tData?.hasWordTimestamps ?? null,
      subtitleStyle,
      ...(bData
        ? {
            resolution: bData.resolution,
            encoder: bData.encoder,
            // REQ-0460 — surface the concrete encoder + measured bitrate + the
            // quality override so `run --burn` is as verifiable as `burn`.
            resolvedEncoder: bData.resolvedEncoder ?? null,
            audio: bData.audio,
            overflow: bData.overflow,
            // REQ-0529 §2-1 — cues past the end of the video, same shape `burn`
            // reports, so `run --burn` is as checkable as `burn`.
            beyondDuration: bData.beyondDuration ?? null,
            sizeMB: bData.sizeMB,
            videoBitrateKbps: bData.videoBitrateKbps ?? null,
            quality: bData.quality ?? null,
          }
        : {}),
    }, [
      // Order mirrors the pipeline, so a reader sees them in the order the
      // stages ran. Every stage `run` can drive is represented; a future stage
      // that forgets to appear here reintroduces the swallowing above.
      ...warningsOf(transcribeResult),
      ...warningsOf(translateResult),
      ...warningsOf(burnResult),
    ])
  } finally {
    // Clean up intermediates (keep only `-o`).
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // best-effort; leftover temp files are harmless
    }
  }
}
