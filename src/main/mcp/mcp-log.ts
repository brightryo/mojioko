/**
 * REQ-0454 §0 — MCP-mode diagnostic log.
 *
 * `mojioko mcp` writes to `%APPDATA%/MOJIOKO/logs/mcp.log` from the earliest
 * point (before `app.whenReady`) so a failure in a client (Claude Desktop) can
 * be diagnosed after the fact. Uses `process.env.APPDATA` directly (no
 * dependency on `app` being ready), never throws, and NEVER writes to stdout
 * (stdout is reserved for JSON-RPC).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

function mcpLogPath(): string {
  const base = process.env.APPDATA || join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming')
  return join(base, 'MOJIOKO', 'logs', 'mcp.log')
}

let ensured = false

export function mcpLog(message: string): void {
  try {
    const path = mcpLogPath()
    if (!ensured) {
      mkdirSync(dirname(path), { recursive: true })
      ensured = true
    }
    appendFileSync(path, `[${new Date().toISOString()}] ${message}\n`, 'utf8')
  } catch {
    // Logging must never break the server.
  }
}
