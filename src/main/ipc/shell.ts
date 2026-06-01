import { app, ipcMain, shell } from 'electron'
import { existsSync, mkdirSync, promises as fsp } from 'fs'
import { resolve, relative, isAbsolute, join } from 'path'
import { homedir } from 'os'
import { Channels } from '../../shared/ipc-channels'
import { ALLOWED_EXTERNAL_URLS } from '../../shared/app-info'
import { getModelsDir, getResourcesPath } from '../lib/paths'
import log from '../lib/logger'

/** Resolved home directory — computed once at module load time. */
const HOME_DIR = homedir()

/**
 * Validates that `filePath` is safely writable by the renderer.
 *
 * Rules enforced:
 *  1. The canonicalised path must reside inside the user's home directory.
 *     This rejects absolute escapes to system paths (e.g. C:\Windows\System32).
 *  2. Path-traversal sequences (../) are rejected because `resolve()` normalises
 *     them and the resulting canonical path would fall outside HOME_DIR.
 *
 * Returns an error message string on failure, or null if the path is acceptable.
 */
function validateWritePath(filePath: string): string | null {
  const canonical = resolve(filePath)
  // relative() returns a path starting with ".." when `canonical` escapes HOME_DIR.
  const rel = relative(HOME_DIR, canonical)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return `Write rejected: path is outside the user home directory (${canonical})`
  }
  return null
}

export function registerShellHandlers(): void {
  ipcMain.handle(Channels.shellOpenPath, async (_event, filePath: string): Promise<void> => {
    await shell.openPath(filePath)
  })

  ipcMain.handle(Channels.shellShowInFolder, async (_event, filePath: string): Promise<void> => {
    shell.showItemInFolder(filePath)
  })

  ipcMain.handle(Channels.shellOpenExternal, async (_event, url: string): Promise<void> => {
    const allowed = ALLOWED_EXTERNAL_URLS.some((allowed) => url.startsWith(allowed))
    if (!allowed) {
      log.warn(`[shell] blocked external URL: ${url}`)
      return
    }
    await shell.openExternal(url)
  })

  ipcMain.handle(Channels.shellOpenModelsFolder, async (): Promise<void> => {
    const dir = getModelsDir()
    mkdirSync(dir, { recursive: true })
    await shell.openPath(dir)
  })

  ipcMain.handle(Channels.shellOpenThirdPartyLicensesFolder, async (): Promise<void> => {
    // Resolve to the same directory in dev and packaged builds.  In dev the
    // licenses live at `<repo>/installer/licenses/`; packaged they ship via
    // electron-builder's extraResources entry as `<resourcesPath>/licenses/`.
    const dir = app.isPackaged
      ? join(getResourcesPath(), 'licenses')
      : join(app.getAppPath(), 'installer', 'licenses')
    if (!existsSync(dir)) {
      log.warn(`[shell] third-party licenses folder not found: ${dir}`)
      return
    }
    await shell.openPath(dir)
  })

  ipcMain.handle(Channels.shellWriteTextFile, async (_event, filePath: string, content: string): Promise<void> => {
    const err = validateWritePath(filePath)
    if (err) {
      log.warn(`[shell] shellWriteTextFile blocked: ${err}`)
      throw new Error(err)
    }
    await fsp.writeFile(filePath, content, 'utf-8')
  })

  /**
   * Read-only existence check used by Step 3 to surface an explicit "overwrite?"
   * confirmation before the burn-in starts.  The OS save dialog typically
   * already asks, but Electron's dialog flags vary by platform; this provides
   * a deterministic in-app prompt on top.
   *
   * No path validation needed — `existsSync` cannot mutate anything and only
   * returns a boolean.  Errors (permission, missing parent dir, etc) are
   * swallowed to `false` so a probe failure never blocks the user.
   */
  ipcMain.handle(Channels.shellFileExists, async (_event, filePath: string): Promise<boolean> => {
    try {
      return existsSync(filePath)
    } catch {
      return false
    }
  })
}
