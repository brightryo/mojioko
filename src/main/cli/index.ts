/**
 * REQ-0447 / spec §2 & §7 — MOJIOKO CLI dispatch (Electron argv subcommand).
 *
 * `maybeRunCli()` is called at the very top of the main process boot. If
 * `process.argv` carries a recognized subcommand (or `-h`/`--help`/`--version`),
 * it runs the CLI HEADLESS (no BrowserWindow, hardware acceleration disabled),
 * prints the result to stdout, and `app.exit(code)`s — returning `true` so the
 * caller skips the GUI boot. Otherwise it returns `false` immediately and the
 * normal GUI launch proceeds.
 *
 * Command detection scans argv for the first token that is a known command or a
 * help/version flag; this works identically for `MOJIOKO.exe tools` (packaged)
 * and `electron . tools` (dev), and a normal GUI launch (no such token) falls
 * through untouched.
 */
import { app } from 'electron'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { APP_VERSION } from '../../shared/app-info'
import { CLI_COMMANDS, HELP_TOKENS, classifyProjectOpen, secondInstanceProjectFile } from './launch-classify'
import { parseArgs } from './args'
import { CliError, emitFailure, type CliContext } from './output'
import { printHelp } from './help'
import { runToolsCommand } from './commands/tools'
import { runTranscribeCommand } from './commands/transcribe'
import { runTranslateCommand } from './commands/translate'
import { runBurnCommand } from './commands/burn'
import { runRunCommand } from './commands/run'
import { runStatusCommand } from './commands/status'
import { runExportFrameCommand } from './commands/export-frame'
import { runProbeCommand } from './commands/probe'
import { runReadSubtitleCommand } from './commands/read-subtitle'
import { runEditSubtitleCommand } from './commands/edit-subtitle'
import { runConvertCommand } from './commands/convert'
import { runExportMcpbCommand } from './commands/export-mcpb'
import { runMcpServer } from '../mcp/server'
import { installStdoutGuard } from '../mcp/stdout-guard'

// REQ-0459 — command set / help tokens / project-open classification moved to
// `launch-classify.ts` (electron-free) so the dispatch decision is unit-testable.
const COMMANDS = CLI_COMMANDS

/** REQ-0459 §1 — the `.mojioko` to open (file-association launch), or null (CLI). */
function extractProjectFile(tokens: string[]): string | null {
  return classifyProjectOpen(tokens, existsSync)
}

/**
 * Extract the user-supplied CLI args, stripping the launcher prefix.
 *
 *   packaged:  MOJIOKO.exe tools --json     → argv = [exe, 'tools', '--json']
 *   dev:       electron . tools --json      → argv = [electron, '.', 'tools', …]
 *   dev:       electron out/main/index.js … → argv = [electron, '…index.js', …]
 *
 * We drop argv[0] (the exe) always, and in dev also drop a leading app-path /
 * script token (`.`, a `*.js`/`*.cjs` path, or the resolved app path). Any
 * remaining tokens are the user's CLI args. Empty ⇒ a plain GUI launch.
 */
/** True when `arg` is the app-dir/entry token that the launcher prepends in dev. */
function isAppDirArg(arg: string, appPath: string): boolean {
  if (arg === '.' || arg.endsWith('.js') || arg.endsWith('.cjs')) return true
  // REQ-0452 — path-normalized compare (not exact string): the dev .mcpb bundle
  // passes `app.getAppPath()`, but slash style / case can differ across
  // launchers; resolve() normalizes so the token is still recognized + dropped.
  try {
    return resolve(arg).toLowerCase() === resolve(appPath).toLowerCase()
  } catch {
    return false
  }
}

function userCliArgs(): string[] {
  let rest = process.argv.slice(1)
  if (!app.isPackaged && rest.length > 0 && isAppDirArg(rest[0], app.getAppPath())) {
    rest = rest.slice(1)
  }
  return rest
}

async function route(ctx: CliContext, command: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  switch (command) {
    case 'tools':
      return runToolsCommand(ctx, args)
    case 'status':
      return runStatusCommand(ctx)
    case 'mcp':
      // Resident stdio MCP server (REQ-0450). Resolves only when stdin closes.
      return runMcpServer()
    case 'transcribe':
      return runTranscribeCommand(ctx, args)
    case 'translate':
      return runTranslateCommand(ctx, args)
    case 'burn':
      return runBurnCommand(ctx, args)
    case 'run':
      return runRunCommand(ctx, args)
    case 'export_frame':
    case 'export-frame':
      return runExportFrameCommand(ctx, args)
    case 'probe':
      return runProbeCommand(ctx, args)
    case 'read_subtitle':
    case 'read-subtitle':
      return runReadSubtitleCommand(ctx, args)
    case 'edit_subtitle':
    case 'edit-subtitle':
      return runEditSubtitleCommand(ctx, args)
    case 'convert':
      return runConvertCommand(ctx, args)
    case 'export-mcpb':
    case 'export_mcpb':
      return runExportMcpbCommand(ctx, args)
    default:
      return emitFailure(ctx, command, new CliError('USAGE', `unknown command: "${command}"`, 'mojioko -h でコマンド一覧を表示。'))
  }
}

