/**
 * REQ-0532 §1 — REAL-PIXEL gate: the preview's animation PHASE under trimming.
 *
 * ## The defect this exists for
 *
 * The owner put a scale animation on a cue and trimmed away the part of the
 * clip the animation played over. The burn clamps the cue's head to the cut and
 * moves it onto the edited axis, so the entrance REPLAYS from the cut boundary.
 * The preview measured phase from the cue's RAW start against a RAW
 * `<video>.currentTime`, so it had already spent that entrance during frames
 * the burn removed, and painted the settled state: "the preview does not
 * animate, the output does".
 *
 * ## What is measured, and why in two channels
 *
 * At each probe the cue's ink is reduced to:
 *   - `size`  = ink bounding box, normalised by the case's own settled box.
 *               This is the SCALE channel (scale / pop / blur spread).
 *   - `mass`  = summed brightness, normalised the same way. This is the
 *               OPACITY channel (fade), and it also moves for scale.
 *   - `ink` / `white` = pixel counts above a low and a high threshold.
 *
 * ★ `ink` AND `white` are both reported because REQ-0531 §12-3 cost us a false
 * failure: a half-opacity white caption over black is plainly "not background"
 * but is NOT over a `>200` white bar, so `white` alone cannot tell "drawn at
 * 50 % alpha" from "not drawn at all" — which is precisely the distinction an
 * animation gate lives on. `ink > 0` proves presence; the ratios prove phase.
 *
 * ## Both engines, one cue
 *
 * - BURN: real `translateEntriesToEditedAxis` → real `generateAss` → real
 *   ffmpeg/libass → rgb24 frame at the EDITED time.
 * - PREVIEW: the real `VideoPreviewPanel` in headless chromium, with the real
 *   cut list in the real store, seeked (paused) to `editedToOrig(tEdited)` —
 *   the source instant that displays that edited frame.
 *
 * Both are fed by `case-spec.ts`, so a case cannot describe two different cues.
 *
 * ## Negative control (§3-3), without `git checkout`
 *
 * The control renders the SAME cue at the SAME source instant with an EMPTY cut
 * list. That is not an approximation of the pre-fix code — it IS the pre-fix
 * computation, because ignoring `cuts` and having none are the same arithmetic
 * (raw cue times, raw clock). It perturbs one input, needs no history, cannot
 * silently stop applying, and cannot eat the working tree.
 *
 * Exit 0 = pass, 1 = a parity/phase failure, 2 = environment.
 */
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import http from 'http'
import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const { chromium } = require('playwright')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const DUMP = path.join(HERE, '.dump.cjs')
const BUNDLE = path.join(HERE, '.bundle.js')

const DIR = path.join(tmpdir(), `mojioko-cutanim-${process.pid}`)
const FONTS_DIR = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')
const FONT_CSS_FAMILY = 'MOJIOKO Noto Sans JP'
const FONT_WEIGHT = 600

// --- Tolerances ---------------------------------------------------------------
// Units: fractions of the case's own settled measurement, so both engines are
// compared dimensionlessly despite rasterising at different sizes.
//
// (A) TOL_PARITY — preview vs burn, per channel. The floor is the two engines'
//     rasterisation and line-box models (CSS line-height vs libass' own box),
//     the same ~0.08 gap `verify:scale-origin` documents. Measured worst 0.075.
const TOL_PARITY = 0.14
// (B) RAMP_MIN_DEVIATION — at a mid-ramp probe the cue must be visibly OFF the
//     settled plateau in its own channel (either direction: `pop` overshoots).
//     This is what makes the gate about the ANIMATION rather than about the cue
//     merely existing: without it, both engines painting the settled state
//     would "agree" and pass.
const RAMP_MIN_DEVIATION = 0.15
// (C) The negative control must miss by at least this much, or it is not
//     proving the gate can see the defect.
const NEG_MIN = 0.20

