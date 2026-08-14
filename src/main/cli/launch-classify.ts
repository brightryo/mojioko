/**
 * REQ-0459 §1 — pure launch-token classification (no electron / fs imports) so
 * the "is this a CLI command, a `.mojioko` double-click, or a plain GUI launch?"
 * decision is unit-testable.  `cli/index.ts` wires the real `existsSync` and the
 * argv-stripping around this.
 */

/** REQ-0457 — underscore names match the MCP tools; hyphen aliases for CLI ergonomics. */
export const CLI_COMMANDS: ReadonlySet<string> = new Set([
  'tools', 'status', 'transcribe', 'translate', 'burn', 'run', 'mcp',
  'export_frame', 'export-frame', 'probe', 'read_subtitle', 'read-subtitle',
  'edit_subtitle', 'edit-subtitle', 'convert',
  'preset',
  'export-mcpb', 'export_mcpb', // REQ-0467 §2 — headless .mcpb export
])

export const HELP_TOKENS: ReadonlySet<string> = new Set(['help', '-h', '--help'])

/** The project file extension whose double-click opens the GUI (REQ-0459). */
export const PROJECT_EXT = '.mojioko'

/**
 * The `.mojioko` project a file-association / double-click launch wants to open,
 * or null when this is a real CLI invocation.
 *
 * A launch is a project-open (NOT a CLI command) when the FIRST user token is an
 * EXISTING `.mojioko` file and not a known command / help token / flag.  An
 * unknown token that is not such a file stays a CLI invocation (→ USAGE), so the
 * typo error path is unchanged.
 *
 * @param exists  injected existence check (real `fs.existsSync` in production).
 */
export function classifyProjectOpen(tokens: readonly string[], exists: (p: string) => boolean): string | null {
  if (tokens.length === 0) return null
  const head = tokens[0]
  if (CLI_COMMANDS.has(head) || HELP_TOKENS.has(head) || head === '--version' || head.startsWith('-')) return null
  if (head.toLowerCase().endsWith(PROJECT_EXT) && exists(head)) return head
  return null
}

/**
 * REQ-0484 — the `.mojioko` to open from a SECOND-instance relaunch's argv.
 *
 * Unlike a cold launch, the argv Electron hands to the `second-instance` event
 * is NOT clean: Electron prepends its own Chromium switches (observed on Windows:
 * `--allow-file-access-from-files`) and, in dev, the entry-script token, BEFORE
 * the double-clicked path.  `classifyProjectOpen` only inspects tokens[0], so it
 * misses the path and the open silently no-ops — the window just gets focus.
 *
 * A `second-instance` event only fires for a GUI launch (a CLI invocation is
 * dispatched headless BEFORE the single-instance lock and never forwards argv),
 * so the only positional payload here is the double-clicked file.  Scan past the
 * leading switches / script token and return the first EXISTING `.mojioko`.
 *
 * @param exists  injected existence check (real `fs.existsSync` in production).
 */
export function secondInstanceProjectFile(tokens: readonly string[], exists: (p: string) => boolean): string | null {
  for (const tok of tokens) {
    if (tok.startsWith('-')) continue // an Electron/Chromium switch, not the file
    if (tok.toLowerCase().endsWith(PROJECT_EXT) && exists(tok)) return tok
  }
  return null
}
