/**
 * REQ-0355 §2 — Electron main for the font-weight gate.
 *
 * Driven directly (`node_modules/electron/dist/electron.exe electron-main.cjs`)
 * to match `verify-ring-paint`, whose header records that `@playwright/test`'s
 * `_electron.launch` fails in this repo with `spawn cmd.exe ENOENT`.  Reads a
 * job JSON, measures in the page, writes the measurements back out as JSON.
 * All policy (what counts as a pass, the table, the exit code) is in index.mjs.
 */
/* eslint-disable @typescript-eslint/no-var-requires --
   An Electron main script must be CommonJS; `electron.exe` will not load an
   ESM entry point here, so `require` is the only option in this file. */
const { app, BrowserWindow } = require('electron')
const path = require('path')
const fs = require('fs')

const jobPath = process.argv[process.argv.length - 2]
const outPath = process.argv[process.argv.length - 1]
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'))

// Text metrics must not vary with the host GPU or the display's scale factor.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')

async function main() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  await win.loadFile(path.join(job.workDir, 'page.html'))

  // `document.fonts.ready` settles once the initial face set has been
  // processed; the per-weight `load()` calls in the page do the real waiting.
  await win.webContents.executeJavaScript('document.fonts.ready.then(()=>1)')
  const families = await win.webContents.executeJavaScript(
    `window.__measure(${JSON.stringify(job)})`
  )

  fs.writeFileSync(outPath, JSON.stringify({ families }, null, 1), 'utf8')
  win.destroy()
  app.quit()
}

app.whenReady().then(() =>
  main().catch((e) => {
    fs.writeFileSync(outPath, JSON.stringify({ error: String(e && e.stack) }), 'utf8')
    app.exit(1)
  })
)
