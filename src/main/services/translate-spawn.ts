/**
 * REQ-0494 — pure spawn-target resolver for the translation sidecar.
 *
 * Kept in its own electron-free module so the invariant it encodes can be
 * unit-tested without pulling `electron` / `fs` / paths into the test env
 * (mirrors how the CLI's pure logic lives in electron-free modules).
 *
 * The invariant (RES-0493 §3-2 proposal 3): a **packaged** build must resolve
 * the translation sidecar to the bundled PyInstaller exe (via its `translate`
 * subcommand) and must NEVER silently fall back to a raw Python interpreter —
 * a packaged build has no interpreter, which was the `PYTHON_MISSING` bug.
 */

export interface TranslateSpawnResolution {
  /** Executable to spawn (bundled PyInstaller exe, or the dev .venv python). */
  exe: string
  /** Args: ['translate'] for the bundled exe subcommand, or [translate.py]. */
  args: string[]
  mode: 'bundled' | 'venv'
}

/**
 * Mirrors transcription-sidecar's `resolveSidecarSpawn`: **packaged → bundled
 * exe first; dev → .venv python**.  The bundled transcriber exe doubles as the
 * translation engine through its `translate` subcommand (one PyInstaller bundle
 * serves both — REQ-0494), so the packaged branch reuses the transcriber exe
 * with args `['translate']`.
 *
 * Throws `PYTHON_MISSING` only when neither a bundled exe (packaged) nor a
 * .venv python (dev) is available — the same error contract as before, but now
 * unreachable in a correctly-packaged build.
 */
export function pickTranslateSpawn(opts: {
  isPackaged: boolean
  bundledExe: string | null
  pythonExe: string | null
  translateScript: string
}): TranslateSpawnResolution {
  if (opts.isPackaged) {
    if (opts.bundledExe) return { exe: opts.bundledExe, args: ['translate'], mode: 'bundled' }
    // Bundle missing (only happens while locally debugging a packaged build) —
    // fall through to the .venv python below rather than hard-failing.
  }
  if (opts.pythonExe) return { exe: opts.pythonExe, args: [opts.translateScript], mode: 'venv' }
  throw new Error('PYTHON_MISSING')
}
