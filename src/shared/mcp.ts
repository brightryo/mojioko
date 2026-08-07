/**
 * REQ-0452 — shared shapes for the MCP launch spec used by both the `.mcpb`
 * export (main) and the Settings ▸ AI連携 config/command strings (renderer), so
 * dev vs packaged stays correct in ONE place.
 */

export interface McpLaunchSpec {
  /** The executable to spawn (`process.execPath` — MOJIOKO.exe / electron.exe). */
  command: string
  /**
   * REQ-0455 — args launch the clean-stdout PROXY:
   * `[<out/main/mcp-proxy.js>, ...childArgs]`, where childArgs is `["mcp"]`
   * (packaged) or `[<appDir>, "mcp"]` (dev). The proxy runs as pure Node
   * (via `env.ELECTRON_RUN_AS_NODE`) and re-spawns the real Electron MCP server.
   */
  args: string[]
  /** Env the client must set — includes `ELECTRON_RUN_AS_NODE=1` for the proxy. */
  env: Record<string, string>
  /** false in dev (electron.exe + app-dir arg), true in a packaged build. */
  isPackaged: boolean
}

export interface McpExportResult {
  /** Where the .mcpb was written. */
  path: string
  isPackaged: boolean
  /** Whether `command` resolves to an existing file (safety check, REQ-0452 §3). */
  commandExists: boolean
}
