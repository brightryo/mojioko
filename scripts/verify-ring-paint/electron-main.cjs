/**
 * REQ-0327 §2 — Electron main for the ring-paint gate.
 *
 * Driven directly (`node_modules/electron/dist/electron.exe electron-main.cjs`)
 * rather than through `@playwright/test`'s `_electron.launch`, which fails here
 * with `spawn cmd.exe ENOENT`.  Reads a job JSON, paints each case in the page,
 * captures REAL PIXELS with `webContents.capturePage()`, measures them, and
 * writes the measurements back out as JSON.  All policy (tolerances, table,
 * exit code) lives in index.mjs.
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

// Deterministic rasterisation: the GPU path is machine-dependent and this gate
// compares sub-pixel edges.  Software rendering also survives a headless-ish
// session where no GPU is available.
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', String(job.dpr))

/**
 * Sub-pixel edge of a coverage profile at the 0.5 crossing.
 *
 * Integer bbox extents quantise to whole pixels, which is coarser than the
 * drift we need to see.  Linear interpolation between the two samples that
 * bracket 0.5 recovers the edge to a fraction of a pixel; on a flat glyph edge
 * (why the fixtures use `HEIT`) every column agrees, so the estimate is stable.
 * Positions are pixel CENTRES: sample i sits at i + 0.5.
 */
function crossFwd(p) {
  for (let i = 0; i < p.length; i++) {
    if (p[i] >= 0.5) {
      const prev = i > 0 ? p[i - 1] : 0
      const t = p[i] === prev ? 0 : (0.5 - prev) / (p[i] - prev)
      return i - 1 + 0.5 + t
    }
  }
  return null
}
function crossRev(p) {
  for (let i = p.length - 1; i >= 0; i--) {
    if (p[i] >= 0.5) {
      const next = i < p.length - 1 ? p[i + 1] : 0
      const t = p[i] === next ? 0 : (p[i] - 0.5) / (p[i] - next)
      return i + 0.5 + t
    }
  }
  return null
}

function edgesOf(rowMax, colMax) {
  return {
    top: crossFwd(rowMax),
    bottom: crossRev(rowMax),
    left: crossFwd(colMax),
    right: crossRev(colMax)
  }
}

/**
 * Splits a BGRA capture into two coverage fields.
 *
 *   ink   = max(R,G,B)/255 — the composite silhouette over the black stage,
 *           so its outer edge IS the ring's outer edge.
 *   white = min(G,B)/255   — the text fill.  Red contributes 0, and a
 *           white-over-red edge pixel reports exactly the fill's coverage.
 */
function analyse(bitmap, W, H) {
  const inkRow = new Float64Array(H)
  const inkCol = new Float64Array(W)
  const wRow = new Float64Array(H)
  const wCol = new Float64Array(W)
  let maxInk = 0
  let redPx = 0
  let whitePx = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      const b = bitmap[o]
      const g = bitmap[o + 1]
      const r = bitmap[o + 2]
      const ink = Math.max(r, g, b) / 255
      const wht = Math.min(g, b) / 255
      if (ink > inkRow[y]) inkRow[y] = ink
      if (ink > inkCol[x]) inkCol[x] = ink
      if (wht > wRow[y]) wRow[y] = wht
      if (wht > wCol[x]) wCol[x] = wht
      if (ink > maxInk) maxInk = ink
      if (r > 128 && g < 64 && b < 64) redPx++
      if (r > 200 && g > 200 && b > 200) whitePx++
    }
  }
  return { ink: edgesOf(inkRow, inkCol), fill: edgesOf(wRow, wCol), maxInk, redPx, whitePx }
}

async function main() {
  const win = new BrowserWindow({
    width: job.stage.width,
    height: job.stage.height,
    useContentSize: true,
    show: job.show,
    backgroundColor: '#000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  await win.loadFile(path.join(job.workDir, 'page.html'))
  const setup = await win.webContents.executeJavaScript(
    `window.__setup(${JSON.stringify(job.setup)})`
  )

  const results = []
  for (const c of job.cases) {
    const reps = []
    for (let rep = 0; rep < job.repeats; rep++) {
      const info = await win.webContents.executeJavaScript(`window.__case(${JSON.stringify(c)})`)
      // `capturePage()` returns whatever the compositor has ALREADY drawn.
      // Without this wait every row reports the PREVIOUS case's pixels — the
      // first version of this gate did exactly that and the off-by-one was
      // only obvious because a blank S=0 row leaked into its neighbour.
      await win.webContents.executeJavaScript(
        'new Promise((r)=>{let done=false;const f=()=>{if(!done){done=true;r(1)}};' +
          'requestAnimationFrame(()=>requestAnimationFrame(f));setTimeout(f,400)})'
      )
      await new Promise((r) => setTimeout(r, 80))
      const img = await win.webContents.capturePage()
      const size = img.getSize()
      const bmp = img.getBitmap()
      // The bitmap is in DEVICE pixels; `getSize()` already reports those, so
      // the ratio has to come from the CSS stage size we asked for, not from
      // the buffer length.
      const px = bmp.length / 4
      const H = Math.round(Math.sqrt((px * size.height) / size.width))
      const W = Math.round(px / H)
      const scale = W / job.stage.width
      const m = analyse(bmp, W, H)
      reps.push({ ...m, devScale: scale, W, H, info })
    }
    results.push({ name: c.name, spec: c, reps })
  }

  fs.writeFileSync(outPath, JSON.stringify({ setup, dpr: job.dpr, results }, null, 1), 'utf8')
  win.destroy()
  app.quit()
}

app.whenReady().then(() =>
  main().catch((e) => {
    fs.writeFileSync(outPath, JSON.stringify({ error: String(e && e.stack) }), 'utf8')
    app.exit(1)
  })
)
