/**
 * REQ-0536 §1-3 — the PREVIEW's rotated edge, measured with the same metric.
 *
 * `node scripts/measure-rotation-edges/preview.mjs [--extra-font id=path]`
 *
 * The burn side is measured by `index.mjs`. This renders the real
 * `SubtitleOverlay` in chromium at 1:1 and runs the identical metric, so the
 * two numbers can be put beside each other. The question it answers is §1-3's
 * last bullet: what IS the difference between the preview's edges and the
 * burn's — and it is a question about the rasterisers, so both sides must be
 * measured the same way rather than eyeballed.
 */
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import http from 'http'
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { followEdge, lumaAt } from './metric.mjs'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const { chromium } = require('playwright')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const BUNDLE = path.join(HERE, '.preview.js')
const OUT = path.join(REPO, 'dev-docs', 'req-0536-crops')
const DIR = path.join(tmpdir(), `mojioko-rotprev-${process.pid}`)
const FF = path.join(REPO, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')
const BUNDLED_FONTS = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')

const EXTRA = new Map()
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--extra-font' && process.argv[i + 1]) {
    const [id, ...rest] = process.argv[i + 1].split('=')
    EXTRA.set(id, rest.join('='))
  }
}

const W = 1920, H = 1080
const ANGLES = [0, 5, 15, 45]

const CASES = [
  { fontId: 'noto-sans-jp-semibold', cssFamily: 'MOJIOKO Noto Sans JP', label: 'Noto SemiBold',
    file: path.join(BUNDLED_FONTS, 'NotoSansJP-SemiBold.ttf'), weight: 600 },
  { fontId: 'noto-sans-jp-black', cssFamily: 'MOJIOKO Noto Sans JP', label: 'Noto Black',
    file: path.join(BUNDLED_FONTS, 'NotoSansJP-Black.ttf'), weight: 900 },
  { fontId: 'dela-gothic-one', cssFamily: 'MOJIOKO Dela Gothic One', label: 'Dela Gothic One',
    file: EXTRA.get('dela-gothic-one') ?? '', weight: 400 },
].filter((c) => {
  const ok = c.file && existsSync(c.file)
  if (!ok) console.log(`  ${c.label}: NOT AVAILABLE — skipped, and NOT substituted`)
  return ok
})
if (CASES.length === 0) { console.error('no fonts available'); process.exit(2) }

esbuild.buildSync({
  entryPoints: [path.join(HERE, 'preview-entry.tsx')],
  bundle: true, outfile: BUNDLE, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  alias: {
    '@': path.join(REPO, 'src/renderer'),
    'react-i18next': path.join(REPO, 'scripts/verify-bg-box-parity/react-i18next-stub.ts'),
  },
  logLevel: 'silent',
})
mkdirSync(DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })

let currentHtml = ''
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(currentHtml); return
  }
  if (url === '/.bundle.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(readFileSync(BUNDLE)); return
  }
  const f = CASES.find((c) => url === `/font-${c.fontId}.ttf`)
  if (f) { res.writeHead(200, { 'content-type': 'font/ttf' }); res.end(readFileSync(f.file)); return }
  res.writeHead(404); res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const html = (c, spec) => `<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face{font-family:'${c.cssFamily}';src:url('/font-${c.fontId}.ttf') format('truetype');font-weight:${c.weight};font-style:normal;}
html,body{margin:0;background:#000}
#root{position:relative;width:${W}px;height:${H}px;background:#000;overflow:hidden}
/* The overlay is styled with Tailwind utility CLASSES; with no stylesheet they
   are inert names, the span collapses to zero size, and a 50%/50% transform
   origin silently resolves to 0,0 - throwing the rotated text off screen.
   Only the utilities the overlay actually uses are needed here. */
.absolute{position:absolute}.relative{position:relative}
.pointer-events-none{pointer-events:none}.pointer-events-auto{pointer-events:auto}
.inset-0{inset:0}.block{display:block}.inline{display:inline}
</style></head><body><div id="root"></div>
<script>window.__spec=${JSON.stringify(spec)}</script>
<script src="/.bundle.js"></script></body></html>`

const ff = (args, tag) => {
  const r = spawnSync(FF, ['-y', '-v', 'error', ...args])
  if (r.status !== 0) { console.error(`ffmpeg failed (${tag}):`, r.stderr?.toString()); process.exit(2) }
}

function inkBox(buf, thr = 8) {
  let x0 = W, x1 = -1, y0 = H, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lumaAt(buf, W, x, y) > thr) {
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 }
}

const browser = await chromium.launch({ args: ['--disable-lcd-text', '--force-color-profile=srgb'] })
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })

console.log('\npreview (real SubtitleOverlay, chromium, 1:1)\n')
console.log('subject                    ang  residualRms  transitionPx  levels  rows  fitAng')

const rows = []
for (const c of CASES) {
  for (const angle of ANGLES) {
    for (const mode of ['glyph', 'border']) {
      const spec = { fontId: c.fontId, cssFamily: c.cssFamily, rotation: angle, mode }
      currentHtml = html(c, spec)
      await page.goto(ORIGIN + '/')
      await page.waitForFunction('window.__ready === true', { timeout: 20000 })
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(250)
      const png = path.join(DIR, 'p.png')
      await page.screenshot({ path: png })
      const raw = path.join(DIR, 'p.rgb')
      ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], 'png')
      const buf = readFileSync(raw)
      const box = inkBox(buf)
      const label = `${mode} ${c.label}`
      if (!box) { console.log(`${label.padEnd(26)} ${String(angle).padStart(3)}   (no ink)`); continue }
      const m = followEdge(buf, W, H, box)
      if (!m) { console.log(`${label.padEnd(26)} ${String(angle).padStart(3)}   (no edge)`); continue }
      rows.push({ subject: label, stage: 'preview', angle, ...m })
      console.log(
        `${label.padEnd(26)} ${String(angle).padStart(3)}  ` +
        `${m.residualRms.toFixed(4).padStart(11)}  ${m.transitionPx.toFixed(2).padStart(12)}  ` +
        `${String(m.levels).padStart(6)}  ${String(m.rows).padStart(4)}  ${m.angleDeg.toFixed(1).padStart(6)}`)
      if (angle === 15 || angle === 0) {
        const size = 40, scale = 10
        const cx = Math.max(0, Math.min(W - size, Math.round(m.atX - size / 2)))
        const cy = Math.max(0, Math.min(H - size, Math.round(m.atY - size / 2)))
        ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', raw,
          '-vf', `crop=${size}:${size}:${cx}:${cy},scale=${size * scale}:${size * scale}:flags=neighbor`,
          path.join(OUT, `preview-${mode}-${c.fontId}-${angle}.png`)], 'crop')
      }
    }
  }
}

writeFileSync(path.join(OUT, 'measurements-preview.json'), JSON.stringify(rows, null, 2), 'utf-8')
await browser.close(); server.close()
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
try { rmSync(BUNDLE, { force: true }) } catch { /* best effort */ }
console.log(`\ncrops → ${OUT}`)
