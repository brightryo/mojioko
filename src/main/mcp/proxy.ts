/**
 * REQ-0455 — clean-stdout proxy for the MCP server.
 *
 * Electron on Windows writes a `\r\n` to stdout at BOOTSTRAP (before any JS
 * runs — confirmed: even a trivial main emits it, and no switch/env except
 * ELECTRON_RUN_AS_NODE suppresses it). That leading `\r\n` makes the MCP
 * client's newline-split produce a `"\r"` segment → `JSON.parse` →
 * "Unexpected end of JSON input".
 *
 * This proxy runs as PURE NODE (the launcher sets ELECTRON_RUN_AS_NODE=1, whose
 * stdout is clean), spawns the REAL Electron MCP server as a child, and
 * forwards stdio — STRIPPING the child's leading bootstrap newline(s) so the
 * client receives a clean newline-delimited JSON-RPC stream.
 *
 * Pure Node only (no `electron` import): `mcp-log` depends only on fs/path.
 */
import { spawn } from 'node:child_process'
import { mcpLog } from './mcp-log'

export function runMcpProxy(): void {
  // process.argv (RUN_AS_NODE) = [execPath, <this-script>, ...childArgs].
  // The child is the SAME executable launched as real Electron (no RUN_AS_NODE)
  // with childArgs (packaged: ["mcp"]; dev: [<appDir>, "mcp"]).
  const childArgs = process.argv.slice(2)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  mcpLog(`PROXY start execPath=${process.execPath} childArgs=${JSON.stringify(childArgs)}`)

  const child = spawn(process.execPath, childArgs, { env, stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })

  // Forward our (clean) stdin → child stdin.
  process.stdin.pipe(child.stdin)

  // Strip the child's leading bootstrap newline junk ONCE, then pass through.
  let stripped = false
  child.stdout.on('data', (chunk: Buffer) => {
    if (!stripped) {
      let i = 0
      while (i < chunk.length && (chunk[i] === 0x0d || chunk[i] === 0x0a)) i++
      if (i > 0) mcpLog(`PROXY stripped ${i} leading newline byte(s) from child stdout`)
      chunk = chunk.subarray(i)
      if (chunk.length === 0) return // whole chunk was junk — wait for the next
      stripped = true
    }
    process.stdout.write(chunk)
  })

  child.on('exit', (code) => {
    mcpLog(`PROXY child exit ${code}`)
    process.exit(code ?? 0)
  })
  child.on('error', (e) => {
    mcpLog(`PROXY child spawn error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  })
}
