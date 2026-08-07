/**
 * REQ-0450 §1 / REQ-0454 — MOJIOKO MCP server (stdio, hand-rolled JSON-RPC 2.0).
 *
 * `mojioko mcp` runs this: a resident, headless (no window) MCP server speaking
 * newline-delimited JSON-RPC over stdio, until stdin closes. No MCP SDK.
 *
 * REQ-0454 hardening (the "Unexpected end of JSON input" = server exited without
 * a valid response):
 *   - stdout carries ONLY JSON-RPC: electron-log's console transport is
 *     silenced AND console.log/info/debug are redirected to stderr, so no stray
 *     library/app output corrupts the stream.
 *   - stdin is read from fd 0 (Electron main `process.stdin` doesn't deliver
 *     piped input); if that stream errors we log + fall back to `process.stdin`
 *     rather than exit silently.
 *   - everything is logged to `%APPDATA%/MOJIOKO/logs/mcp.log` (argv/env/exit)
 *     for post-mortem diagnosis in a client.
 *   - uncaught errors are logged, never crash the process silently.
 */
import { createInterface, type Interface } from 'node:readline'
import { createReadStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { app } from 'electron'
import log from 'electron-log/main'
import { APP_VERSION } from '../../shared/app-info'
import { toolList, callTool, GET_JOB_STATUS_TOOL } from './tools'
import { mcpLog } from './mcp-log'
import { installStdoutGuard, writeJsonRpc } from './stdout-guard'

const PROTOCOL_VERSION = '2024-11-05'

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

/** Keep stdout pure: silence electron-log console + route console.* to stderr. */
function purifyStdout(): void {
  try {
    log.transports.console.level = false
  } catch {
    /* logger shape changed — non-fatal */
  }
  const toErr = (...args: unknown[]): void => {
    try {
      process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n')
    } catch {
      /* ignore */
    }
  }
  // console.log/info/debug default to stdout — redirect so nothing but JSON-RPC
  // lands there. console.warn/error already go to stderr.
  console.log = toErr
  console.info = toErr
  console.debug = toErr
}

export async function runMcpServer(): Promise<number> {
  installStdoutGuard() // idempotent — normally installed earlier (cli dispatch)
  purifyStdout()
  mcpLog(
    `START pid=${process.pid} isPackaged=${app.isPackaged} execPath=${process.execPath} ` +
      `cwd=${process.cwd()} argv=${JSON.stringify(process.argv.slice(1))}`,
  )

  // Never let an uncaught error kill the server without a trace.
  process.on('uncaughtException', (e) => mcpLog(`uncaughtException: ${e instanceof Error ? e.stack ?? e.message : String(e)}`))
  process.on('unhandledRejection', (e) => mcpLog(`unhandledRejection: ${e instanceof Error ? e.message : String(e)}`))
  process.on('exit', (code) => mcpLog(`process exit code=${code}`))

  // REQ-0455 — the ONLY sanctioned stdout writer (JSON + single \n, via the
  // real stdout under the guard). Every other write goes to stderr.
  const send = (msg: object): void => writeJsonRpc(msg)
  const reply = (id: JsonRpcMessage['id'], result: unknown): void => send({ jsonrpc: '2.0', id, result })
  const replyError = (id: JsonRpcMessage['id'], code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } })

  async function handle(msg: JsonRpcMessage): Promise<void> {
    const { id, method, params } = msg
    if (typeof method !== 'string') return
    const isRequest = id !== undefined && id !== null
    mcpLog(`recv method=${method}${method === 'tools/call' ? ` name=${String(params?.name)}` : ''}`)

    switch (method) {
      case 'initialize':
        reply(id, {
          protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'mojioko', version: APP_VERSION },
        })
        return
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return
      case 'ping':
        reply(id, {})
        return
      case 'tools/list':
        reply(id, { tools: [...toolList(), GET_JOB_STATUS_TOOL] })
        return
      case 'tools/call': {
        const name = params?.name
        const args = params?.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}
        if (typeof name !== 'string') {
          replyError(id, -32602, 'Invalid params: missing tool name')
          return
        }
        try {
          const { structured, isError } = await callTool(name, args)
          reply(id, { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, isError })
        } catch (e) {
          mcpLog(`tools/call ${name} threw: ${e instanceof Error ? e.message : String(e)}`)
          reply(id, {
            content: [{ type: 'text', text: JSON.stringify({ ok: false, code: 'UNEXPECTED', message: e instanceof Error ? e.message : String(e) }) }],
            isError: true,
          })
        }
        return
      }
      default:
        if (isRequest) replyError(id, -32601, `Method not found: ${method}`)
        return
    }
  }

  return new Promise<number>((resolve) => {
    let settled = false
    const done = (why: string): void => {
      if (settled) return
      settled = true
      mcpLog(`server stopping: ${why}`)
      resolve(0)
    }

    const attach = (input: Readable, label: string): Interface => {
      mcpLog(`stdin: reading via ${label}`)
      input.setEncoding('utf8')
      const rl = createInterface({ input, terminal: false })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let msg: JsonRpcMessage
        try {
          msg = JSON.parse(trimmed)
        } catch {
          mcpLog(`stdin: ignored non-JSON line (${trimmed.length} chars)`)
          return
        }
        void handle(msg)
      })
      rl.on('close', () => done(`${label} closed`))
      return rl
    }

    // Electron main `process.stdin` does not deliver piped input; read fd 0.
    // If that fails, fall back to `process.stdin` rather than exit silently.
    let primary: Readable
    try {
      primary = createReadStream(null as unknown as string, { fd: 0 })
    } catch (e) {
      mcpLog(`fd0 createReadStream threw: ${e instanceof Error ? e.message : String(e)} — falling back to process.stdin`)
      attach(process.stdin, 'process.stdin')
      process.stdin.resume()
      return
    }
    primary.on('error', (e) => {
      mcpLog(`fd0 stream error: ${e instanceof Error ? e.message : String(e)} — falling back to process.stdin`)
      if (!settled) {
        attach(process.stdin, 'process.stdin (fallback)')
        process.stdin.resume()
      }
    })
    attach(primary, 'fd0')
  })
}
