import { protocol } from 'electron'
import { realpathSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { FONT_REGISTRY, type FontId, getFontMeta, isFontId } from '../../shared/fonts'
import { getFontResolveDir } from './paths'
import log from './logger'

const NET_ERR_FILE_NOT_FOUND = -6
const NET_ERR_ACCESS_DENIED = -10

/**
 * Custom `mojioko-font://` protocol.  Serves TTF / OFL bytes from either the
 * bundled font directory (read-only, ships with the installer) or the user
 * font directory (`%APPDATA%/MOJIOKO/fonts/<id>/`).
 *
 * URL shapes:
 *   mojioko-font://<font-id>/ttf       → the TTF for that font
 *   mojioko-font://<font-id>/ofl       → OFL.txt sibling
 *
 * Defense-in-depth: only routes a request when the host name matches a known
 * FontId in the registry.  Path traversal is impossible because the URL
 * doesn't carry an arbitrary path — only the two well-known suffixes are
 * resolved; everything else is denied.
 */
const VALID_RESOURCES = new Set(['ttf', 'ofl'])

function resolveFontResource(fontId: FontId, resource: string): string | null {
  const meta = getFontMeta(fontId)
  const dir = getFontResolveDir(meta)
  if (resource === 'ttf') return join(dir, meta.fileName)
  if (resource === 'ofl') {
    // OFL.txt sibling.  Bundled fonts may not ship one (Noto's OFL lives in
    // installer/licenses/), in which case the protocol returns 404 and the
    // renderer falls back to the registry's `copyright` string.
    return join(dir, 'OFL.txt')
  }
  return null
}

export function registerFontProtocol(): void {
  protocol.registerFileProtocol('mojioko-font', (request, callback) => {
    const prefix = 'mojioko-font://'
    const tail = request.url.startsWith(prefix) ? request.url.slice(prefix.length) : request.url
    // tail is "<font-id>/<resource>" — split on the first slash only.
    const slash = tail.indexOf('/')
    if (slash < 0) {
      log.debug(`[font-protocol] denied (bad shape): ${request.url}`)
      callback({ error: NET_ERR_ACCESS_DENIED })
      return
    }
    const host = decodeURIComponent(tail.slice(0, slash))
    const resource = decodeURIComponent(tail.slice(slash + 1)).replace(/[?#].*$/, '')

    if (!isFontId(host)) {
      log.debug(`[font-protocol] denied (unknown font id): ${host}`)
      callback({ error: NET_ERR_ACCESS_DENIED })
      return
    }
    if (!VALID_RESOURCES.has(resource)) {
      log.debug(`[font-protocol] denied (unknown resource): ${resource}`)
      callback({ error: NET_ERR_ACCESS_DENIED })
      return
    }

    const filePath = resolveFontResource(host, resource)
    if (filePath === null) {
      callback({ error: NET_ERR_ACCESS_DENIED })
      return
    }

    if (!existsSync(filePath)) {
      log.debug(`[font-protocol] not found: ${filePath}`)
      callback({ error: NET_ERR_FILE_NOT_FOUND })
      return
    }

    // realpath the file before serving — same hardening pattern as
    // mojioko-media:// — so even a symlink under the user font dir cannot
    // escape into the rest of the filesystem.
    let canonical: string
    try {
      canonical = realpathSync(resolve(filePath))
    } catch {
      callback({ error: NET_ERR_FILE_NOT_FOUND })
      return
    }
    callback({ path: canonical })
  })

  // Touch FONT_REGISTRY at registration so a stale import path surfaces here
  // rather than at first protocol request time.
  void FONT_REGISTRY.length
}
