/**
 * REQ-0514 — REAL-PIXEL gate for the scale animation's ORIGIN.
 *
 * ## What it measures
 *
 * A uniform scale about a point C maps every point p to `C + S·(p − C)`, so the
 * cue's ink centroid `c(S)` is itself LINEAR in S:  `c(S) = C + S·d`.  Sampling
 * the centroid at several instants of the entrance ramp — where the shared
 * animation model tells us S exactly — and least-squares fitting that line
 * recovers **C, the point the cue scales about**.  That is the quantity this REQ
 * is about, and it is recovered from pixels alone: no transform string, no
 * `\pos` value, and no assumption about which engine drew the frame.
 *
 * C is then reported RELATIVE to the cue's own settled ink box
 * (`(C − boxCentre) / boxSize`), which makes it dimensionless and therefore
 * directly comparable between the two engines even though they rasterise at
 * different sizes.  0 = "scales about its own centre".  ±0.5 = "scales about its
 * own edge", which is what a layout anchor produces.
 *
 * ## Both engines, one cue
 *
 * - BURN: the real `generateAss` → real ffmpeg/libass → rgb24 frame.
 * - PREVIEW: the real `VideoPreviewPanel` in headless chromium, seeked (paused)
 *   to the same instants, screenshotted, decoded through ffmpeg.
 *
 * Both are fed by `case-spec.ts`, so a case cannot describe two different cues.
 *
 * ## Frames are reversible
 *
 * RES-0326's lesson: the burn frames are extracted as rgb24 from a `-qp 0`
 * source and the preview frames are PNG.  Nothing measures a lossy H.264 frame,
 * and the metric is coverage MASS (pixel value as weight), not a non-black pixel
 * count.
 *
 * Exit 0 = pass, 1 = a parity/origin failure, 2 = environment.
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

const DIR = path.join(tmpdir(), `mojioko-scaleorg-${process.pid}`)
const FONTS_DIR = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')
const FONT_CSS_FAMILY = 'MOJIOKO Noto Sans JP'
const FONT_WEIGHT = 600

// --- Tolerances ---------------------------------------------------------------
// Units throughout: fractions of the cue's own settled ink box.
//
// (A) TOL_DRAG — the headline.  Dragging a cue writes `posX`/`posY` and moves
//     it onto the pinned layout branch; the scale origin must not notice.  This
//     is the tightest tolerance because it compares two runs of the SAME engine
//     on the SAME glyphs, so nothing but the defect can move it.  Measured
//     0.003 after the fix, 0.514 before.
const TOL_DRAG = 0.03
// (B) TOL_PARITY — preview vs burn.  Cannot go below the two engines'
//     line-box models: CSS `line-height: 1/libassScale` reserves slightly more
//     descender space than libass' own line box, so an edge-anchored cue's
//     origin sits ~0.08 ink-heights apart.  That gap predates this REQ (it is
//     present in the pre-fix numbers for the cases that were already in parity)
//     and is a line-metrics question, not an origin question.  Measured worst
//     0.077, on the bottom-anchored cases.
const TOL_PARITY = 0.10
// (C) TOL_CENTRE — on an axis the cue is centre-aligned on, the origin must BE
//     the cue's centre.  The floor here is the gap between the ink bounding box
//     (all this gate can see) and the layout box (what both engines actually
//     anchor): glyph ascender/descender asymmetry.  Measured worst 0.076.
const TOL_CENTRE = 0.10
// The negative control (pre-fix preview) must show a drag shift at least this
// large, or the sampler is not proving anything.
const NEG_MIN = 0.20

// --- Bundle both sides --------------------------------------------------------
function bundleAll() {
  esbuild.buildSync({
    entryPoints: [path.join(HERE, 'dump-entry.ts')],
    bundle: true, outfile: DUMP, format: 'cjs', platform: 'node',
    loader: { '.css': 'empty', '.png': 'empty' },
    alias: { '@': path.join(REPO, 'src/renderer') },
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
}
bundleAll()
const burnSide = require(DUMP)
const { BASE, CUE_START, VIDEO_W, VIDEO_H } = burnSide

// --- ffmpeg preflight ---------------------------------------------------------
if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('verify:scale-origin: ffmpeg not found on PATH')
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

// Pure-black source at the ASS PlayRes, lossless.  Used as the burn background
// AND as the preview's <video>, so the two engines composite over the same
// thing and "ink" means the same thing on both sides.
const BG = path.join(DIR, 'bg.mp4')
ff(['-f', 'lavfi', '-i', `color=c=black:s=${VIDEO_W}x${VIDEO_H}:d=6:r=30`,
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', BG], 'bg')
const VIDEO_DATA = 'data:video/mp4;base64,' + readFileSync(BG).toString('base64')

const esc = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
const FONTS_ESC = esc(FONTS_DIR)

// --- Pixel measurement --------------------------------------------------------
// Coverage MASS centroid (RES-0326): each pixel contributes its own brightness,
// so a uniformly faded cue (both engines ramp opacity alongside the scale) has
// the same centroid as an opaque one.  A non-black pixel COUNT would not.
const THRESH = 24
function measure(buf, w, h) {
  let mass = 0, sx = 0, sy = 0
  let minX = w, maxX = -1, minY = h, maxY = -1
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 3
    for (let x = 0; x < w; x++) {
      const i = rowBase + x * 3
      const v = Math.max(buf[i], buf[i + 1], buf[i + 2])
      if (v <= THRESH) continue
      const m = v / 255
      mass += m; sx += x * m; sy += y * m
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (mass <= 0) return null
  return {
    cx: sx / mass, cy: sy / mass, mass,
    bw: maxX - minX + 1, bh: maxY - minY + 1,
    bcx: (minX + maxX) / 2, bcy: (minY + maxY) / 2,
  }
}

/** Least-squares fit of `c = C + S·d`; returns the fixed point C. */
function fixedPoint(samples) {
  const n = samples.length
  let sS = 0, sSS = 0
  for (const p of samples) { sS += p.s; sSS += p.s * p.s }
  const fit = (key) => {
    let sC = 0, sSC = 0
    for (const p of samples) { sC += p[key]; sSC += p.s * p[key] }
    const den = n * sSS - sS * sS
    if (Math.abs(den) < 1e-9) return NaN
    const d = (n * sSC - sS * sC) / den
    return (sC - d * sS) / n // intercept = C
  }
  return { x: fit('cx'), y: fit('cy') }
}

