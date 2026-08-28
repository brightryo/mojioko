/**
 * REQ-0455 — install the stdout guard as EARLY as possible.
 *
 * A stray `\r` (and potentially other bytes) reached stdout during main-process
 * startup, BEFORE `maybeRunCli` ran — the client split the stream on `\n`,
 * `JSON.parse("\r")`-d the leading segment, and reported
 * "Unexpected end of JSON input". Importing this module FIRST (before any other
 * main import can write) installs the guard when launched as `mojioko mcp`, so
 * only sanctioned JSON-RPC lines ever reach real stdout.
 *
 * The check is a plain `process.argv` scan (no `electron`/`app` dependency) so
 * it is safe to run at module-load time: `mcp` appears as a standalone command
 * token both packaged (`MOJIOKO.exe mcp`) and dev (`electron <appDir> mcp`).
 */
import { installStdoutGuard } from './stdout-guard'

if (process.argv.slice(1).includes('mcp')) {
  installStdoutGuard()
}