/**
 * REQ-0454 §1 / REQ-0459 §1 — synchronous check: is this a CLI/MCP invocation?
 * The caller routes BEFORE any single-instance-lock / window logic, so
 * `mojioko mcp` (and every CLI command) never contends with the GUI's lock.
 *
 * REQ-0459: a lone existing `.mojioko` path (a double-click / file association)
 * is NOT a CLI invocation — it is a GUI launch that opens that project.
 */
export function isCliInvocation(): boolean {
  const tokens = userCliArgs()
  if (tokens.length === 0) return false
  if (extractProjectFile(tokens) !== null) return false
  return true
}

/** REQ-0459 §1/§4 — the `.mojioko` path this launch should open, or null. */
export function projectFileToOpen(): string | null {
  return extractProjectFile(userCliArgs())
}

/**
 * REQ-0459 §3 / REQ-0484 — the `.mojioko` path from a SECOND-instance launch's
 * argv (the `second-instance` event hands us the new process's full argv).
 *
 * REQ-0484: the delivered argv is NOT clean — Electron prepends Chromium switches
 * (observed: `--allow-file-access-from-files`) and, in dev, the entry-script
 * token, before the double-clicked path.  The old head-only `extractProjectFile`
 * therefore saw a leading `-`switch and returned null, so a warm-start
 * double-click silently no-opped (the window only got focus).  Scan past the
 * launcher noise instead (a second-instance only ever fires for a GUI launch).
 */
export function projectFileFromSecondInstance(argv: string[]): string | null {
  return secondInstanceProjectFile(argv.slice(1), existsSync)
}

export async function maybeRunCli(): Promise<boolean> {
  const tokens = userCliArgs()
  // No user args ⇒ a normal GUI launch: let the caller boot the window.
  if (tokens.length === 0) return false
  // REQ-0459 — a `.mojioko` double-click is a GUI launch, never a CLI run.
  if (extractProjectFile(tokens) !== null) return false

  // REQ-0455 — for `mojioko mcp`, guard stdout BEFORE anything (startup /
  // whenReady / libraries) can write a stray byte to it; only sanctioned
  // JSON-RPC lines reach real stdout, everything else is diverted to stderr.
  if (tokens[0] === 'mcp') installStdoutGuard()

  // Any user args ⇒ a CLI invocation (an unknown command becomes USAGE below,
  // never a silent GUI window). Headless: no GPU stack, no window. Must precede
  // `app.whenReady()`.
  app.disableHardwareAcceleration()
  await app.whenReady()

  const head = tokens[0]

  // `--version`
  if (head === '--version') {
    process.stdout.write(APP_VERSION + '\n')
    app.exit(0)
    return true
  }

  const isHelpCommand = HELP_TOKENS.has(head)
  // For a real command, strip the command token; for `help [cmd]`, strip `help`.
  const rest = COMMANDS.has(head) || head === 'help' ? tokens.slice(1) : tokens
  const parsed = parseArgs(rest)
  const ctx: CliContext = {
    json: parsed.opts.json !== false,
    quiet: parsed.opts.quiet === true,
    verbose: parsed.opts.verbose === true,
  }

  // Help is human-readable TEXT by default; JSON only when `--json` is
  // EXPLICITLY passed (results default to JSON, but help does not — §3.6).
  const helpCtx: CliContext = { ...ctx, json: parsed.opts.json === true }

  let code: number
  try {
    if (isHelpCommand) {
      // `mojioko help [cmd]` / `mojioko -h`
      code = printHelp(helpCtx, parsed.positionals[0])
    } else if (parsed.opts.help === true) {
      // `mojioko <cmd> -h`
      code = printHelp(helpCtx, head)
    } else {
      code = await route(ctx, head, parsed)
    }
  } catch (e) {
    const err =
      e instanceof CliError
        ? e
        : new CliError('UNEXPECTED', e instanceof Error ? e.message : String(e))
    code = emitFailure(ctx, head, err)
  }

  app.exit(code)
  return true
}
