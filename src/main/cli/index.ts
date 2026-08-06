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
import { parseArgs } from './args'
import { CliError, emitFailure, type CliContext } from './output'
import { printHelp } from './help'
import { runToolsCommand } from './commands/tools'
import { runTranscribeCommand } from './commands/transcribe'

const COMMANDS = new Set(['tools', 'transcribe', 'translate', 'burn', 'run'])
const HELP_TOKENS = new Set(['help', '-h', '--help'])

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
function userCliArgs(): string[] {
  let rest = process.argv.slice(1)
  if (!app.isPackaged && rest.length > 0) {
    const first = rest[0]
    if (first === '.' || first.endsWith('.js') || first.endsWith('.cjs') || first === app.getAppPath()) {
      rest = rest.slice(1)
    }
  }
  return rest
}

async function route(ctx: CliContext, command: string, args: ReturnType<typeof parseArgs>): Promise<number> {
  switch (command) {
    case 'tools':
      return runToolsCommand(ctx, args)
    case 'transcribe':
      return runTranscribeCommand(ctx, args)
    case 'translate':
    case 'burn':
    case 'run':
      return emitFailure(
        ctx,
        command,
        new CliError(
          'NOT_IMPLEMENTED',
          `Command "${command}" はまだ実装されていません（段階導入・spec §7.3）。`,
          'dev-docs/specs/mojioko-cli.md の段階導入順を参照してください。',
          { command, phase: command === 'burn' ? '2' : command === 'translate' ? '3' : '4' },
        ),
      )
    default:
      return emitFailure(ctx, command, new CliError('USAGE', `unknown command: "${command}"`, 'mojioko -h でコマンド一覧を表示。'))
  }
}

export async function maybeRunCli(): Promise<boolean> {
  const tokens = userCliArgs()
  // No user args ⇒ a normal GUI launch: let the caller boot the window.
  if (tokens.length === 0) return false

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