// --- Bundle both sides --------------------------------------------------------
esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: DUMP, format: 'cjs', platform: 'node',
  loader: { '.css': 'empty', '.png': 'empty' },
  alias: {
    '@': path.join(REPO, 'src/renderer'),
    // REQ-0537 — `ass-generator` now imports `main/lib/paths` statically, which
    // imports electron; the npm shim throws when bundled for plain node.
    electron: path.join(REPO, 'scripts/electron-stub.ts'),
  },
  logLevel: 'silent',
})
esbuild.buildSync({
  entryPoints: [path.join(HERE, 'harness-entry.tsx')],
  bundle: true, outfile: BUNDLE, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: {
    '.css': 'empty', '.png': 'empty', '.svg': 'empty',
    '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty',
  },
  alias: {
    '@': path.join(REPO, 'src/renderer'),
    'react-i18next': path.join(HERE, 'react-i18next-stub.ts'),
  },
  logLevel: 'silent',
})
const burnSide = require(DUMP)
const { CASES, VIDEO_W, VIDEO_H, VIDEO_DUR } = burnSide

// --- ffmpeg preflight ---------------------------------------------------------
if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('verify:cut-anim-parity: ffmpeg not found on PATH')
  process.exit(2)
}
mkdirSync(DIR, { recursive: true })
const ff = (args, tag) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { cwd: DIR })
  if (r.status !== 0) {
    console.error(`ffmpeg failed (${tag}):`, r.stderr?.toString())
    process.exit(2)
  }
}

