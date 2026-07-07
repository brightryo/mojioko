import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'path'
import { release } from 'os'
import { APP_NAME, APP_DISPLAY, APP_VERSION } from '../shared/app-info'
import { Channels } from '../shared/ipc-channels'
import { registerVideoHandlers } from './ipc/video'
import { registerTranscriptionHandlers } from './ipc/transcription'
import { registerBurninHandlers } from './ipc/burnin'
import { registerSettingsHandlers } from './ipc/settings'
import { registerDialogHandlers } from './ipc/dialog'
import { registerShellHandlers } from './ipc/shell'
import { registerFontHandlers } from './ipc/font'
import { terminateSidecar } from './services/transcription-sidecar'
import { execFileAsync } from './lib/child-process'
import { detectAvailableEncoders, getBestEncoder } from './services/encoder-detector'
import { buildMenu, rebuildMenu, setMenuLocked } from './menu'
import { registerVideoProtocol } from './lib/video-protocol'
import { registerFontProtocol } from './lib/font-protocol'
import { registerPreviewMixProtocol } from './lib/preview-mix-protocol'
import { cleanupStalePreviewMixTmp } from './services/preview-mix'
import { isPackagedAsMsix, getCurrentProcessContext } from './lib/msix'
import { getResourcesPath } from './lib/paths'
import type { BuildInfo, EncoderDetectionResult } from '../shared/ipc-contracts'
import log from './lib/logger'

const isDev = !app.isPackaged

let mainWin: BrowserWindow | null = null

/**
 * Resolve the path to the multi-size .ico used for the BrowserWindow's
 * title-bar / taskbar icon.
 *
 * - Dev (`npm run dev`): the source `resources/icons/icon.ico` is reachable
 *   via `app.getAppPath()` (= project root).
 * - Packaged: `resources/icons` is shipped via the `extraResources` entry in
 *   `electron-builder.yml`, so the file lives at
 *   `<resourcesPath>/icons/icon.ico`.
 *
 * Falls back to `undefined` if the file is missing — Electron then uses its
 * default logo, which is preferable to crashing the window constructor.
 */
function resolveWindowIconPath(): string {
  return join(getResourcesPath(), 'icons', 'icon.ico')
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    // useContentSize treats width/height as the renderer's *content area*
    // rather than the OS-decorated outer frame.  Without it, the ~32px
    // title bar + ~24px native menu bar (Windows) eat into the figure
    // we picked here — leaving the actual UI work area 56px shorter
    // than intended and breaking layout choices keyed to viewport height.
    useContentSize: true,
    // REQ-20260614-001 補遺⑥ — `minWidth` / `minHeight` are bumped to
    // match the startup `width` / `height` so the launch size becomes the
    // hard floor.  Combined with px-based pane minSize in step2 (see
    // step2.tsx), the user cannot shrink the window below the point where
    // the 3-pane layout collapses any of its panes below their startup
    // px size.
    width: 1280,
    height: 820,
    minWidth: 1280,
    minHeight: 820,
    title: APP_DISPLAY,
    // REQ-20260615-030 B: REQ-019 set `transparent: true` to let the
    // renderer's rgba(0,0,0, --window-bg-alpha) body show the desktop.
    // On Windows that flag also DISABLES the title-bar maximize button
    // (documented Electron limitation), which the user wanted back.
    // Trade-off: drop the see-through-desktop trial, get a working
    // maximize button.  The body's CSS rule (rgba(0,0,0, alpha))
    // composes harmlessly over this solid backgroundColor in dark
    // mode, and the `:root.light body` rule still paints opaque light
    // in light mode.
    backgroundColor: '#09090b',
    // Multi-size .ico ensures Windows picks the right size for the title
    // bar (32×32), the taskbar (16/24×16/24), and Alt-Tab (48×48).  Without
    // this property Electron renders the default Electron logo.
    icon: resolveWindowIconPath(),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    if (isDev) {
      win.webContents.openDevTools({ mode: 'detach' })
    }
  })

  // REQ-0132 §3 — Ctrl+R is now the "reset selected clip" shortcut
  // (renderer's `useGlobalShortcuts`).  Chromium and Electron would
  // otherwise route Ctrl+R / Ctrl+Shift+R / F5 / Ctrl+F5 to
  // `webContents.reload()`, wiping the user's in-progress edit
  // session.  `before-input-event` runs on the main process BEFORE
  // Chromium's accelerator layer, so preventing the input here stops
  // the reload regardless of whether the renderer's capture-phase
  // handler also fired.  In dev mode we still want the developer to
  // be able to reload via the DevTools; the DevTools' own keyboard
  // shortcuts are dispatched separately and are not intercepted here.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const isReload =
      (input.control && key === 'r') ||
      (input.control && input.shift && key === 'r') ||
      key === 'f5' ||
      (input.control && key === 'f5')
    if (isReload) event.preventDefault()
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const menu = buildMenu(win)
  Menu.setApplicationMenu(menu)
  mainWin = win

  return win
}

