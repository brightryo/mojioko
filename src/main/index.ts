// REQ-0455 — MUST be the FIRST import: installs the stdout guard before any
// other main-process module can write a stray byte to stdout in `mojioko mcp`.
import './mcp/early-guard'
import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import { join } from 'path'
import { release } from 'os'
import { APP_NAME, APP_DISPLAY, APP_VERSION } from '../shared/app-info'
import { Channels } from '../shared/ipc-channels'
import { existsSync } from 'fs'
import { maybeRunCli, isCliInvocation, projectFileToOpen, projectFileFromSecondInstance } from './cli'
import { writeMcpbBundle } from './mcp/mcpb'
import { toolList, JOB_TOOLS } from './mcp/tools'
import { getMcpLaunchSpec } from './mcp/launch'
import type { McpExportResult, McpLaunchSpec } from '../shared/mcp'
import { registerVideoHandlers } from './ipc/video'
import { registerTranscriptionHandlers } from './ipc/transcription'
import { registerBurninHandlers } from './ipc/burnin'
import { registerSettingsHandlers } from './ipc/settings'
import { registerDialogHandlers } from './ipc/dialog'
import { registerShellHandlers } from './ipc/shell'
import { registerFontHandlers } from './ipc/font'
import { registerGpuToolHandlers } from './ipc/gpu-tool'
import { registerTranslationToolHandlers } from './ipc/translation-tool'
import { registerTranslationHandlers } from './ipc/translation'
import { registerDownloadHandlers } from './ipc/download'
import { loadSettings, mutateSettings } from './services/settings-store'
import { terminateSidecar } from './services/transcription-sidecar'
import { terminateTranslationSidecar } from './services/translation-sidecar'
import { execFileAsync } from './lib/child-process'
import { detectAvailableEncoders, getBestEncoder } from './services/encoder-detector'
import { buildMenu, rebuildMenu, setMenuLocked } from './menu'
import { registerVideoProtocol } from './lib/video-protocol'
import { registerFontProtocol } from './lib/font-protocol'
import { registerPreviewMixProtocol } from './lib/preview-mix-protocol'
import { cleanupStalePreviewMixTmp } from './services/preview-mix'
import { isPackagedAsMsix, getCurrentProcessContext } from './lib/msix'
import { getResourcesPath, getEulaPath } from './lib/paths'
import type { BuildInfo, EncoderDetectionResult } from '../shared/ipc-contracts'
import { promises as fsp } from 'fs'
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


/**
 * ★ REQ-0546 (RES-0543 F2) — do not let the window close over unsaved work.
 *
 * ## The paths this covers
 *
 * The × button, the taskbar close, Alt+F4 and the menu's 終了 all end up in one
 * of two events: the window's `close`, or `app.quit()` → `before-quit`. Both
 * are guarded, and both consult the SAME renderer answer.
 *
 * ## Why `before-quit` is guarded too, not just `close`
 *
 * The menu's 終了 calls `app.quit()`, and the existing `before-quit` listener
 * terminates the Whisper and translation sidecars. Guarding only the window's
 * `close` would let that listener run first, so a user who chose 終了 and then
 * pressed キャンセル would be left in a live app with dead sidecars. Blocking at
 * `before-quit` means the teardown is only ever reached on the pass where the
 * quit is really happening.
 *
 * ## What it cannot cover
 *
 * An OS shutdown / sign-out (`session-end` on Windows) does not honour
 * `preventDefault`, and neither does a crash or a kill. Those are the province
 * of autosave (RES-0543 F2's larger half), which this REQ does not implement.
 *
 * ## The renderer decides
 *
 * main has no idea whether the document is dirty, so it asks. The renderer
 * answers `discard` immediately when there is nothing to lose, so the ordinary
 * "close an untouched app" path is one IPC round-trip and no dialog.
 */
let quitApproved = false
let closeDecisionPending = false

/** True once the user (or the renderer, on its behalf) has agreed to lose work. */
export function isQuitApproved(): boolean {
  return quitApproved
}

function requestCloseDecision(win: BrowserWindow): void {
  // One outstanding question at a time: hammering the × must not stack up
  // dialogs, and the renderer only tracks one.
  if (closeDecisionPending) return
  closeDecisionPending = true
  win.webContents.send(Channels.appCloseRequested)
}

/**
 * Guard shared by `close` and `before-quit`.  Returns true when the caller
 * should block.
 */
