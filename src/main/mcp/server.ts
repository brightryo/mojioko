/**
 * REQ-0450 §1 — MOJIOKO MCP server (stdio, hand-rolled JSON-RPC 2.0).
 *
 * `mojioko mcp` runs this: a resident, headless (no window) MCP server speaking
 * newline-delimited JSON-RPC over stdio. It advertises the CLI-backed tools
 * (see `./tools`) and stays alive until stdin closes. No MCP SDK dependency —
 * the subset used (initialize / tools.list / tools.call / ping / notifications)
 * is small and stable.
 *
 * stdout carries ONLY JSON-RPC messages: the electron-log console transport is
 * silenced here, command output is captured via the `sink` context (never
 * written to stdout), and sidecar/ffmpeg output goes to their own pipes.
 */
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import log from 'electron-log/main'
import { APP_VERSION } from '../../shared/app-info'
import { toolList, callTool, GET_JOB_STATUS_TOOL } from './tools'

const PROTOCOL_VERSION = '2024-11-05'

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export async function runMcpServer(): Promise<number> {
  // Keep stdout PURE JSON-RPC.
  try {
    log.transports.console.level = false
  } catch {
    // logger shape changed — non-fatal
  }

  const send = (msg: object): void => {
    process.stdout.write(JSON.stringify(msg) + '\n')
  }
  const reply = (id: JsonRpcMessage['id'], result: unknown): void => send({ jsonrpc: '2.0', id, result })
  const replyError = (id: JsonRpcMessage['id'], code: number, message: string): void =>
    send({ jsonrpc: '2.0', id, error: { code, message } })

  // Electron's main-process `process.stdin` does NOT deliver piped input (it
  // goes straight to 'end'); reading fd 0 directly does. Verified empirically.
  const stdin = createReadStream(null as unknown as string, { fd: 0 })
  stdin.setEncoding('utf8')
  const rl = createInterface({ input: stdin, terminal: false })

  async function handle(msg: JsonRpcMessage): Promise<void> {
    const { id, method, params } = msg
    if (typeof method !== 'string') return
    const isRequest = id !== undefined && id !== null

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
        return // notifications — no reply
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
          reply(id, {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
            isError,
          })
        } catch (e) {
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

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: JsonRpcMessage
    try {
      msg = JSON.parse(trimmed)
    } catch {
      return // ignore non-JSON noise
    }
    void handle(msg)
  })

  return new Promise<number>((resolve) => {
    rl.on('close', () => resolve(0))
    stdin.on('end', () => resolve(0))
    stdin.on('error', () => resolve(0))
  })
}
