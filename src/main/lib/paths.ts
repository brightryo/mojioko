import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { APP_DATA_FOLDER } from '../../shared/app-info'
import type { FontMeta } from '../../shared/fonts'
import {
  isPackagedAsMsix,
  getMsixPackageFamilyName,
  buildMsixVirtualizedAppDataPath,
  getCurrentProcessContext,
} from './msix'

const isDev = !app.isPackaged

export function getResourcesPath(): string {
  return isDev ? join(app.getAppPath(), 'resources') : process.resourcesPath
}

export function getBinPath(...segments: string[]): string {
  const name = process.platform === 'win32' ? `${segments[segments.length - 1]}.exe` : segments[segments.length - 1]
  return join(getResourcesPath(), 'bin', 'ffmpeg', name)
}

/**
 * Legacy single-font directory — kept for callers that still pass the
 * default Noto subdir to libass.  New code should resolve a font's
 * directory via `getFontResolveDir(meta)` instead.
 */
export function getFontsDir(): string {
  return join(getResourcesPath(), 'fonts', 'Noto_Sans_JP', 'static')
}

/** Root of the bundled fonts tree, shipped via electron-builder extraResources. */
export function getFontsBundledRoot(): string {
  return join(getResourcesPath(), 'fonts')
}

/**
 * Root of the user-downloaded font tree.  Each downloaded font lives at
 * `<root>/<font-id>/<filename>.ttf` (plus an OFL.txt sibling).  Mirrors the
 * Whisper model layout under `%APPDATA%/MOJIOKO/models/`.
 */
export function getFontsUserRoot(): string {
  return join(getAppDataPath(), 'fonts')
}

/**
 * Per-font directory inside the user root, regardless of whether the font is
 * actually downloaded yet.  Safe to pass to mkdir + write.
 */
export function getFontUserDir(fontId: string): string {
  return join(getFontsUserRoot(), fontId)
}

/**
 * Resolve the absolute directory containing the TTF for `meta`.  Used as the
 * `fontsdir=` argument to ffmpeg's `subtitles=` filter and as the source
 * directory for opentype.js parsing on the main side.
 *
 * - bundled font  → `resources/fonts/<bundledRelativeDir>/` (must exist in the
 *                   installer).
 * - downloaded   → `%APPDATA%/MOJIOKO/fonts/<id>/` (may not exist until the
 *                   user completes the download).
 */
export function getFontResolveDir(meta: FontMeta): string {
  if (meta.bundled) {
    const sub = meta.bundledRelativeDir ?? ''
    return join(getFontsBundledRoot(), sub)
  }
  return getFontUserDir(meta.id)
}

/**
 * Resolve the path to the SIL OFL v1.1 text shipped alongside a bundled font.
 *
 * Convention: the OFL.txt lives at the **family root** (one level up from the
 * `static/` weight folder), so all weight variants share a single OFL file.
 *   bundled Noto Sans JP → `resources/fonts/Noto_Sans_JP/OFL.txt`
 *
 * Returns the family-root OFL path when `meta.bundledRelativeDir` contains a
 * subpath (e.g. `Noto_Sans_JP/static`); otherwise returns the join of
 * `bundledRelativeDir` itself.
 *
 * Returns null when the font is not bundled — downloaded fonts have their
 * own per-font OFL.txt at `%APPDATA%/MOJIOKO/fonts/<id>/OFL.txt`, which is
 * already handled by `getFontUserDir(id) + '/OFL.txt'`.
 */
export function getBundledOflPath(meta: FontMeta): string | null {
  if (!meta.bundled) return null
  const rel = meta.bundledRelativeDir ?? ''
  // Strip a trailing `/static` segment (or any deeper sub-path) so the OFL
  // lives at the family root.  Falls back to the same dir as the TTF when
  // there is no slash, which is the simpler one-level-deep layout.
  const familyRoot = rel.includes('/') ? rel.split('/')[0] : rel
  return join(getFontsBundledRoot(), familyRoot, 'OFL.txt')
}