function shouldBlockExit(win: BrowserWindow | null): boolean {
  if (quitApproved) return false
  // A window that is gone or whose renderer has crashed can never answer, and
  // an app that cannot be quit is worse than one that loses a draft.
  if (!win || win.isDestroyed() || win.webContents.isCrashed()) return false
  return true
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
    // maximize button.
    //
    // REQ-0178 Phase B-1 (feat/ui-resolve): lifted backgroundColor
    // from #09090b (near-black neutral-950, ~4 % L) to #212121
    // (~13 % L) so it tracks the new --surface-0 token defined in
    // globals.css :root.  The BrowserWindow paints this colour during
    // the pre-first-paint flash and any subpixel edges where the
    // renderer's body doesn't reach — those should read as the same
    // grey the renderer paints, not near-black.
    backgroundColor: '#212121',
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

  // REQ-0132 §3 / REQ-0139 fix — Ctrl+R is the "reset selected clip"
  // shortcut (renderer's `useGlobalShortcuts`).  REQ-0132 had
  // preventDefaulted Ctrl+R here on the (wrong) assumption that
  // Chromium would otherwise reload the page.  `event.preventDefault()`
  // in `before-input-event` blocks the accelerator AND the DOM
  // keydown from ever reaching the renderer, so the reset never
  // fired — REQ-0139's owner-reported bug (Ctrl+R "does nothing"
  // while the inspector's Reset button worked).
  //
  // Our custom application menu (see `menu.ts`) has no Reload item,
  // so there is no accelerator to eat: an unmodified Ctrl+R already
  // flows through Chromium unchanged and lands in the renderer as a
  // plain DOM keydown.  Let it through; the renderer's capture-phase
  // handler calls `preventDefault` + `stopPropagation` after firing
  // the reset.
  //
  // Ctrl+Shift+R / F5 / Ctrl+F5 have no in-app behaviour, so we keep
  // preventDefault-ing them as belt-and-braces against a future
  // Electron/Chromium version that might introduce a default
  // accelerator.  This safeguards the user's edit session from a
  // stray "hard reload" keystroke.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    const isNonResetReload =
      (input.control && input.shift && key === 'r') ||
      key === 'f5' ||
      (input.control && key === 'f5')
    if (isNonResetReload) event.preventDefault()
  })

  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  const menu = buildMenu(win)
  Menu.setApplicationMenu(menu)
  mainWin = win

  /*
   * REQ-0546 — ask before closing.  `preventDefault` cancels this attempt; the
   * renderer's answer either re-runs the close with `quitApproved` set, or
   * leaves the app exactly as it was.
   */
  win.on('close', (event) => {
    if (!shouldBlockExit(win)) return
    event.preventDefault()
    requestCloseDecision(win)
  })

  return win
}

