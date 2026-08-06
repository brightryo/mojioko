/**
 * REQ-0447 — MOJIOKO CLI output layer.
 *
 * Implements the stdout/stderr + exit-code contract from
 * `dev-docs/specs/mojioko-cli.md` §4:
 *   - stdout = the single result JSON line (success or failure envelope).
 *   - stderr = human-readable progress / logs / warnings (JSONL for progress).
 *   - exit code = derived from the stable error-code string.
 *
 * Kept free of `electron` imports so vitest can exercise the exit-code
 * mapping and envelope shapes directly.
 */

export const EXIT_OK = 0

/**
 * Stable CLI error-code string → process exit code (spec §4.1 / §4.2).
 * These strings are a PUBLIC, machine-readable contract: add freely, but do
 * not change or remove an existing string's meaning (backward compatibility).
 */
export const CODE_TO_EXIT: Readonly<Record<string, number>> = {
  USAGE: 2,
  INPUT_NOT_FOUND: 3,
  UNSUPPORTED_FORMAT: 4,
  TOOL_NOT_DOWNLOADED: 5,
  MODEL_NOT_FOUND: 5,
  DEPS_MISSING: 6,
  GPU_INIT_FAILED: 6,
  TRANSCRIBE_FAILED: 7,
  TRANSLATION_FAILED: 7,
  BURN_FAILED: 7,
  OUTPUT_WRITE_FAILED: 8,
  SUBTITLE_OVERFLOW: 9,
  CANCELED: 130,
  NOT_IMPLEMENTED: 1,
  UNEXPECTED: 1,
}

/** Map a stable error-code string to its process exit code (default 1). */
export function exitCodeFor(code: string): number {
  return CODE_TO_EXIT[code] ?? 1
}

/**
 * A CLI failure carrying the stable machine-readable `code`, a human
 * `message`, an optional `remedy` (REQUIRED in the failure JSON per §4.3 —
 * callers should always provide one for user-actionable errors), and an
 * optional structured `detail`.
 */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remedy?: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

/** A non-fatal warning carried in the success envelope's `warnings[]` (§4.4). */
export interface CliWarning {
  code: string
  message: string
  detail?: unknown
}

/** The structured result of a command (what the MCP layer captures). */
export type CliResult =
  | { ok: true; command: string; data: unknown; warnings: CliWarning[] }
  | { ok: false; command: string; code: string; message: string; remedy: string | null; detail: unknown }

export interface CliContext {
  /** `--json` (default true): emit the result JSON on stdout. */
  json: boolean
  /** `--quiet`: suppress stderr progress/info (warnings/errors still shown). */
  quiet: boolean
  /** `--verbose`: emit debug lines on stderr. */
  verbose: boolean
  /**
   * Internal: a sub-step of `run`. Suppresses the success envelope on stdout so
   * only `run`'s final JSON is printed (errors still throw and propagate).
   */
  silent?: boolean
  /**
   * REQ-0450 — MCP capture sink. When set, emitSuccess/emitFailure route the
   * structured result here INSTEAD of stdout, so the MCP server reuses the exact
   * CLI command logic (single source of truth) and returns structured content.
   */
  sink?: (result: CliResult) => void
  /**
   * REQ-0450 — optional progress sink (percent 0..100). The MCP async-job layer
   * uses it to surface progress in get_job_status.
   */
  onProgress?: (percent: number) => void
}

/** A structured progress line on stderr (JSONL). No-op under `--quiet`. */
export function emitProgress(ctx: CliContext, obj: unknown): void {
  if (ctx.onProgress && obj && typeof obj === 'object' && typeof (obj as { percent?: unknown }).percent === 'number') {
    ctx.onProgress((obj as { percent: number }).percent)
  }
  if (ctx.quiet) return
  process.stderr.write(JSON.stringify(obj) + '\n')
}

/** A human log line on stderr. No-op under `--quiet`. */
export function emitLog(ctx: CliContext, message: string): void {
  if (ctx.quiet) return
  process.stderr.write(message + '\n')
}

/** A debug log line on stderr. Only under `--verbose`. */
export function emitDebug(ctx: CliContext, message: string): void {
  if (!ctx.verbose) return
  process.stderr.write(message + '\n')
}

/** Print the success envelope to stdout; returns exit code 0. */
export function emitSuccess(
  ctx: CliContext,
  command: string,
  data: unknown,
  warnings: CliWarning[] = [],
): number {
  if (ctx.sink) {
    ctx.sink({ ok: true, command, data, warnings })
    return EXIT_OK
  }
  if (ctx.silent) return EXIT_OK
  if (ctx.json) {
    process.stdout.write(JSON.stringify({ ok: true, command, data, warnings }) + '\n')
  } else {
    process.stdout.write(`OK ${command}\n`)
  }
  return EXIT_OK
}

/** Print the failure envelope to stdout; returns the mapped exit code (§4.3). */
export function emitFailure(ctx: CliContext, command: string, err: CliError): number {
  const body = {
    ok: false,
    command,
    code: err.code,
    message: err.message,
    detail: err.detail ?? null,
    remedy: err.remedy ?? null,
  }
  if (ctx.sink) {
    ctx.sink({ ok: false, command, code: err.code, message: err.message, remedy: err.remedy ?? null, detail: err.detail ?? null })
    return exitCodeFor(err.code)
  }
  if (ctx.json) {
    process.stdout.write(JSON.stringify(body) + '\n')
  }
  // Always surface a human line on stderr (even under --quiet, errors matter).
  process.stderr.write(
    `ERROR [${err.code}] ${err.message}` + (err.remedy ? `\n  → ${err.remedy}` : '') + '\n',
  )
  return exitCodeFor(err.code)
}