export function getAppDataPath(): string {
  return join(app.getPath('appData'), APP_DATA_FOLDER)
}

export function getSettingsPath(): string {
  return join(getAppDataPath(), 'settings.json')
}

export function getLogsDir(): string {
  return join(getAppDataPath(), 'logs')
}

/**
 * Resolves the **physical** directory where Whisper models live on disk.
 *
 * Why this is not just `join(getAppDataPath(), 'models')`:
 *
 * Under MSIX the OS transparently redirects writes to `%APPDATA%\MOJIOKO\…`
 * onto `%LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\MOJIOKO\…`.
 * Filesystem calls from inside the package see the merged path and work
 * fine, but call sites that hand the path string to a non-packaged
 * consumer (most importantly `shell.openPath` → Explorer.exe) see the
 * *real* logical path, which is empty.  See RES-20260615-070 §3-1.
 *
 * To keep every existing caller (`shell.ts`, `transcription.ts`, the
 * "保存先" row in the install-confirm dialog) working without
 * environment-aware branching, this function returns the explicit
 * virtualized path under MSIX and the logical path everywhere else.
 *
 * Fallback to the logical path when MSIX is detected but the
 * PackageFamilyName cannot be parsed from `process.execPath` —
 * preserves the v1.3.0 behavior rather than crashing.
 */
export function getModelsDir(): string {
  const ctx = getCurrentProcessContext()
  if (isPackagedAsMsix(ctx)) {
    const pfn = getMsixPackageFamilyName(ctx.execPath)
    if (pfn) {
      return buildMsixVirtualizedAppDataPath(
        app.getPath('home'),
        pfn,
        APP_DATA_FOLDER,
        'models'
      )
    }
  }
  return join(getAppDataPath(), 'models')
}

export function getPythonSidecarPath(): string {
  return isDev
    ? join(app.getAppPath(), 'python-sidecar', 'main.py')
    : join(process.resourcesPath, 'python-sidecar', 'main.py')
}

/**
 * Returns the path to the PyInstaller-built standalone transcriber binary
 * shipped with packaged installs.  When --onedir is used, PyInstaller writes
 * `mojioko-transcriber.exe` plus its dependency folder under
 * `resources/bin/transcriber/`; the exe is the spawnable entry point.
 *
 * Returns null in dev (sidecar is run via .venv python + main.py instead) or
 * if the file is missing — the caller falls back to the .venv path with a
 * clear error message.
 */
export function getTranscriberExePath(): string | null {
  if (isDev) return null
  const exe = process.platform === 'win32'
    ? join(process.resourcesPath, 'bin', 'transcriber', 'mojioko-transcriber.exe')
    : join(process.resourcesPath, 'bin', 'transcriber', 'mojioko-transcriber')
  return existsSync(exe) ? exe : null
}

/**
 * Returns the path to the Python executable to use for the transcription sidecar.
 *
 * Dev:  .venv in the project root (created by `py -3.11 -m venv .venv`)
 * Prod: bundled Python runtime under resources/python/ (TODO: populate in electron-builder.yml)
 *
 * Returns null if the resolved executable does not exist on disk.
 */
export function getPythonExecutable(): string | null {
  if (isDev) {
    const exe = process.platform === 'win32'
      ? join(app.getAppPath(), '.venv', 'Scripts', 'python.exe')
      : join(app.getAppPath(), '.venv', 'bin', 'python')
    return existsSync(exe) ? exe : null
  }

  // TODO: bundle Python under resources/python/ via electron-builder extraResources.
  // Until then the packaged build falls back to the system Python (will break if absent).
  const exe = process.platform === 'win32'
    ? join(process.resourcesPath, 'python', 'python.exe')
    : join(process.resourcesPath, 'python', 'bin', 'python')
  return existsSync(exe) ? exe : null
}
