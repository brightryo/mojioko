/**
 * REQ-0452 / REQ-0455 / REQ-0458 — shared shapes for the MCP launch spec used by
 * both the `.mcpb` export (main) and the Settings ▸ AI連携 config/command strings
 * (renderer), so dev vs packaged stays correct in ONE place.
 */

/**
 * REQ-0458 §1 — the version of the LAUNCH SPEC SHAPE (command / args / env).
 *
 * Bump this ONLY when the way Claude must launch the server changes — a new
 * proxy path scheme, a new env var, a different arg order.  Do NOT bump it for
 * tool additions / behaviour changes / bug fixes (those ship with an app
 * update and need no re-install).  The value is baked into the exported bundle
 * (manifest version + an env var), and the running server compares the value it
 * was launched with against this constant to detect a stale bundle (§2).
 *
 * History: revision 1 = the REQ-0455 clean-stdout proxy launch
 * (`execPath [<mcp-proxy.js>, ...childArgs]`, env `ELECTRON_RUN_AS_NODE=1`).
 */
export const LAUNCH_SPEC_REVISION = 1

/** Env var carrying the launch-spec revision the bundle was written with (§2). */
export const LAUNCH_SPEC_REV_ENV = 'MOJIOKO_LAUNCH_SPEC_REV'

/** The remedy string surfaced when a stale bundle is detected (§2). */
export const MCP_REEXPORT_REMEDY =
  'MOJIOKO の「設定 ▸ AI連携」タブから「MCP 拡張を書き出す」を実行し、Claude Desktop で拡張を入れ直してください（起動方法が更新されています）。'

/**
 * REQ-0458 §1 — the `.mcpb` manifest `version`, encoding BOTH the app version
 * and the launch-spec revision so a bundle identifies which app AND which launch
 * method wrote it.  Uses SemVer build metadata (`1.4.0+lsr.1`), which is valid
 * SemVer and ignored for version precedence.
 */
export function mcpManifestVersion(appVersion: string): string {
  return `${appVersion}+lsr.${LAUNCH_SPEC_REVISION}`
}

export interface McpLaunchSpec {
  /** The executable to spawn (`process.execPath` — MOJIOKO.exe / electron.exe). */
  command: string
  /**
   * REQ-0455 — args launch the clean-stdout PROXY:
   * `[<out/main/mcp-proxy.js>, ...childArgs]`, where childArgs is `["mcp"]`
   * (packaged) or `[<appDir>, "mcp"]` (dev). The proxy runs as pure Node
   * (via `env.ELECTRON_RUN_AS_NODE`) and re-spawns the real Electron MCP server.
   */
  args: string[]
  /**
   * Env the client must set — `ELECTRON_RUN_AS_NODE=1` for the proxy plus
   * `MOJIOKO_LAUNCH_SPEC_REV` (REQ-0458) so the server can detect a stale bundle.
   */
  env: Record<string, string>
  /** false in dev (electron.exe + app-dir arg), true in a packaged build. */
  isPackaged: boolean
  /** REQ-0458 — the launch-spec revision baked into this spec. */
  launchSpecRevision: number
  /** REQ-0458 — the app version producing this spec. */
  appVersion: string
  /** REQ-0458 §3 — the last bundle this app exported (from settings), if any. */
  lastExport?: McpExportRecord | null
}

/** REQ-0458 §3 — persisted record of the most recently exported `.mcpb`. */
export interface McpExportRecord {
  appVersion: string
  launchSpecRevision: number
  exportedAtMs: number
  path: string
}

export interface McpExportResult {
  /** Where the .mcpb was written. */
  path: string
  isPackaged: boolean
  /** Whether `command` resolves to an existing file (safety check, REQ-0452 §3). */
  commandExists: boolean
  /** REQ-0458 — the app version + launch-spec revision baked into the bundle. */
  appVersion: string
  launchSpecRevision: number
}

/** REQ-0458 §2 — result of comparing the launched bundle against the current spec. */
export interface LaunchStaleness {
  /** True when the server was launched by a bundle written for a DIFFERENT launch-spec revision. */
  stale: boolean
  /** The revision the running bundle declared (via env), or null when launched directly (not via a bundle). */
  launchedRevision: number | null
  /** The revision the current app expects (`LAUNCH_SPEC_REVISION`). */
  expectedRevision: number
  /** The re-export remedy when stale; null otherwise. */
  remedy: string | null
}

/**
 * REQ-0458 §2 — decide whether the running server was launched by a stale
 * bundle, from the raw `MOJIOKO_LAUNCH_SPEC_REV` env value.
 *
 * - undefined / empty  ⇒ launched DIRECTLY (a raw `mojioko mcp`, not via a
 *   bundle): not stale, `launchedRevision = null`.  A directly-invoked server
 *   carries no bundle to be stale.
 * - a number == current ⇒ up to date.
 * - anything else       ⇒ stale (old bundle): warn + remedy.
 */
export function evaluateLaunchStaleness(launchedRevRaw: string | undefined): LaunchStaleness {
  const expectedRevision = LAUNCH_SPEC_REVISION
  if (launchedRevRaw === undefined || launchedRevRaw === '') {
    return { stale: false, launchedRevision: null, expectedRevision, remedy: null }
  }
  const launchedRevision = Number.parseInt(launchedRevRaw, 10)
  const parsed = Number.isFinite(launchedRevision) ? launchedRevision : null
  const stale = parsed !== expectedRevision
  return {
    stale,
    launchedRevision: parsed,
    expectedRevision,
    remedy: stale ? MCP_REEXPORT_REMEDY : null,
  }
}
