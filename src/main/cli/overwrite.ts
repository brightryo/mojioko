/**
 * REQ-0457 D13 — output overwrite protection for headless/automated runs.
 *
 * By default a command REFUSES to clobber an existing `-o` path (exit 8 /
 * `OUTPUT_EXISTS`); `--overwrite` opts in.  Prevents an autonomous agent loop
 * from silently destroying a previous render.
 */
import { existsSync } from 'node:fs'
import { CliError } from './output'
import { optBool, type ParsedArgs } from './args'

/** Throw `OUTPUT_EXISTS` when `out` already exists and `--overwrite` was not passed. */
export function assertWritable(out: string, opts: ParsedArgs['opts']): void {
  if (out && existsSync(out) && optBool(opts, 'overwrite') !== true) {
    throw new CliError(
      'OUTPUT_EXISTS',
      `出力が既に存在します: ${out}`,
      '上書きするには --overwrite を付けてください（既定は事故防止のため拒否）。',
      { outputPath: out },
    )
  }
}
