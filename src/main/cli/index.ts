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
import { APP_VERSION } from '../../shared/app-info'
import { CLI_COMMANDS, HELP_TOKENS } from './launch-classify'
import { extractProjectFile, userCliArgs } from './launch-args'
import { parseArgs } from './args'
import { CliError, emitDebug, emitFailure, type CliContext } from './output'
import { printHelp } from './help'
import { canonicalCommandName, detectUnknownOptions, formatUnknownOptions } from './known-opts'
import { runToolsCommand } from './commands/tools'
import { runTranscribeCommand } from './commands/transcribe'
import { runTranslateCommand } from './commands/translate'
import { runBurnCommand } from './commands/burn'
import { runRunCommand } from './commands/run'
import { runStatusCommand } from './commands/status'
import { runExportFrameCommand } from './commands/export-frame'
import { runProbeCommand } from './commands/probe'
import { runReadSubtitleCommand } from './commands/read-subtitle'
import { runEditCuesCommand } from './commands/edit-cues'
import { runAddCueCommand, runDuplicateCueCommand, runResetCueCommand } from './commands/structure-cue'
import { runEditSubtitleCommand } from './commands/edit-subtitle'
import { runConvertCommand } from './commands/convert'
import { runPresetCommand } from './commands/preset'
import { runExportMcpbCommand } from './commands/export-mcpb'
import { runMcpServer } from '../mcp/server'
import { installStdoutGuard } from '../mcp/stdout-guard'

// REQ-0459 — command set / help tokens / project-open classification moved to
// `launch-classify.ts` (electron-free) so the dispatch decision is unit-testable.
const COMMANDS = CLI_COMMANDS


/**
 * REQ-0499 §1 — apply the unknown-option policy for this invocation.
 *
 * Default is a WARNING in the success envelope, not a failure: a script that
 * has been passing a stray flag keeps working, and the agent still learns the
 * flag did nothing.  `--strict-args` turns the same finding into `USAGE` (exit
 * 2) for callers that want the strict contract today.  Flipping the default is
 * an owner decision — the two behaviours share this one function so the switch
 * is a one-line change.
 *
 * `mcp` is exempt: it takes no options of its own and its arguments are
 * validated per-tool inside the server (`mcp/tools.ts`).
 */
function applyUnknownOptionPolicy(
  ctx: CliContext,
  command: string,
  opts: Readonly<Record<string, string | boolean>>,
): void {
  if (command === 'mcp') return
  const unknown = detectUnknownOptions(command, opts)
  if (unknown.length === 0) return

  const listed = formatUnknownOptions(unknown)
  const remedy = `mojioko ${command} -h で使用可能なオプションを確認してください。`
  if (opts['strict-args'] === true) {
    throw new CliError('USAGE', `未知のオプション: ${listed}`, remedy, {
      unknownOptions: unknown,
    })
  }
  ctx.warnings = [
    ...(ctx.warnings ?? []),
    {
      code: 'UNKNOWN_OPTION',
      message: `未知のオプションを無視しました: ${listed}`,
      detail: { unknownOptions: unknown, remedy },
    },
  ]
  // Also on stderr, so a human running without --json sees it too.
  process.stderr.write(`WARN [UNKNOWN_OPTION] 未知のオプションを無視しました: ${listed}\n  → ${remedy}\n`)
}

async function route(ctx: CliContext, command: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  emitDebug(ctx, `[debug] command=${command} opts=${JSON.stringify(args.opts)} positionals=${JSON.stringify(args.positionals)}`)
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
    case 'edit_cues':
    case 'edit-cues':
      return runEditCuesCommand(ctx, args)
    case 'add_cue':
    case 'add-cue':
      return runAddCueCommand(ctx, args)
    case 'duplicate_cue':
    case 'duplicate-cue':
      return runDuplicateCueCommand(ctx, args)
    case 'reset_cue':
    case 'reset-cue':
      return runResetCueCommand(ctx, args)
    case 'convert':
      return runConvertCommand(ctx, args)
    case 'preset':
      return runPresetCommand(ctx, args)
    case 'export-mcpb':
    case 'export_mcpb':
      return runExportMcpbCommand(ctx, args)
    default:
      return emitFailure(ctx, command, new CliError('USAGE', `unknown command: "${command}"`, 'mojioko -h でコマンド一覧を表示。'))
  }
}

/*
 * REQ-0557 §1-2 — the launch-shape helpers moved to `launch-args.ts`, a module
 * light enough for `main/early-gpu.ts` to import at the top of startup. They are
 * re-exported here because `main/index.ts` and the tests already import them
 * from this module, and because a second copy of "is this a CLI run?" is exactly
 * what REQ-0557 forbids.
 */
export {
  isCliInvocation,
  projectFileToOpen,
  projectFileFromSecondInstance,
} from './launch-args'

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
  /*
   * ★ REQ-0553 / REQ-0557 — the `--disable-gpu` SWITCH is no longer set here.
   *
   * `disableHardwareAcceleration()` (above) turns off GPU rasterisation but
   * Chromium still LAUNCHES a GPU process, and a fast command reaching
   * `app.exit()` mid-launch took the browser process down with it (0xC0000005).
   * REQ-0553 added the switch at this point and measured 16/800 → 4/800; a real
   * `--disable-gpu` flag measured 0/200. The gap was timing: by the time this
   * line runs, main has already executed every import in `index.ts`.
   *
   * REQ-0557 moved the switch into `main/early-gpu.ts`, imported at the very
   * top of the entry file. Setting it again here would be dead weight that
   * reads like a second safeguard, so it is gone — `early-gpu.ts` gates on the
   * SAME `isCliInvocation()` this function does, so there is no population it
   * could miss that this line would have caught.
   */
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
      code = printHelp(helpCtx, canonicalCommandName(parsed.positionals[0] ?? ''))
    } else if (parsed.opts.help === true) {
      // `mojioko <cmd> -h` — canonicalized so the `export-frame` / `read-subtitle`
      // / `edit-subtitle` / `export_mcpb` aliases get their OWN help instead of
      // silently falling through to the top-level page (REQ-0498 §1.2 B9).
      code = printHelp(helpCtx, canonicalCommandName(head))
    } else {
      // REQ-0499 §1 — reject/flag options this command does not accept, BEFORE
      // running it.  Unknown options used to return `ok:true` with no warning,
      // so a hallucinated flag looked like it worked.
      applyUnknownOptionPolicy(ctx, head, parsed.opts)
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