/** C relative to the cue's own settled ink box; dimensionless. */
function normalised(C, settled) {
  return {
    nx: (C.x - settled.bcx) / settled.bw,
    ny: (C.y - settled.bcy) / settled.bh,
  }
}

// --- Ramp sampling ------------------------------------------------------------
// Fractions of the ENTRANCE ramp to sample at.  Kept away from p = 0 (where the
// shared opacity ramp puts the cue at alpha 0 and there is no ink to measure at
// all) and inclusive of the settled plateau (S = 1), which also supplies the ink
// box the result is normalised by.
const RAMP_PROBES = [0.12, 0.25, 0.40, 1.0]
function sampleTimes(spec) {
  const inSec = burnSide.inSecOf(spec)
  return RAMP_PROBES.map((p) => CUE_START + p * inSec)
}

// --- Burn side ----------------------------------------------------------------
function burnAt(ass, t, tag) {
  const assPath = path.join(DIR, `${tag}.ass`)
  const rawPath = path.join(DIR, `${tag}.rgb`)
  writeFileSync(assPath, ass, 'utf8')
  ff(['-i', BG, '-ss', String(t), '-frames:v', '1',
    '-vf', `format=rgb24,subtitles='${esc(assPath)}':fontsdir='${FONTS_ESC}'`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath], tag)
  return measure(readFileSync(rawPath), VIDEO_W, VIDEO_H)
}

function measureBurn(spec) {
  const ass = burnSide.renderAss(spec)
  const out = []
  const times = sampleTimes(spec)
  for (let i = 0; i < times.length; i++) {
    const m = burnAt(ass, times[i], `b${i}`)
    if (!m) return { error: `no ink in the burn at t=${times[i].toFixed(3)}` }
    out.push({ ...m, s: burnSide.scaleAt(spec, times[i]) })
  }
  const settled = out[out.length - 1]
  return { ...normalised(fixedPoint(out), settled), settled, samples: out }
}

