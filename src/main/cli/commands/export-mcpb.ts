/**
 * REQ-0467 §2 — `mojioko export-mcpb -o <path.mcpb>`.
 *
 * The headless equivalent of Settings ▸ AI連携 ▸ "MCP 拡張を書き出す".  It shares
 * the EXACT pieces the GUI IPC handler (`app:exportMcpBundle`) uses —
 * `getMcpLaunchSpec` (dev/packaged-correct command/args/env), `writeMcpbBundle`
 * (manifest v0.3 + ZIP), and the same tool list (`toolList()` + `JOB_TOOLS`) —
 * so a bundle written from the CLI is byte-for-byte what the button produces;
 * there is no second code path to drift.  Unlike the GUI it does NOT persist
 * `settings.lastMcpExport` (a CLI run must not race the GUI's settings writer).
 */
import { existsSync } from 'node:fs'
import { writeMcpbBundle } from '../../mcp/mcpb'
import { toolList, JOB_TOOLS } from '../../mcp/tools'
import { getMcpLaunchSpec } from '../../mcp/launch'
import { optString, type ParsedArgs } from '../args'
import { CliError, emitSuccess, type CliContext } from '../output'
import { assertWritable } from '../overwrite'

export async function runExportMcpbCommand(ctx: CliContext, args: ParsedArgs): Promise<number> {
  const out = optString(args.opts, 'out')
  if (!out) throw new CliError('USAGE', '出力パス（-o <path.mcpb>）が必要です。', 'mojioko export-mcpb -o mojioko.mcpb')
  // REQ-0457 D13 — the overwrite guard (default: refuse an existing file).
  assertWritable(out, args.opts)

  const spec = getMcpLaunchSpec()
  const commandExists = existsSync(spec.command)
  // REQ-0463 — the launch runs `args[0]` (the asarUnpack'ed proxy); verify it
  // exists so a regressed unpack config is caught at export time.
  const proxyExists = typeof spec.args[0] === 'string' && existsSync(spec.args[0])

  try {
    writeMcpbBundle(out, spec.command, spec.args, spec.env, [...toolList(), ...JOB_TOOLS])
  } catch (e) {
    throw new CliError(
      'OUTPUT_WRITE_FAILED',
      `.mcpb の書き出しに失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      '出力先のパス・書き込み権限を確認してください。',
    )
  }

  return emitSuccess(ctx, 'export-mcpb', {
    path: out,
    appVersion: spec.appVersion,
    launchSpecRevision: spec.launchSpecRevision,
    isPackaged: spec.isPackaged,
    // `commandExists` = the exe the bundle launches; `proxyExists` = the proxy
    // script it actually runs (REQ-0463).  Both should be true in a real build.
    commandExists,
    proxyExists,
  })
}