async function checkPythonAvailable(): Promise<boolean> {
  const candidates = ['py -3.11', 'python3.11', 'python3', 'python']
  for (const cmd of candidates) {
    const [bin, ...args] = cmd.split(' ')
    try {
      await execFileAsync(bin, [...args, '--version'], { timeout: 3000 })
      return true
    } catch {
      /* try next */
    }
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

  // REQ-0449 §4 — absolute path of the running executable = the CLI entry
  // (`MOJIOKO.exe <command>`). Used by the Settings ▸ CLI "copy instructions"
  // button. In dev this is electron.exe (expected).
  ipcMain.handle(Channels.appGetCliPath, (): string => process.execPath)

  // REQ-0452 — the launch spec (command/args) correct for dev vs packaged.
  // Single source for the .mcpb export AND the renderer's config/command strings.
  // REQ-0458 §3 — also attach the last-exported bundle record so the AI連携 tab
  // can compare its launch-spec revision against the current one.
  ipcMain.handle(Channels.appGetMcpLaunchSpec, async (): Promise<McpLaunchSpec> => {
    const settings = await loadSettings()
    return { ...getMcpLaunchSpec(), lastExport: settings.lastMcpExport ?? null }
  })

  // REQ-0451 §1 / REQ-0452 — write a .mcpb bundle (drag into Claude Desktop ▸
  // Extensions). command/args are dev/packaged-correct; the manifest command is
  // existence-checked as a safety net.
  ipcMain.handle(Channels.appExportMcpBundle, async (_event, targetPath: unknown): Promise<McpExportResult> => {
    if (typeof targetPath !== 'string' || !targetPath) throw new Error('invalid target path')
    const spec = getMcpLaunchSpec()
    const commandExists = existsSync(spec.command)
    // REQ-0463 — the proxy script (args[0], asarUnpack'ed) is what actually runs;
    // verify it exists so a regressed unpack config is caught at export time.
    const proxyExists = typeof spec.args[0] === 'string' && existsSync(spec.args[0])
    writeMcpbBundle(targetPath, spec.command, spec.args, spec.env, [...toolList(), ...JOB_TOOLS])
    // REQ-0458 §3 — remember what we exported so the tab can flag staleness.
    const record = {
      appVersion: spec.appVersion,
      launchSpecRevision: spec.launchSpecRevision,
      exportedAtMs: Date.now(),
      path: targetPath,
    }
    await mutateSettings((s) => { s.lastMcpExport = record; return { save: s, value: null } })
    return { path: targetPath, isPackaged: spec.isPackaged, commandExists, proxyExists, appVersion: spec.appVersion, launchSpecRevision: spec.launchSpecRevision }
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

  ipcMain.handle(Channels.appReadEula, async (_event, lang: unknown) => {
    // Reject anything that isn't one of the supported locales up front so
    // a stray renderer call cannot coerce the path into reading arbitrary
    // files.  Fallback to 'en' for shape safety; the renderer normally
    // passes the resolved i18n language directly.
    const resolved: 'ja' | 'en' = lang === 'ja' ? 'ja' : 'en'
    const filePath = getEulaPath(resolved)
    try {
      const text = await fsp.readFile(filePath, 'utf-8')
      return { ok: true as const, data: text }
    } catch (err) {
      log.warn(
        `[app] readEula failed for lang=${resolved} at ${filePath}: ${(err as Error).message}`
      )
      return {
        ok: false as const,
        error: { code: 'EULA_NOT_FOUND', message: (err as Error).message }
      }
    }
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
  registerGpuToolHandlers()
  registerTranslationToolHandlers()
  registerTranslationHandlers()
  registerDownloadHandlers()
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
    const gpu = (await app.getGPUInfo('basic')) as Record<string, unknown>
    // 'basic' returns { auxAttributes, gpuDevice[], machineModelVersion, ... }.
    // gpuDevice is the interesting bit; everything else is noise in a log line.
    const devices = (gpu.gpuDevice as Array<Record<string, unknown>> | undefined) ?? []
    const primary = devices.find((d) => d.active) ?? devices[0]
    if (primary) {
      log.info(
        `[startup] gpu:      vendorId=${primary.vendorId} deviceId=${primary.deviceId} active=${primary.active ?? false}`
      )
    } else {
      log.info('[startup] gpu:      (no devices reported)')
    }
  } catch (err) {
    log.warn(`[startup] gpu info unavailable: ${String(err)}`)
  }

  try {
    const available = await detectAvailableEncoders()
    const best = await getBestEncoder()
    log.info(
      `[startup] ffmpeg encoders available: ${available.join(', ') || '(none)'} — best: ${best}`
    )
  } catch (err) {
    log.warn(`[startup] encoder detection failed: ${String(err)}`)
  }

  log.info('==================================================')
}

// REQ-0447 / REQ-0454 §1 — CLI/MCP dispatch is decided SYNCHRONOUSLY and BEFORE
// any single-instance-lock or window logic. `mojioko mcp` (and every CLI
// command) therefore runs regardless of a running GUI holding the lock — the
// MCP server must serve even while the app is open (Claude Desktop launches it
// independently). The lock + window-all-closed only exist in the GUI branch.
if (isCliInvocation()) {
  void maybeRunCli()
} else {
  // REQ-0449 — single-instance lock (GUI only): focus the existing window on a
  // second launch, and let the CLI's `tools use` write guard detect a running GUI.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    // REQ-0459 §1/§4 — a `.mojioko` double-click launched us: open it once the
    // window's renderer is ready (a startup-only send; see createWindow below).
    const startupProjectPath = projectFileToOpen()

    app.on('second-instance', (_event, argv) => {
      // REQ-0459 §3 — a second launch double-clicked a `.mojioko`: hand the
      // path to the EXISTING window (no new process). The renderer confirms
      // discarding an unsaved project before replacing it.  REQ-0484 — the
      // delivered argv carries leading Chromium switches, so extraction scans
      // past them; log the outcome (a null on a real double-click is the C3 bug).
      const secondPath = projectFileFromSecondInstance(argv)
      log.info(`[main] second-instance: open project = ${secondPath ?? '(none)'}`)
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        if (win.isMinimized()) win.restore()
        win.focus()
        if (secondPath) win.webContents.send(Channels.projectOpenPath, secondPath)
      }
    })
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit()
    })
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
      const win = createWindow()

      // REQ-0459 §4 — deliver the double-clicked project path to the renderer
      // after it finishes loading, so ProjectOpenController can run the same
      // open flow the menu uses (identity check, font warnings, etc.).
      if (startupProjectPath) {
        win.webContents.once('did-finish-load', () => {
          win.webContents.send(Channels.projectOpenPath, startupProjectPath)
        })
      }

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
  }
}

app.on('before-quit', (event) => {
  // REQ-0546 — block BEFORE the teardown below, not after: the menu's 終了 goes
  // through here, and killing the sidecars for a quit the user then cancels
  // would leave a live app that can no longer transcribe.
  const win = BrowserWindow.getAllWindows()[0] ?? null
  if (shouldBlockExit(win)) {
    event.preventDefault()
    requestCloseDecision(win as BrowserWindow)
    return
  }
  log.info('[main] before-quit: terminating sidecar')
  terminateSidecar()
  terminateTranslationSidecar()
})

/**
 * REQ-0546 — the renderer's verdict.
 *
 * `discard` marks the exit approved and re-issues the close, which now falls
 * straight through both guards. `cancel` simply clears the pending flag; the
 * app was never closing, because the original attempt was already prevented.
 */
ipcMain.handle(Channels.appCloseDecision, (_event, decision: 'discard' | 'cancel') => {
  closeDecisionPending = false
  if (decision !== 'discard') {
    log.info('[main] close cancelled by the user')
    return
  }
  quitApproved = true
  log.info('[main] close approved — quitting')
  app.quit()
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
