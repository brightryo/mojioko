import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { APP_DATA_FOLDER } from '../../shared/app-info'

const isDev = !app.isPackaged

export function getResourcesPath(): string {
  return isDev ? join(app.getAppPath(), 'resources') : process.resourcesPath
}

export function getBinPath(...segments: string[]): string {
  const name = process.platform === 'win32' ? `${segments[segments.length - 1]}.exe` : segments[segments.length - 1]
  return join(getResourcesPath(), 'bin', 'ffmpeg', name)
}

export function getFontsDir(): string {
  return join(getResourcesPath(), 'fonts', 'Noto_Sans_JP', 'static')
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

export function getModelsDir(): string {
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