// --- Preview side -------------------------------------------------------------
// The harness is served over HTTP, not file://, for one concrete reason: the
// real component loads its font through `fetch('./fonts/…')` (font-metrics.ts),
// and Chromium refuses `fetch` on file:// outright.  Under file:// the panel
// silently fell back to `FALLBACK_LIBASS_SCALE`, i.e. the preview would have
// been measured at a font size the app never actually renders.
const PREVIEW_W = 1280
const PREVIEW_H = 720
function harnessHtml(spec) {
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
/* The frame box must be BLACK, not the zinc \`bg-input\` placeholder: the metric
   thresholds on brightness, and a non-black backdrop would be counted as ink. */
[class*="bg-input"]{background:#000 !important}
video{width:100%;height:100%;object-fit:contain;background:#000}
</style></head><body><div id="root"></div>
<script>window.__spec=${JSON.stringify(spec)}</script>
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

/**
 * The NEGATIVE CONTROL, applied in the page just before each screenshot.
 *
 * It rewrites the overlay's own transform back into its pre-REQ-0514 shape:
 * the animation layer moved from the END of the list to the FRONT (so the
 * layout translate is inside the scale again), and — because the pre-fix code
 * gave a rotated cue `center center` — that origin restored when the cue is
 * rotated.  Nothing else is touched; the string being rearranged is the one
 * production actually emitted this frame.
 *
 * ★ Why a rewrite and not a `git checkout` of the pre-fix file.  That is what
 * this gate did first, and it is wrong twice over.  It rots: historical sources
 * import the tree as it was then while the rest of the bundle is the tree as it
 * is now — the sibling gate `verify:anim-first-frame` had been dead for four
 * REQs from exactly that (see its `pre-fix-cue-animation.ts`).  And resolving
 * "the fix commit" by `git rev-list --grep` silently picks up any LATER commit
 * mentioning the same REQ, so the control ends up measuring the fixed code and
 * passes while proving nothing — observed here, with a gate-maintenance commit.
 * Rewriting the live string needs no history and cannot drift out of date: if
 * production stops emitting `var(--cue-anim-transform)` in a list, the rewrite
 * matches nothing, `applied` comes back 0, and the gate says so.
 */
async function applyPreFixComposition(page, rotationDeg) {
  return page.evaluate((rot) => {
    let applied = 0
    for (const el of document.querySelectorAll('span')) {
      const t = el.style.transform
      if (!t || !t.includes('var(--cue-anim-transform)')) continue
      const rest = t.replace('var(--cue-anim-transform)', '').trim()
      el.style.transform = `var(--cue-anim-transform) ${rest}`.trim()
      if (rot !== 0) el.style.transformOrigin = 'center center'
      applied++
    }
    return applied
  }, rotationDeg)
}

async function measurePreview(page, spec, preFix = false) {
  currentHtml = harnessHtml(spec)
  await page.goto(ORIGIN + '/')
  await page.waitForFunction('window.__ready === true', { timeout: 20000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.waitForTimeout(300)
  try {
    await page.waitForSelector('video', { timeout: 10000 })
  } catch {
    const diag = await page.evaluate(() => {
      const body = document.querySelector('[class*="bg-surface-0"]')
      return {
        videos: document.querySelectorAll('video').length,
        body: body ? `${body.clientWidth}x${body.clientHeight}` : 'null',
        text: document.body.innerText.slice(0, 120),
      }
    })
    return { error: `no <video> (n=${diag.videos}) body=${diag.body} text="${diag.text}"` }
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

  const times = sampleTimes(spec)
  const out = []
  for (let i = 0; i < times.length; i++) {
    const t = times[i]
    await page.evaluate((tt) => {
      window.__ui.setState({ videoSeekRequestSec: tt })
    }, t)
    await page.waitForTimeout(450)
    if (preFix) {
      // Re-applied per sample: React owns `style.transform` and re-renders.
      const applied = await applyPreFixComposition(page, spec.rotation)
      if (applied === 0) {
        return { error: 'negative control matched no overlay — the transform shape changed' }
      }
    }
    const png = path.join(DIR, `p${i}.png`)
    await frame.screenshot({ path: png })
    const raw = path.join(DIR, `p${i}.rgb`)
    ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], `png${i}`)
    const m = measure(readFileSync(raw), w, h)
    if (!m) return { error: `no ink in the preview at t=${t.toFixed(3)}` }
    out.push({ ...m, s: burnSide.scaleAt(spec, t) })
  }
  const settled = out[out.length - 1]
  return { ...normalised(fixedPoint(out), settled), settled, samples: out, frame: `${w}x${h}` }
}

// --- Case matrix --------------------------------------------------------------
// Every dimension the REQ names, laid out as PAIRS: each `pair` key names one
// cue configuration that appears twice, once unpinned and once dragged.  The
// drag is the whole subject of REQ-0514, so the gate's sharpest assertion is
// "these two agree" — see the verdict.  Beyond the drag: rotation on and off,
// both scale-bearing animation types (`pop` carries the same scale channel), a
// non-centre alignment on each axis, and a multi-line cue with non-zero line
// spacing — which the ASS writer splits into one `\pos`ed event per line, so
// the two engines are positioning a different NUMBER of objects and the origin
// still has to land in the same place.
const CASES = [
  ['centre/centre rot0', 'cc0', {}],
  ['centre/centre rot0, DRAGGED', 'cc0', { pin: { x: 463, y: 263 } }],
  ['centre/centre rot30', 'cc30', { rotation: 30 }],
  ['centre/centre rot30, DRAGGED', 'cc30', { rotation: 30, pin: { x: 463, y: 263 } }],
  ['centre/bottom (default)', 'cb', { v: 'bottom', marginV: 120 }],
  ['centre/bottom (default), DRAGGED', 'cb', { v: 'bottom', marginV: 120, pin: { x: 700, y: 800 } }],
  ['left/top', 'lt', { h: 'left', v: 'top', marginV: 120 }],
  ['left/top, DRAGGED', 'lt', { h: 'left', v: 'top', marginV: 120, pin: { x: 300, y: 200 } }],
  ['right/bottom', 'rb', { h: 'right', v: 'bottom', marginV: 120 }],
  ['right/bottom, DRAGGED', 'rb', { h: 'right', v: 'bottom', marginV: 120, pin: { x: 1500, y: 900 } }],
  ['pop', 'pop', { anim: 'pop', startScalePercent: 0 }],
  ['pop, DRAGGED', 'pop', { anim: 'pop', startScalePercent: 0, pin: { x: 463, y: 263 } }],
  ['2 lines, line spacing -20', 'ls', { L: 2, lineSpacingPercent: -20 }],
  ['2 lines, line spacing -20, DRAGGED', 'ls', { L: 2, lineSpacingPercent: -20, pin: { x: 700, y: 500 } }],
  ['japanese rot30', 'jp', { script: 'jp', rotation: 30 }],
  ['japanese rot30, DRAGGED', 'jp', { script: 'jp', rotation: 30, pin: { x: 900, y: 400 } }],
].map(([label, pair, over]) => [label, pair, { ...BASE, ...over }])

// --- Run ----------------------------------------------------------------------
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: PREVIEW_W + 40, height: PREVIEW_H + 80 } })
// Rewrite the panel's `mojioko-media://` <video> src to the real black clip
// BEFORE it loads.  Without this the load errors, the panel flips to `hasError`,
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
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [console.error]', m.text().split('\n')[0].slice(0, 200))
})

