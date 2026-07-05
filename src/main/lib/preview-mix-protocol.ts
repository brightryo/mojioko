import { protocol } from 'electron'
import { existsSync } from 'fs'
import { getPreviewMixPath } from './paths'
import log from './logger'

const NET_ERR_FILE_NOT_FOUND = -6

/**
 * REQ-086 — `mojioko-preview-mix://` custom protocol.
 *
 * Why a dedicated protocol rather than re-using `mojioko-media://`:
 *
 *   `mojioko-media://` carries an opaque (URL-encoded) absolute file
 *   path and gates access through an allowlist populated by
 *   `videoProbe`.  The preview mix lives at a single, fixed,
 *   main-process-resolved path that the renderer should not know about
 *   (MSIX virtualisation means the actual physical path varies per
 *   environment).  A separate protocol keeps the allowlist machinery
 *   focused on user-chosen video files and removes any need to teach
 *   the renderer the AppData layout.
 *
 * URL shape:
 *
 *   mojioko-preview-mix://current?t=<cache-buster>
 *
 *   - The "host" segment is ignored; we always serve the fixed file.
 *   - A query string (typically a timestamp) lets the renderer bust
 *     `<audio>`'s HTTP cache after a regeneration without changing the
 *     resource path.
 *
 * Range support is inherited from Electron's built-in file handler
 * (the same reason `mojioko-media://` uses `registerFileProtocol`
 * rather than `protocol.handle()` — see `video-protocol.ts` for the
 * full rationale).
 *
 * Must be called inside `app.whenReady()`.
 */
export function registerPreviewMixProtocol(): void {
  protocol.registerFileProtocol('mojioko-preview-mix', (_request, callback) => {
    const path = getPreviewMixPath()
    if (!existsSync(path)) {
      log.debug(`[preview-mix-protocol] denied (file not present): ${path}`)
      callback({ error: NET_ERR_FILE_NOT_FOUND })
      return
    }
    callback({ path })
  })
}
