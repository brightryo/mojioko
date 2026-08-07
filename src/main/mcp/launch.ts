/**
 * REQ-0452 / REQ-0455 — resolve how Claude should launch MOJIOKO's MCP server,
 * correct for both dev and packaged builds.
 *
 * REQ-0455: Electron on Windows writes a leading `\r\n` to stdout at bootstrap
 * (before any JS), which breaks the client's newline-delimited JSON parsing.
 * The only reliable cure is to launch a pure-Node PROXY (via
 * `ELECTRON_RUN_AS_NODE=1`, whose stdout is clean) that re-spawns the real
 * Electron MCP server and strips its leading `\r\n`. So the launch spec now
 * targets `out/main/mcp-proxy.js`:
 *
 *   packaged: execPath  [<app.asar>/out/main/mcp-proxy.js, "mcp"]
 *   dev:      execPath  [<repo>/out/main/mcp-proxy.js, <appDir>, "mcp"]
 *   env:      { ELECTRON_RUN_AS_NODE: "1" }
 *
 * The proxy's `process.argv.slice(2)` = the childArgs (`["mcp"]` packaged /
 * `[<appDir>, "mcp"]` dev), which it hands to the real Electron MCP child
 * (with ELECTRON_RUN_AS_NODE removed).
 */
import { app } from 'electron'
import { join } from 'node:path'
import type { McpLaunchSpec } from '../../shared/mcp'

export function getMcpLaunchSpec(): McpLaunchSpec {
  const isPackaged = app.isPackaged
  const appDir = app.getAppPath()
  const proxyPath = join(appDir, 'out', 'main', 'mcp-proxy.js')
  const childArgs = isPackaged ? ['mcp'] : [appDir, 'mcp']
  return {
    command: process.execPath,
    args: [proxyPath, ...childArgs],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    isPackaged,
  }
}
