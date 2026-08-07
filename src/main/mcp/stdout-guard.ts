/**
 * REQ-0455 — strict stdout framing for the MCP stdio transport.
 *
 * Root cause of "Unexpected end of JSON input": a stray write to stdout (a bare
 * newline / a log line / Electron output) creates an empty segment when the
 * client splits the stream on `\n` and `JSON.parse("")`s it.
 *
 * The guard makes stdout single-writer:
 *   - `writeJsonRpc(obj)` is the ONLY sanctioned path — it writes exactly
 *     `JSON.stringify(obj) + "\n"` (no BOM, no CRLF, no leading/blank lines) via
 *     the ORIGINAL `process.stdout.write`.
 *   - `process.stdout.write` is replaced so ANY other write (from anywhere,
 *     including startup before whenReady) is DIVERTED to stderr — and the first
 *     few are logged to mcp.log with a hex dump + stack (§0 diagnosis).
 *
 * Installed as early as possible (see `cli/index.ts` for the mcp branch) so it
 * catches writes that happen before the server loop starts.
 */
import { mcpLog } from './mcp-log'

type WriteFn = typeof process.stdout.write

let realWrite: WriteFn | null = null
let installed = false
let strayLogged = 0

export function installStdoutGuard(): void {
  if (installed) return
  installed = true
  realWrite = process.stdout.write.bind(process.stdout) as WriteFn

  const guarded = function (this: unknown, chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    const callback = typeof encoding === 'function' ? (encoding as () => void) : typeof cb === 'function' ? (cb as () => void) : undefined
    try {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk)
      if (strayLogged < 20) {
        strayLogged++
        const hex = Buffer.from(text, 'utf8').subarray(0, 48).toString('hex')
        const stack = new Error().stack?.split('\n').slice(2, 5).map((s) => s.trim()).join(' | ')
        mcpLog(`STRAY stdout write → stderr: len=${text.length} hex=${hex} @ ${stack}`)
      }
      process.stderr.write(text)
    } catch {
      /* never throw from the write hook */
    }
    if (callback) callback()
    return true
  } as WriteFn

  process.stdout.write = guarded
}

/** The ONLY sanctioned way to write a JSON-RPC message to real stdout. */
export function writeJsonRpc(obj: unknown): void {
  const line = JSON.stringify(obj) + '\n'
  if (realWrite) {
    realWrite(line)
  } else {
    // Guard not installed (should not happen in mcp mode) — write directly.
    process.stdout.write(line)
  }
}
