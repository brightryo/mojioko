import { protocol } from 'electron'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import log from './logger'

// Chromium net error codes used in `callback({ error })`.
// Full list: https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h
const NET_ERR_FILE_NOT_FOUND = -6
const NET_ERR_ACCESS_DENIED = -10

/**
 * Canonical (realpath-resolved) file system paths that the renderer is
 * allowed to stream via `mojioko-media://`.  Populated as a side effect of
 * `videoProbe` IPC success — see `src/main/ipc/video.ts`.
 *
 * Defense-in-depth: even if a renderer-side XSS or bug forms a malicious
 * `mojioko-media://...` URL pointing at e.g. `C:\Windows\System32\...`, the
 * file is never served unless it has been explicitly probed in this session.
 */
const allowedRealPaths = new Set<string>()

/**
 * Add a video path to the allowlist.  The path is canonicalised
 * (`path.resolve` + `fs.realpathSync`) before being stored so future
 * comparisons match regardless of casing on case-insensitive file systems,
 * intermediate `..` segments, or symlink indirection.
 *
 * Silently no-ops if the path does not currently exist or cannot be
 * resolved — the protocol handler will deny access if the URL is later
 * requested anyway.
 */
export function allowVideoPath(filePath: string): void {
  try {
    const canonical = realpathSync(resolve(filePath))
    allowedRealPaths.add(canonical)
  } catch {
    // Path missing / unresolvable — skip.  Denial happens naturally in the
    // protocol handler when no matching entry is found.
  }
}

/**
 * Register the `mojioko-media://` custom protocol so the renderer can stream
 * local video files — but ONLY from the allowlist populated by `videoProbe`.
 *
 * `protocol.registerFileProtocol` is used instead of the newer
 * `protocol.handle()` + `net.fetch()` because the latter does not
 * automatically forward HTTP Range headers — which Chrome always sends for
 * <video> elements — causing the very first load to fail.
 *
 * URL format produced by the renderer helper `pathToVideoUrl()`:
 *   mojioko-media://D%3A%5Cpath%5Cfile.mp4    (Windows, encodeURIComponent)
 *   mojioko-media:///home/user/file.mp4        (macOS / Linux)
 *
 * Range requests (seeking) are handled automatically by Electron's built-in
 * file-serving path invoked through `callback({ path })`.
 *
 * Must be called inside `app.whenReady()`.
 */
export function registerVideoProtocol(): void {
  // registerFileProtocol is deprecated in favour of protocol.handle(), but
  // protocol.handle() + net.fetch('file://') does not forward the HTTP Range
  // header that Chrome always sends for <video> elements, causing load failure.
  // registerFileProtocol delegates to Electron's built-in file handler which
  // supports range requests natively.
  protocol.registerFileProtocol('mojioko-media', (request, callback) => {
    const prefix = 'mojioko-media://'
    const encoded = request.url.startsWith(prefix)
      ? request.url.slice(prefix.length)
      : request.url
    const decoded = decodeURIComponent(encoded)

    // Canonicalise the requested path — this collapses `..` traversal and
    // resolves symlinks to their real targets, so the allowlist check uses
    // the same canonical form `allowVideoPath` stored.
    let canonical: string
    try {
      canonical = realpathSync(resolve(decoded))
    } catch {
      // File does not exist or is inaccessible — deny cleanly.
      log.debug(`[video-protocol] denied (cannot resolve): ${decoded}`)
      callback({ error: NET_ERR_FILE_NOT_FOUND })
      return
    }

    if (!allowedRealPaths.has(canonical)) {
      log.debug(`[video-protocol] denied (not in allowlist): ${canonical}`)
      callback({ error: NET_ERR_ACCESS_DENIED })
      return
    }

    callback({ path: canonical })
  })
}
