import { existsSync } from 'fs'
import { isAbsolute, resolve as pathResolve } from 'path'

/**
 * REQ-0103 — normalize a renderer-supplied video path into an absolute,
 * existence-verified path before it is handed to the transcription sidecar
 * (which then hands it to ffmpeg).
 *
 * The renderer picks paths via the OS file dialog, so in practice the incoming
 * path is already absolute — this helper is defensive for two reasons:
 *
 *  1. **Absolute-path normalization** — if a caller ever passes a cwd-relative
 *     path, the sidecar and ffmpeg both resolve it against their own arbitrary
 *     cwd, which is fragile.  Calling `path.resolve` here pins it to the main
 *     process's cwd (the app root).
 *
 *  2. **Explicit existence check** — ffmpeg's own failure ("Error opening
 *     input: No such file or directory") is opaque to the user, especially
 *     when the path in the message contains emoji / middle-dot / pipe that
 *     mojibake in the log viewer's font.  Failing early with the Node-side
 *     path string lets the caller show a clearer error to the user and lets
 *     the debug log record the exact bytes we tried to open.
 *
 * Injection points (`existsFn`, `resolveFn`) are for tests only — production
 * always uses `fs.existsSync` and `path.resolve`.
 */
export interface NormalizeVideoPathDeps {
  existsFn?: (p: string) => boolean
  resolveFn?: (p: string) => string
}

export interface NormalizeVideoPathResult {
  ok: true
  path: string
}

export interface NormalizeVideoPathError {
  ok: false
  error: string
}

export function normalizeVideoPath(
  rawPath: string,
  deps: NormalizeVideoPathDeps = {},
): NormalizeVideoPathResult | NormalizeVideoPathError {
  if (!rawPath) {
    return { ok: false, error: 'empty input path' }
  }

  const resolveFn = deps.resolveFn ?? pathResolve
  const existsFn = deps.existsFn ?? existsSync

  const normalized = isAbsolute(rawPath) ? rawPath : resolveFn(rawPath)

  if (!existsFn(normalized)) {
    return { ok: false, error: `Input file does not exist at ${normalized}` }
  }

  return { ok: true, path: normalized }
}