// Pure-black source at the ASS PlayRes, lossless. Used as the burn background
// AND as the preview's <video>, so both engines composite over the same thing
// and "ink" means the same on both sides.
const BG = path.join(DIR, 'bg.mp4')
ff(['-f', 'lavfi', '-i', `color=c=black:s=${VIDEO_W}x${VIDEO_H}:d=${VIDEO_DUR}:r=30`,
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', BG], 'bg')
const VIDEO_DATA = 'data:video/mp4;base64,' + readFileSync(BG).toString('base64')

const esc = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
const FONTS_ESC = esc(FONTS_DIR)

// --- Pixel measurement --------------------------------------------------------
const INK_THRESH = 24     // "not the black background"
const WHITE_THRESH = 200  // "opaque white glyph"
function measure(buf, w, h) {
  let mass = 0, ink = 0, white = 0
  let minX = w, maxX = -1, minY = h, maxY = -1
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 3
    for (let x = 0; x < w; x++) {
      const i = rowBase + x * 3
      const r = buf[i], g = buf[i + 1], b = buf[i + 2]
      const v = Math.max(r, g, b)
      if (r > WHITE_THRESH && g > WHITE_THRESH && b > WHITE_THRESH) white++
      if (v <= INK_THRESH) continue
      ink++
      mass += v / 255
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (ink <= 0) return { mass: 0, ink: 0, white: 0, bw: 0, bh: 0, empty: true }
  return { mass, ink, white, bw: maxX - minX + 1, bh: maxY - minY + 1, empty: false }
}

/**
 * Ratios against the case's own settled sample; dimensionless, so the two
 * engines are comparable despite rasterising at different sizes.
 *
 * Four channels because the four animation types move different things, and a
 * channel an animation does not touch cannot show whether it played:
 *   size  — ink bounding box.        scale / pop.
 *   mass  — summed brightness.       fade (and, weakly, everything else).
 *   ink   — pixels above black.      blur SPREADS ink over more pixels.
 *   white — pixels above `>200`.     blur/fade take glyph cores off that bar.
 * `white` is never used for parity (antialiasing differs between engines); it
 * is a sensitivity channel only.
 */
function ratios(m, settled) {
  return {
    size: settled.bw > 0 ? m.bw / settled.bw : NaN,
    mass: settled.mass > 0 ? m.mass / settled.mass : NaN,
    ink: settled.ink > 0 ? m.ink / settled.ink : NaN,
    white: settled.white > 0 ? m.white / settled.white : NaN,
  }
}

/** Channels compared between engines. Physical and robust; excludes `white`. */
const PARITY_CHANNELS = ['size', 'mass']

// --- Burn side ----------------------------------------------------------------
function measureBurn(spec, tag) {
  const ass = burnSide.renderAss(spec)
  const assPath = path.join(DIR, `${tag}.ass`)
  writeFileSync(assPath, ass, 'utf8')
  const out = []
  for (let i = 0; i < spec.probes.length; i++) {
    const t = spec.probes[i]
    const raw = path.join(DIR, `${tag}-${i}.rgb`)
    ff(['-i', BG, '-ss', String(t), '-frames:v', '1',
      '-vf', `format=rgb24,subtitles='${esc(assPath)}':fontsdir='${FONTS_ESC}'`,
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], tag)
    out.push(measure(readFileSync(raw), VIDEO_W, VIDEO_H))
  }
  const settled = out[spec.settledIndex]
  if (settled.empty) return { error: 'no ink in the burn at the settled probe' }
  return { samples: out.map((m) => ({ ...m, ...ratios(m, settled) })), settled }
}

// --- Preview side -------------------------------------------------------------
// Served over HTTP, not file://: the real component loads its font through
// `fetch('./fonts/…')` and Chromium refuses `fetch` on file://. Under file://
// the panel silently falls back to `FALLBACK_LIBASS_SCALE`, i.e. the preview
// would be measured at a font size the app never renders.
const PREVIEW_W = 1280
const PREVIEW_H = 720
function harnessHtml(spec, cutsOverride) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face{font-family:'${FONT_CSS_FAMILY}';src:url('/fonts/Noto_Sans_JP/static/NotoSansJP-SemiBold.ttf') format('truetype');font-weight:${FONT_WEIGHT};font-style:normal;}
html,body{margin:0;background:#000}#root{width:${PREVIEW_W}px;height:${PREVIEW_H + 60}px}
.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}
.h-full{height:100%}.w-full{width:100%}.min-h-0{min-height:0}
.items-center{align-items:center}.justify-center{justify-content:center}
.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}
.overflow-hidden{overflow:hidden}.flex-shrink-0{flex-shrink:0}.isolate{isolation:isolate}
[class*="bg-surface-0"]{min-height:${PREVIEW_H}px !important;width:${PREVIEW_W}px;background:#000}
[class*="bg-input"]{background:#000 !important}
video{width:100%;height:100%;object-fit:contain;background:#000}
</style></head><body><div id="root"></div>
<script>window.__spec=${JSON.stringify(spec)};${
    cutsOverride === undefined ? '' : `window.__cutsOverride=${JSON.stringify(cutsOverride)};`
  }</script>
<script src="/.bundle.js"></script></body></html>`
}

let currentHtml = ''
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.ttf': 'font/ttf' }
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(currentHtml)
    return
  }
  const local = url === '/.bundle.js'
    ? BUNDLE
    : url.startsWith('/fonts/')
      ? path.join(REPO, 'resources', url.slice(1))
      : null
  if (!local || !existsSync(local)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': MIME[path.extname(local)] ?? 'application/octet-stream' })
  res.end(readFileSync(local))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

async function measurePreview(page, spec, tag, { cutsOverride } = {}) {
  currentHtml = harnessHtml(spec, cutsOverride)
  await page.goto(ORIGIN + '/')
  await page.waitForFunction('window.__ready === true', { timeout: 20000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.waitForTimeout(300)
  try {
    await page.waitForSelector('video', { timeout: 10000 })
  } catch {
    return { error: 'no <video> in the preview harness' }
  }
  await page.evaluate(async (dataUrl) => {
    const v = document.querySelector('video')
    v.muted = true
    v.src = dataUrl
    v.load()
    await new Promise((res) => { v.onloadeddata = res; setTimeout(res, 6000) })
    v.pause()
  }, VIDEO_DATA)

  const frame = await page.$('div[class*="bg-input"][class*="isolate"]')
  if (!frame) return { error: 'preview frame box not found' }
  const box = await frame.boundingBox()
  const w = Math.round(box.width), h = Math.round(box.height)

  const out = []
  for (let i = 0; i < spec.probes.length; i++) {
    // ★ Seek to the SOURCE instant that displays this EDITED frame, using the
    // production inverse. The control gets the SAME source time — only its cut
    // list differs — so any divergence it shows is phase, not frame choice.
    const tSource = burnSide.sourceTimeFor(spec, spec.probes[i])
    await page.evaluate((tt) => {
      window.__ui.setState({ videoSeekRequestSec: tt })
    }, tSource)
    await page.waitForTimeout(450)
    const png = path.join(DIR, `${tag}-${i}.png`)
    await frame.screenshot({ path: png })
    const raw = path.join(DIR, `${tag}-${i}.rgb`)
    ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], `png${i}`)
    out.push(measure(readFileSync(raw), w, h))
  }
  const settled = out[spec.settledIndex]
  if (settled.empty) return { error: 'no ink in the preview at the settled probe' }
  return { samples: out.map((m) => ({ ...m, ...ratios(m, settled) })), settled, frame: `${w}x${h}` }
}

// --- Run ----------------------------------------------------------------------
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: PREVIEW_W + 40, height: PREVIEW_H + 80 } })
// Rewrite the panel's `mojioko-media://` <video> src to the real black clip
// BEFORE it loads. Without this the load errors, the panel flips to `hasError`,
// and it unmounts the <video> — and the overlay with it.
await page.addInitScript((dataUrl) => {
  const rewrite = (v) => (typeof v === 'string' && v.startsWith('mojioko-media://') ? dataUrl : v)
  const proto = HTMLMediaElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'src')
  if (desc && desc.set) {
    Object.defineProperty(proto, 'src', {
      configurable: true,
      get() { return desc.get.call(this) },
      set(v) { desc.set.call(this, rewrite(v)) },
    })
  }
  const setAttr = Element.prototype.setAttribute
  Element.prototype.setAttribute = function (name, value) {
    return setAttr.call(this, name, name === 'src' ? rewrite(value) : value)
  }
}, VIDEO_DATA)
page.on('pageerror', (e) => console.error('  [pageerror]', String(e).split('\n')[0]))

const failures = []
let worstParity = 0

console.log('\n=== REQ-0532 §1 — preview animation phase under trimming ===\n')

for (const { name, spec } of CASES) {
  const tag = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const burn = measureBurn(spec, `b-${tag}`)
  const pre = await measurePreview(page, spec, `p-${tag}`)
  if (burn.error || pre.error) {
    failures.push(`${name}: ${burn.error ?? pre.error}`)
    console.log(`  ${name.padEnd(34)} ERROR ${burn.error ?? pre.error}`)
    continue
  }
  const ch = spec.channel
  const midIdx = spec.probes.map((_, i) => i).filter((i) => i !== spec.settledIndex)

  // (A) PARITY — the headline. Compared in every physical channel, not just
  // the case's own, so a fix that lines up one observable while breaking
  // another cannot pass.
  let caseParity = 0
  for (let i = 0; i < spec.probes.length; i++) {
    for (const c of PARITY_CHANNELS) {
      const a = pre.samples[i][c], b = burn.samples[i][c]
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      const d = Math.abs(a - b)
      if (d > caseParity) caseParity = d
    }
    // ★ Presence, separately from phase. `ink > 0` separates "drawn faintly"
    // from "not drawn at all" — the distinction `white` alone cannot make
    // (REQ-0531 §12-3), and the one an animation gate lives on.
    if (pre.samples[i].ink === 0) {
      failures.push(`${name}: preview has NO ink at edited t=${spec.probes[i]} (drew nothing)`)
    }
    if (burn.samples[i].ink === 0) {
      failures.push(`${name}: burn has NO ink at edited t=${spec.probes[i]}`)
    }
  }
  if (caseParity > worstParity) worstParity = caseParity
  if (caseParity > TOL_PARITY) {
    failures.push(`${name}: preview≠burn by ${caseParity.toFixed(3)} (tol ${TOL_PARITY})`)
  }

  // (B) The probes must actually sit ON the ramp, in the channel this
  // animation moves. Measured as distance from the settled plateau (1.0) in
  // EITHER direction, because `pop` overshoots past it. Without this the gate
  // would pass while proving only that both engines drew a settled caption.
  const dev = Math.max(...midIdx.map((i) => Math.abs(burn.samples[i][ch] - 1)))
  if (!(dev >= RAMP_MIN_DEVIATION)) {
    failures.push(
      `${name}: burn never leaves the settled plateau (|${ch}−1| max ${dev.toFixed(3)} < ` +
      `${RAMP_MIN_DEVIATION}) — the probes are not on the ramp`,
    )
  }

  const all = (r, i) => `${r.samples[i].size.toFixed(2)}/${r.samples[i].mass.toFixed(2)}/${r.samples[i].ink.toFixed(2)}`
  console.log(
    `  ${name.padEnd(34)} ch=${ch.padEnd(5)} dev=${dev.toFixed(3)} Δ=${caseParity.toFixed(3)}\n` +
    `      size/mass/ink   burn=[${midIdx.map((i) => all(burn, i)).join('  ')}]\n` +
    `                   preview=[${midIdx.map((i) => all(pre, i)).join('  ')}]  ` +
    `ink=${pre.samples[midIdx[0]].ink} white=${pre.samples[midIdx[0]].white}`,
  )
}

/*
 * ★ NEGATIVE CONTROL — the same cue, the same source instants, an EMPTY cut
 * list. Bit-for-bit the pre-REQ-0532 computation (raw cue times, raw clock).
 * Only the cut-bearing cases can have one: with no cuts there is nothing to
 * perturb, which is exactly why that case is the "unchanged" side of the gate.
 */
console.log('\n--- negative control (preview ignoring cuts = the pre-fix path) ---\n')
let controlDetected = 0
let controlApplicable = 0
for (const { name, spec } of CASES) {
  if (spec.cuts.length === 0) {
    console.log(`  ${name.padEnd(34)} n/a — no cuts to ignore (this is the unchanged side)`)
    continue
  }
  controlApplicable++
  const tag = 'neg-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const burn = measureBurn(spec, `nb-${tag}`)
  const pre = await measurePreview(page, spec, tag, { cutsOverride: [] })
  if (burn.error || pre.error) {
    failures.push(`negative control ${name}: ${burn.error ?? pre.error}`)
    continue
  }
  const ch = spec.channel
  let worst = 0
  for (let i = 0; i < spec.probes.length; i++) {
    const a = pre.samples[i][ch], b = burn.samples[i][ch]
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const d = Math.abs(a - b)
    if (d > worst) worst = d
  }
  const detected = worst >= NEG_MIN
  if (detected) controlDetected++
  console.log(`  ${name.padEnd(34)} ${ch.padEnd(4)} worst Δ=${worst.toFixed(3)} ${detected ? 'DETECTED' : 'NOT DETECTED'}`)
}
if (controlDetected < controlApplicable) {
  failures.push(
    `negative control detected only ${controlDetected}/${controlApplicable} cases — ` +
    `the gate cannot see the defect it exists for`,
  )
}

await browser.close()
server.close()
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best-effort */ }
try { rmSync(DUMP, { force: true }); rmSync(BUNDLE, { force: true }) } catch { /* best-effort */ }

console.log('\n=== verdict ===')
console.log(`  worst preview-vs-burn Δ = ${worstParity.toFixed(3)} (tol ${TOL_PARITY})`)
console.log(`  negative control detected ${controlDetected}/${controlApplicable}`)
if (failures.length > 0) {
  console.error('\nFAIL:')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log('\nOK — the preview animates on the same axis the burn does; ignoring cuts is detected.')
