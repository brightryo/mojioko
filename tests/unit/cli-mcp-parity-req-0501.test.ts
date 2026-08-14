import { describe, it, expect, vi } from 'vitest'
import { tmpdir } from 'node:os'

// `mcp/tools.ts` imports every command module, which reaches electron via
// `lib/paths`.  Only the SCHEMAS are under test here, so a stub is enough.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() },
}))

const { TOOLS } = await import('../../src/main/mcp/tools')
const { advertisedOptionKeys, helpCommandNames } = await import('../../src/main/cli/help')

/**
 * REQ-0501 §2-4 — every option the CLI advertises must also be reachable
 * through MCP, and vice versa.
 *
 * ## Why
 *
 * MCP schemas declare `additionalProperties: false` and the server drops
 * undeclared keys, so an option missing from a schema is not merely
 * undocumented — it is **unreachable**. REQ-0499 found `burn` lacking
 * `margin_x`/`margin_y` while `export_frame` had them, which silently broke
 * REQ-0468's "a still previews the burn" guarantee for every MCP caller.
 * REQ-0501 found six more on `transcribe` alone.
 *
 * Fixing instances does not stop the next one. This does.
 *
 * ## Scope
 *
 * Only commands that HAVE an MCP tool are checked. `export-mcpb` and `mcp` are
 * deliberately CLI-only (see EXEMPT_COMMANDS), and the process-level flags
 * (`--json`/`--quiet`/`--verbose`/`--strict-args`) have no MCP meaning: the
 * server always runs commands with `json:true, quiet:true` and captures the
 * result, so they never appear in `help.ts`'s per-command `optionSpecs` and
 * never reach here.
 */

/** MCP tool name → the `help.ts` command whose options it must mirror. */
const TOOL_TO_COMMAND: Readonly<Record<string, string>> = {
  status: 'status',
  transcribe: 'transcribe',
  translate: 'translate',
  burn: 'burn',
  run: 'run',
  export_frame: 'export_frame',
  probe: 'probe',
  read_subtitle: 'read_subtitle',
  edit_subtitle: 'edit_subtitle',
  convert: 'convert',
  // `tools_download` / `tools_use` are verb-split facades over the single
  // `tools` command, so their option sets are deliberately narrower than
  // `tools`' advertised set. Checked only in the MCP→CLI direction.
  tools_download: 'tools',
  tools_use: 'tools',
  // REQ-0504 — verb-split facades over the single `preset` command, same
  // shape as tools_download/tools_use.
  preset_list: 'preset',
  preset_show: 'preset',
  preset_save: 'preset',
  preset_delete: 'preset',
}

/**
 * Tools whose arguments are a deliberate subset of the CLI command's.
 *
 * ★ KNOWN GAP (REQ-0505 §2-3, reported not fixed). Listing a tool here skips
 * the CLI→MCP direction ENTIRELY for its command, so an option advertised on
 * `tools` or `preset` can be missing from every one of its MCP facades and this
 * suite stays green. Measured: adding a CLI-only `--probe-hole` to `preset`
 * passes, while the same on `burn` is caught.
 *
 * That is how `preset --force` (help-only, never in the MCP schemas) went
 * undetected until it was removed by hand.
 *
 * The skip exists because a verb-split facade legitimately takes fewer
 * arguments than the umbrella command — `preset_delete` should not have to
 * declare `--from`. Closing it properly means declaring, per facade, WHICH
 * subset it owns, so the union can be checked against the command. That is a
 * real design change rather than a one-line fix, so it is recorded here instead
 * of being silently tolerated.
 */
const SUBSET_TOOLS = new Set(['tools_download', 'tools_use', 'preset_list', 'preset_show', 'preset_save', 'preset_delete'])

/**
 * CLI commands with no MCP tool at all.
 *
 * `export-mcpb` writes a Claude Desktop bundle; exposing it AS an MCP tool
 * would let a session rewrite its own launcher, so `mojioko-mcp.md` keeps it
 * CLI-only. `mcp` starts the server and cannot be a tool of itself. `help` is
 * replaced by `tools/list`.
 */
const EXEMPT_COMMANDS = new Set(['export-mcpb', 'mcp', 'help'])

/**
 * Advertised CLI options that intentionally have no MCP property.
 *
 * Empty on purpose: every current exemption turned out to be a bug. Adding an
 * entry here is a claim that MCP callers must NOT have the option, and needs a
 * reason next to it.
 */
const EXEMPT_OPTIONS: Readonly<Record<string, readonly string[]>> = {}

/** MCP `snake_case` property → CLI `kebab-case` option key. */
const toCliKey = (prop: string): string => prop.replace(/_/g, '-')

/** Property keys a tool's `inputSchema` declares (positionals included). */
function schemaProps(toolName: string): string[] {
  const tool = TOOLS.find((t) => t.name === toolName)
  if (!tool) throw new Error(`no MCP tool named ${toolName}`)
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
  return Object.keys(props)
}

/**
 * MCP properties that are POSITIONALS on the CLI side, not options.
 *
 * `burn`'s video/subtitle are `args.positionals[0..1]`; MCP has no positional
 * concept so they become properties. They correctly have no `optionSpec`.
 */
const POSITIONAL_PROPS = new Set(['input', 'video', 'subtitle', 'out', 'target', 'value', 'text', 'index', 'time', 'to', 'name'])

describe('REQ-0501 §2-4 — CLI ↔ MCP option parity', () => {
  it.each(Object.keys(TOOL_TO_COMMAND))('%s: every advertised CLI option is reachable via MCP', (tool) => {
    if (SUBSET_TOOLS.has(tool)) return
    const command = TOOL_TO_COMMAND[tool]
    const exempt = new Set(EXEMPT_OPTIONS[command] ?? [])
    const mcpKeys = new Set(schemaProps(tool).map(toCliKey))
    const missing = advertisedOptionKeys(command).filter((k) => !mcpKeys.has(k) && !exempt.has(k))
    expect(missing, `${tool} is missing: ${missing.join(', ')}`).toEqual([])
  })

  it.each(Object.keys(TOOL_TO_COMMAND))('%s: every MCP property maps to a real CLI option', (tool) => {
    const command = TOOL_TO_COMMAND[tool]
    const advertised = new Set(advertisedOptionKeys(command))
    const stray = schemaProps(tool)
      .filter((p) => !POSITIONAL_PROPS.has(p))
      .map(toCliKey)
      .filter((k) => !advertised.has(k))
    expect(stray, `${tool} declares options the CLI does not advertise: ${stray.join(', ')}`).toEqual([])
  })

  it('every MCP tool is mapped (a new tool cannot skip this gate)', () => {
    const jobTools = new Set(['get_job_status', 'list_jobs', 'cancel_job'])
    for (const t of TOOLS) {
      if (jobTools.has(t.name)) continue
      expect(TOOL_TO_COMMAND[t.name], `unmapped MCP tool: ${t.name}`).toBeDefined()
    }
  })

  it('every CLI command has an MCP tool, or is explicitly exempt', () => {
    // REQ-0504 — derived from help rather than a hand-written list. The
    // hard-coded version silently ignored `preset` when it was added, which is
    // the precise failure this gate exists to prevent: a new CLI command that
    // never reaches MCP because nobody remembered to extend the checklist.
    const mapped = new Set(Object.values(TOOL_TO_COMMAND))
    for (const c of helpCommandNames()) {
      expect(mapped.has(c) || EXEMPT_COMMANDS.has(c), `unmapped CLI command: ${c}`).toBe(true)
    }
  })
})
