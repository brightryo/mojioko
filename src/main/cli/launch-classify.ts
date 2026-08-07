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
