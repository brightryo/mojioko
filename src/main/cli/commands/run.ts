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
import { CliError, emitSuccess, type CliContext, type CliResult } from '../output'
import { loadSettings } from '../../services/settings-store'
import { resolveDefaultSubtitleStyle } from '../subtitle-style'
import { runTranscribeCommand } from './transcribe'
import { runTranslateCommand } from './translate'
import { runBurnCommand } from './burn'

/** Extract the success `data` object from a captured stage result. */
function dataOf(r: CliResult | null): Record<string, unknown> | null {
  return r && r.ok ? (r.data as Record<string, unknown>) : null
}

export async function runRunCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const video = args.positionals[0]
  if (!video) throw new CliError('USAGE', 'video が必要です。', 'mojioko run <video> [--translate <lang>] [--burn] -o <out>')
  if (!existsSync(video)) throw new CliError('INPUT_NOT_FOUND', `動画が見つかりません: ${video}`, '動画パスを確認してください。')
  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out>）が必要です。')

  const translateTo = optString(args.opts, 'translate')
  const doBurn = args.opts.burn === true

  const workDir = mkdtempSync(join(tmpdir(), 'mojioko-run-'))
  const stages: string[] = []

  // REQ-0457 A2 — capture each stage's structured result (the sink routes the
  // stage's emitSuccess to us instead of stdout) so `run` can transcribe the
  // burn details (resolution/encoder/audio/overflow/sizeMB/subtitleStyle) and
  // the transcribe signals (detectedLanguage/hasWordTimestamps) into its own JSON.
  let transcribeResult: CliResult | null = null
  let burnResult: CliResult | null = null

  // REQ-0457 B5 — band each stage's local 0–99 progress into a MONOTONIC overall
  // so an agent never sees it jump backwards (transcribe 0→99 then burn 0→99).
  const stagePlan = ['transcribe', ...(translateTo ? ['translate'] : []), ...(doBurn ? ['burn'] : [])]
  const span = 100 / stagePlan.length
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
    // 1) transcribe → temp .mojioko
    const t1 = join(workDir, 'transcribe.mojioko')
    await runTranscribeCommand(stageCtx('transcribe', (r) => { transcribeResult = r }), { positionals: [video], opts: { ...args.opts, out: t1, format: 'mojioko' } })
    stages.push('transcribe')
    let subtitle = t1

    // 2) translate (optional) → temp .mojioko
    if (translateTo) {
      const t2 = join(workDir, 'translate.mojioko')
      await runTranslateCommand(stageCtx('translate', () => {}), { positionals: [t1], opts: { ...args.opts, to: translateTo, out: t2, format: 'mojioko' } })
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

    return emitSuccess(ctx, 'run', {
      outputPath: out,
      stages,
      burned: doBurn,
      translatedTo: translateTo ?? null,
      detectedLanguage: tData?.detectedLanguage ?? null,
      hasWordTimestamps: tData?.hasWordTimestamps ?? null,
      subtitleStyle,
      ...(bData
        ? {
            resolution: bData.resolution,
            encoder: bData.encoder,
            audio: bData.audio,
            overflow: bData.overflow,
            sizeMB: bData.sizeMB,
          }
        : {}),
    })
  } finally {
    // Clean up intermediates (keep only `-o`).
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // best-effort; leftover temp files are harmless
    }
  }
}
