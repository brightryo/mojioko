import { protocol } from 'electron'
import { existsSync } from 'fs'
import { getPreviewMixFilePath, isPreviewMixFilename } from './paths'
import log from './logger'

const NET_ERR_FILE_NOT_FOUND = -6

/**
 * REQ-086 / REQ-0231 — `mojioko-preview-mix://` custom protocol.
 *
 * Why a dedicated protocol rather than re-using `mojioko-media://`:
 *
 *   `mojioko-media://` carries an opaque (URL-encoded) absolute file
 *   path and gates access through an allowlist populated by
 *   `videoProbe`.  The preview mix lives under a single, fixed,
 *   main-process-resolved directory that the renderer should not know
 *   about (MSIX virtualisation means the actual physical path varies
 *   per environment).  A separate protocol keeps the allowlist
 *   machinery focused on user-chosen video files and removes any need
 *   to teach the renderer the AppData layout.
 *
 * URL shape (REQ-0231):
 *
 *   mojioko-preview-mix://current/<filename>?t=<cache-buster>
 *
 *   - The URL path (`/<filename>`) selects which file inside the
 *     preview-mix directory to serve.  REQ-0231 moved to per-run
 *     unique filenames (see `paths.ts:generatePreviewMixFilename`) so
 *     the URL identifies exactly one mix — no stale-file confusion
 *     across runs.
 *   - The filename is validated with `isPreviewMixFilename` before we
 *     touch the filesystem.  Anything not matching (path traversal
 *     attempts, wrong extension, missing prefix) is denied as
 *     file-not-found.  This is the only place the URL host / path
 *     input reaches the disk, so validation here is load-bearing.
 *   - The "authority" segment (`current`) is a no-op label; kept for
 *     URL readability in devtools + log lines.
 *   - `?t=<timestamp>` is the cache buster the renderer sets on each
 *     new mix so `<audio>` re-fetches instead of serving Chromium's
 *     cached body.
 *
 * Range support is inherited from Electron's built-in file handler
 * (the same reason `mojioko-media://` uses `registerFileProtocol`
 * rather than `protocol.handle()` — see `video-protocol.ts` for the
 * full rationale).
 *
 * Must be called inside `app.whenReady()`.
 */
export function registerPreviewMixProtocol(): void {
  protocol.registerFileProtocol('mojioko-preview-mix', (request, callback) => {
    let filename: string | null = null
    try {
      const url = new URL(request.url)
      // pathname is "/<filename>" — strip the leading slash.
      const stripped = url.pathname.replace(/^\/+/, '')
      // decodeURIComponent handles cases where the renderer URL-encoded
      // parts of the filename; our own generator produces ASCII-only
      // names so this is defensive only.
      filename = decodeURIComponent(stripped)
    } catch (err) {
      log.debug(`[preview-mix-protocol] URL parse failed for ${request.url}: ${String(err)}`)
      callback({ error: NET_ERR_FILE_NOT_FOUND })
      return
    }

    if (!filename || !isPreviewMixFilename(filename)) {
      log.debug(
        `[preview-mix-protocol] denied (invalid filename): ${JSON.stringify(filename)}`,
      )
      callback({ error: NET_ERR_FILE_NOT_FOUND })
      return
    }

    const path = getPreviewMixFilePath(filename)
    if (!existsSync(path)) {
      log.debug(`[preview-mix-protocol] denied (file not present): ${path}`)
      callback({ error: NET_ERR_FILE_NOT_FOUND })
      return
    }
    callback({ path })
  })
}
