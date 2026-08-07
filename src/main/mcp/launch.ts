/**
 * REQ-0452 — resolve how Claude should launch MOJIOKO's MCP server, correct for
 * both dev and packaged builds.
 *
 *   packaged: `MOJIOKO.exe mcp`         → command = execPath, args = ["mcp"]
 *   dev:      `electron.exe <appDir> mcp` → command = execPath (electron.exe),
 *                                           args = [app.getAppPath(), "mcp"]
 *
 * In dev, `process.execPath` is electron.exe and the app-dir arg is REQUIRED
 * (the dispatcher drops a leading app-dir/`.`/`*.js` token — see
 * `cli/index.ts:userCliArgs`), so omitting it produced a non-launching bundle.
 */
import { app } from 'electron'
import type { McpLaunchSpec } from '../../shared/mcp'

export function getMcpLaunchSpec(): McpLaunchSpec {
  const isPackaged = app.isPackaged
  return {
    command: process.execPath,
    args: isPackaged ? ['mcp'] : [app.getAppPath(), 'mcp'],
    isPackaged,
  }
}