async function checkPythonAvailable(): Promise<boolean> {
  const candidates = ['py -3.11', 'python3.11', 'python3', 'python']
  for (const cmd of candidates) {
    const [bin, ...args] = cmd.split(' ')
    try {
      await execFileAsync(bin, [...args, '--version'], { timeout: 3000 })
      return true
    } catch { /* try next */ }
  }
  return false
}

function registerIpcHandlers(): void {
  ipcMain.handle(Channels.appGetVersion, () => app.getVersion())
  ipcMain.handle(Channels.appGetResourcesPath, () => getResourcesPath())
  // REQ-088 #4 — surface the MSIX/NSIS distinction to the renderer
  // so the font picker UI can gate paid-tier features (download +
  // non-default selection).  Pure read of the existing msix.ts helper;
  // no settings, no side effects.
  ipcMain.handle(Channels.appIsMsix, (): boolean => {
    return isPackagedAsMsix(getCurrentProcessContext())
  })

  ipcMain.handle(Channels.appGetBuildInfo, async (): Promise<BuildInfo> => {
    const pythonAvailable = await checkPythonAvailable()
    return {
      electronVersion: process.versions.electron ?? '',
      nodeVersion: process.versions.node ?? '',
      chromeVersion: process.versions.chrome ?? '',
      pythonAvailable
    }
  })

  ipcMain.handle(Channels.appDetectEncoders, async (): Promise<EncoderDetectionResult> => {
    const available = await detectAvailableEncoders()
    const best = await getBestEncoder()
    return { available, best }
  })

  ipcMain.on(Channels.menuSetLanguage, (_event, lang: string) => {
    if (mainWin) rebuildMenu(mainWin, lang)
  })

  ipcMain.on(Channels.menuSetTranscribing, (_event, locked: boolean) => {
    if (mainWin) setMenuLocked(mainWin, locked)
  })

  registerVideoHandlers()
  registerTranscriptionHandlers()
  registerBurninHandlers()
  registerSettingsHandlers()
  registerDialogHandlers()
  registerShellHandlers()
  registerFontHandlers()
}

/**
 * One-shot summary of the runtime environment.  Logged at info level so the
 * very first lines of any user-submitted log file already show app version,
 * OS, Electron/Node/Chrome versions, GPU info, and detected ffmpeg encoders —
 * the data we ask for in 90 % of bug reports.
 */
async function logStartupEnvironment(): Promise<void> {
  log.info('================ MOJIOKO startup ================')
  log.info(`[startup] app:      ${APP_DISPLAY} (v${APP_VERSION})`)
  log.info(`[startup] platform: ${process.platform} ${release()} (${process.arch})`)
  log.info(`[startup] electron: ${process.versions.electron}`)
  log.info(`[startup] chrome:   ${process.versions.chrome}`)
  log.info(`[startup] node:     ${process.versions.node}`)
  log.info(`[startup] packaged: ${app.isPackaged}`)

  try {
    const gpu = await app.getGPUInfo('basic') as Record<string, unknown>
    // 'basic' returns { auxAttributes, gpuDevice[], machineModelVersion, ... }.
    // gpuDevice is the interesting bit; everything else is noise in a log line.
    const devices = (gpu.gpuDevice as Array<Record<string, unknown>> | undefined) ?? []
    const primary = devices.find((d) => d.active) ?? devices[0]
    if (primary) {
      log.info(`[startup] gpu:      vendorId=${primary.vendorId} deviceId=${primary.deviceId} active=${primary.active ?? false}`)
    } else {
      log.info('[startup] gpu:      (no devices reported)')
    }
  } catch (err) {
    log.warn(`[startup] gpu info unavailable: ${String(err)}`)
  }

  try {
    const available = await detectAvailableEncoders()
    const best = await getBestEncoder()
    log.info(`[startup] ffmpeg encoders available: ${available.join(', ') || '(none)'} — best: ${best}`)
  } catch (err) {
    log.warn(`[startup] encoder detection failed: ${String(err)}`)
  }

  log.info('==================================================')
}

app.whenReady().then(() => {
  log.info(`[main] starting ${APP_DISPLAY}`)
  void logStartupEnvironment()
  registerVideoProtocol()
  registerFontProtocol()
  registerPreviewMixProtocol()
  // REQ-086: remove any preview-mix .tmp left behind by a force-quit
  // during a prior transcription run.  See `preview-mix.ts`.
  cleanupStalePreviewMixTmp()
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  log.info('[main] before-quit: terminating sidecar')
  terminateSidecar()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})

process.on('unhandledRejection', (reason) => {
  log.error(`[main] unhandledRejection: ${String(reason)}`)
})

process.on('uncaughtException', (err) => {
  // Log and keep going.  Letting the default handler kill the process would
  // crash the app without leaving the user a chance to react.
  log.error(`[main] uncaughtException: ${err.stack ?? String(err)}`)
})

export { APP_NAME }
