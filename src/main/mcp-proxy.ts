/**
 * REQ-0455 — MCP clean-stdout proxy entry (a SECOND main build output:
 * `out/main/mcp-proxy.js`).
 *
 * Launched via `ELECTRON_RUN_AS_NODE=1` so this process runs as pure Node with a
 * clean stdout (Electron's Windows bootstrap `\r\n` does not appear). It spawns
 * the real Electron MCP server and forwards stdio, stripping the child's leading
 * newline junk. Deliberately imports NO `electron` — see `./mcp/proxy`.
 */
import { runMcpProxy } from './mcp/proxy'

runMcpProxy()
