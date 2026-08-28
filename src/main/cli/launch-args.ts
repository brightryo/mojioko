/**
 * REQ-0557 §1-2 — "is this launch headless?", answered once, importable early.
 *
 * ## Why this is its own module
 *
 * The answer was already computed, in `cli/index.ts`. But that module imports
 * every command implementation — ffmpeg wrappers, the sidecars, the MCP server
 * — so asking it the question costs loading all of it. REQ-0557 needs the
 * answer at the very TOP of main's startup, before anything else runs, which
 * rules that out.
 *
 * The alternative would have been a second argv scan next to the early switch.
 * That is the thing not to do: two implementations of "is this a CLI run?" that
 * agree today and drift the first time a command is added. So the decision
 * moved DOWN here, and both callers reach it — `cli/index.ts` re-exports these,
 * and `early-gpu.ts` imports them directly.
 *
 * Dependencies are deliberately minimal: `electron` (for `app.isPackaged` /
 * `getAppPath`, both readable before `ready`), `node:fs`, `node:path`, and the
 * electron-free `launch-classify`. Nothing here starts Chromium work.
 */
import { app } from 'electron'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { classifyProjectOpen, secondInstanceProjectFile } from './launch-classify'

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
export function userCliArgs(): string[] {
  let rest = process.argv.slice(1)
  if (!app.isPackaged && rest.length > 0 && isAppDirArg(rest[0], app.getAppPath())) {
    rest = rest.slice(1)
  }
  return rest
}

/** REQ-0459 §1 — the `.mojioko` to open (file-association launch), or null (CLI). */
export function extractProjectFile(tokens: string[]): string | null {
  return classifyProjectOpen(tokens, existsSync)
}

/**
 * REQ-0454 §1 / REQ-0459 §1 — synchronous check: is this a CLI/MCP invocation?
 * The caller routes BEFORE any single-instance-lock / window logic, so
 * `mojioko mcp` (and every CLI command) never contends with the GUI's lock.
 *
 * REQ-0459: a lone existing `.mojioko` path (a double-click / file association)
 * is NOT a CLI invocation — it is a GUI launch that opens that project.
 *
 * ★ REQ-0557 — this is now also the gate for the early `--disable-gpu` switch,
 * so "returns false" is what keeps the GUI's rendering untouched. The
 * population it selects is unchanged from REQ-0553; only the moment it is
 * consulted moved earlier.
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
 */
export function projectFileFromSecondInstance(argv: string[]): string | null {
  return secondInstanceProjectFile(argv.slice(1), existsSync)
}