async function runAll(label, { previewOnly = false, preFix = false } = {}) {
  const results = []
  for (const [name, pair, spec] of CASES) {
    const pre = await measurePreview(page, spec, preFix)
    const burn = previewOnly ? null : measureBurn(spec)
    results.push({ name, pair, spec, pre, burn })
    const fmt = (r) => r?.error ? `ERROR(${r.error})` : `(${r.nx.toFixed(3)}, ${r.ny.toFixed(3)})`
    console.log(`  ${label} ${name.padEnd(36)} preview=${fmt(pre)}${burn ? `  burn=${fmt(burn)}` : ''}`)
  }
  return results
}

/** Worst per-axis difference between two measured origins. */
function delta(a, b) {
  return Math.max(Math.abs(a.nx - b.nx), Math.abs(a.ny - b.ny))
}

/**
 * The three properties REQ-0514 actually asks for, checked over a run.
 * Returns `{ drag, parity, centre }` = the worst observed value of each, plus
 * the failing lines.  Shared with the negative control so the control is
 * evaluated by the SAME predicate that decides the verdict.
 */
function evaluate(run, { withBurn }) {
  const lines = []
  let drag = 0, parity = 0, centre = 0
  const byPair = new Map()
  for (const r of run) {
    if (r.pre?.error || r.burn?.error) {
      lines.push(`  FAIL  ${r.name}: ${r.pre?.error ?? r.burn?.error}`)
      drag = parity = centre = Infinity
      continue
    }
    // (A) THE DRAG.  The origin must not depend on whether the cue carries an
    // explicit posX/posY — this is the whole of REQ-0514.
    const prev = byPair.get(r.pair)
    if (prev) {
      const d = delta(prev.pre, r.pre)
      drag = Math.max(drag, d)
      if (d > TOL_DRAG) {
        lines.push(`  FAIL  ${r.name}: dragging moved the scale origin by ${d.toFixed(3)} (tol ${TOL_DRAG})`)
      }
    } else {
      byPair.set(r.pair, r)
    }
    if (!withBurn) continue
    // (B) PARITY.  The preview must scale about the point libass scales about.
    const p = delta(r.pre, r.burn)
    parity = Math.max(parity, p)
    if (p > TOL_PARITY) {
      lines.push(`  FAIL  ${r.name}: preview vs burn origin differs by ${p.toFixed(3)} (tol ${TOL_PARITY})`)
    }
    // (C) CENTRE.  On an axis the cue is CENTRE-aligned on, the shared anchor
    // IS the cue's own centre — which is the behaviour the owner asked for and
    // the configuration the bug was reported in.  Off-centre axes are anchored
    // by design (libass cannot centre them: the ASS writer measures no text),
    // so they are deliberately not asserted here.
    for (const e of [r.pre, r.burn]) {
      if (r.spec.h === 'center') {
        centre = Math.max(centre, Math.abs(e.nx))
        if (Math.abs(e.nx) > TOL_CENTRE) {
          lines.push(`  FAIL  ${r.name}: centre-aligned but scales about x=${e.nx.toFixed(3)} (tol ${TOL_CENTRE})`)
        }
      }
      if (r.spec.v === 'center') {
        centre = Math.max(centre, Math.abs(e.ny))
        if (Math.abs(e.ny) > TOL_CENTRE) {
          lines.push(`  FAIL  ${r.name}: centre-aligned but scales about y=${e.ny.toFixed(3)} (tol ${TOL_CENTRE})`)
        }
      }
    }
  }
  return { drag, parity, centre, lines }
}

