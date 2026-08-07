/**
 * REQ-0452 — shared shapes for the MCP launch spec used by both the `.mcpb`
 * export (main) and the Settings ▸ AI連携 config/command strings (renderer), so
 * dev vs packaged stays correct in ONE place.
 */

export interface McpLaunchSpec {
  /** The executable to spawn (`process.execPath` — MOJIOKO.exe / electron.exe). */
  command: string
  /** Args: packaged = `["mcp"]`; dev = `[<appDir>, "mcp"]`. */
  args: string[]
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
