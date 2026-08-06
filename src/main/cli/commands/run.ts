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
import { CliError, emitSuccess, type CliContext } from '../output'
import { runTranscribeCommand } from './transcribe'
import { runTranslateCommand } from './translate'
import { runBurnCommand } from './burn'

export async function runRunCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const video = args.positionals[0]
  if (!video) throw new CliError('USAGE', 'video が必要です。', 'mojioko run <video> [--translate <lang>] [--burn] -o <out>')
  if (!existsSync(video)) throw new CliError('INPUT_NOT_FOUND', `動画が見つかりません: ${video}`, '動画パスを確認してください。')
  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <out>）が必要です。')

  const translateTo = optString(args.opts, 'translate')
  const doBurn = args.opts.burn === true

  const silent: CliContext = { ...ctx, silent: true, quiet: true }
  const workDir = mkdtempSync(join(tmpdir(), 'mojioko-run-'))
  const stages: string[] = []

  try {
    // 1) transcribe → temp .mojioko
    const t1 = join(workDir, 'transcribe.mojioko')
    await runTranscribeCommand(silent, { positionals: [video], opts: { ...args.opts, out: t1, format: 'mojioko' } })
    stages.push('transcribe')
    let subtitle = t1

    // 2) translate (optional) → temp .mojioko
    if (translateTo) {
      const t2 = join(workDir, 'translate.mojioko')
      await runTranslateCommand(silent, { positionals: [t1], opts: { ...args.opts, to: translateTo, out: t2, format: 'mojioko' } })
      stages.push('translate')
      subtitle = t2
    }

    // 3) burn (optional) → out.mp4, else copy the subtitle to out
    if (doBurn) {
      await runBurnCommand(silent, { positionals: [video, subtitle], opts: { ...args.opts, out } })
      stages.push('burn')
    } else {
      copyFileSync(subtitle, out)
    }

    return emitSuccess(ctx, 'run', { outputPath: out, stages, burned: doBurn, translatedTo: translateTo ?? null })
  } finally {
    // Clean up intermediates (keep only `-o`).
    try {
      rmSync(workDir, { recursive: true, force: true })
    } catch {
      // best-effort; leftover temp files are harmless
    }
  }
}