console.log(`verify:scale-origin — ${CASES.length} cases`)
console.log('metric: the scale animation\'s fixed point, relative to the cue\'s own settled ink box')
console.log('        (0,0) = scales about its own centre;  ±0.5 = scales about its own edge\n')
console.log('=== current tree ===')
const head = await runAll('HEAD')

// --- Negative control ---------------------------------------------------------
// Same run, with the pre-REQ-0514 composition rewritten back onto the live
// overlay — see `applyPreFixComposition`.  A gate whose negative control passes
// is proving nothing.
console.log('\n=== negative control (pre-REQ-0514 transform composition) ===')
const neg = await runAll('PRE ', { previewOnly: true, preFix: true })

await browser.close()

// --- Verdict ------------------------------------------------------------------
console.log('\n=== verdict ===')
const v = evaluate(head, { withBurn: true })
for (const l of v.lines) console.log(l)
console.log(`(A) worst origin shift caused by a DRAG = ${v.drag.toFixed(3)} (tol ${TOL_DRAG})`)
console.log(`(B) worst |preview − burn| origin       = ${v.parity.toFixed(3)} (tol ${TOL_PARITY})`)
console.log(`(C) worst off-centre on a CENTRE axis   = ${v.centre.toFixed(3)} (tol ${TOL_CENTRE})`)

const negV = evaluate(neg ?? [], { withBurn: false })
console.log(`negative control: pre-fix drag shift = ${negV.drag.toFixed(3)} (needs ≥${NEG_MIN} to prove the sampler sees it)`)

server.close()
rmSync(DIR, { recursive: true, force: true })
for (const f of [DUMP, BUNDLE]) if (existsSync(f)) rmSync(f, { force: true })

if (!(negV.drag >= NEG_MIN)) {
  console.error('\nFAIL: the negative control did NOT show the pre-fix drag shift — the gate proves nothing.')
  process.exit(1)
}
if (v.lines.length > 0) {
  console.error('\nFAIL: the scale animation\'s origin is not the shared `\\an` anchor in both engines.')
  process.exit(1)
}
console.log('\nOK: the scale origin is the cue\'s own `\\an` anchor in BOTH engines, is unmoved by a drag,')
console.log('    and is the cue\'s own centre on every axis the cue is centre-aligned on.')
