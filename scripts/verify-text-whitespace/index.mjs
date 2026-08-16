/**
 * REQ-0515 — REAL-PIXEL gate: whitespace the user typed reaches the screen and
 * the MP4, on a KARAOKE cue.
 *
 * ## The defect
 *
 * `areWordsValidForText` compares `words` to `text` with all whitespace
 * stripped (REQ-0287, so an auto-line-break `\N` does not kill karaoke).  Both
 * renderers then took the DISPLAY text from `words` — so typing a space into a
 * karaoke cue changed `text`, left the predicate true, and the space never
 * appeared.  Deleting one character is what finally broke the stripped
 * comparison, dropped the cue to the equal-split fallback (whose units are
 * built from `text`), and made the spaces appear all at once.
 *
 * ## What this measures
 *
 * The cue is 「テスト␣␣␣です」 with white glyphs on black and no outline, so
 * the ONLY ink is the glyph fill and an ink gap IS a whitespace gap.  The gate
 * takes the ink column profile, merges runs closer than the natural
 * inter-glyph spacing, and reports the widest interior gap as a fraction of the
 * cue's own ink span — dimensionless, so the preview (rendered a few hundred px
 * wide) and the burn (1920 px) are directly comparable.
 *
 * Three assertions, all on real pixels:
 *
 *   (A) KARAOKE ON == KARAOKE OFF.  Karaoke-off always drew `text` verbatim, so
 *       it is the reference for what the cue is supposed to spell.  This is the
 *       bug, stated as a property.
 *   (B) PREVIEW == BURN, per case.
 *   (C) The gap RESPONDS to the text: more spaces ⇒ wider gap, strictly.
 *       Without this, a renderer that dropped whitespace in both engines and
 *       both karaoke states would satisfy (A) and (B).
 *
 * Both negative controls reproduce the pre-fix render and must be caught.
 *
 * Frames are reversible throughout (rgb24 from a `-qp 0` source; PNG from the
 * browser) — RES-0326's lesson.
 *
 * Exit 0 = pass, 1 = a failure, 2 = environment.
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
const DIR = path.join(tmpdir(), `mojioko-ws-${process.pid}`)
const FONTS_DIR = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')
const FONT_CSS_FAMILY = 'MOJIOKO Noto Sans JP'
const FONT_WEIGHT = 600

// --- Tolerances ---------------------------------------------------------------
// Units throughout: the cue's ink WIDTH in its own glyph heights (see
// `inkWidth`).  For reference, one half-width space at this size is ~0.45 and
// one full-width space ~0.9 of a glyph height, so the scale is generous.
//
// (A) karaoke ON vs OFF, same engine, same glyphs — the two must spell the same
//     cue.  Nothing but the defect can move this.
const TOL_KARAOKE = 0.10
// (B) preview vs burn.  Looser: two rasterisers and two text-shaping stacks
//     (Chromium vs libass) lay the same string out a hair differently.
const TOL_ENGINE = 0.40
// (C) each step of the ladder must widen the cue by at least this much, or the
//     metric is not actually reading the whitespace.
const MIN_WIDTH_STEP = 0.15
// A control must be off by at least this much to count as detected.
const NEG_MIN = 0.20

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
const { VIDEO_W, VIDEO_H, SAMPLE_SEC } = burnSide

if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('verify:text-whitespace: ffmpeg not found on PATH')
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

const BG = path.join(DIR, 'bg.mp4')
ff(['-f', 'lavfi', '-i', `color=c=black:s=${VIDEO_W}x${VIDEO_H}:d=6:r=30`,
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', BG], 'bg')
const VIDEO_DATA = 'data:video/mp4;base64,' + readFileSync(BG).toString('base64')

const esc = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
const FONTS_ESC = esc(FONTS_DIR)

// --- The metric ---------------------------------------------------------------
const THRESH = 40
/**
 * The cue's ink WIDTH, measured in its own glyph heights.
 *
 * Every case draws the same five glyphs at the same size, so the only thing
 * that can widen the ink is whitespace between them — which makes the width
 * a direct read of "did the spaces get rendered".  Dividing by the measured
 * glyph height makes it dimensionless, so the 1920 px burn and the ~1280 px
 * preview produce the same number for the same cue.
 *
 * ## Why not "the widest gap between glyph blocks"
 *
 * That was the first metric here and it was wrong, which the gate itself
 * caught: at `\fs100` the natural gap inside 「テスト」 (ス→ト, 27 px) is
 * WIDER than a single half-width space (25 px).  So the baseline was already
 * dominated by a glyph gap, one typed space moved the number by 0.004, and no
 * merge threshold separates the two cases — any threshold that keeps a
 * one-space gap also keeps the ス→ト gap.  Total width has no such ambiguity.
 */
function inkWidth(buf, w, h) {
  let minX = w, maxX = -1, minY = h, maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      if (Math.max(buf[i], buf[i + 1], buf[i + 2]) <= THRESH) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  const glyphH = maxY - minY + 1
  if (glyphH <= 0) return null
  return { ratio: (maxX - minX + 1) / glyphH, widthPx: maxX - minX + 1, glyphH }
}

// --- Burn side ----------------------------------------------------------------
function measureBurn(ass, tag) {
  const assPath = path.join(DIR, `${tag}.ass`)
  const rawPath = path.join(DIR, `${tag}.rgb`)
  writeFileSync(assPath, ass, 'utf8')
  ff(['-i', BG, '-ss', String(SAMPLE_SEC), '-frames:v', '1',
    '-vf', `format=rgb24,subtitles='${esc(assPath)}':fontsdir='${FONTS_ESC}'`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath], tag)
  return inkWidth(readFileSync(rawPath), VIDEO_W, VIDEO_H)
}

// --- Preview side -------------------------------------------------------------
// Served over HTTP, not file://, because the real component loads its font via
// `fetch('./fonts/…')` and Chromium refuses `fetch` on file:// — under file://
// the panel silently falls back to FALLBACK_LIBASS_SCALE, i.e. a font size the
// app never actually renders.
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
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(currentHtml); return
  }
  const local = url === '/.bundle.js'
    ? BUNDLE
    : url.startsWith('/fonts/') ? path.join(REPO, 'resources', url.slice(1)) : null
  if (!local || !existsSync(local)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': MIME[path.extname(local)] ?? 'application/octet-stream' })
  res.end(readFileSync(local))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

/**
 * ★ THE NEGATIVE CONTROL, preview side.
 *
 * Pre-REQ-0515 the karaoke spans held the raw WORD text, which for this cue
 * carried no leading whitespace at all.  Stripping the leading whitespace off
 * every `[data-karaoke-word-idx]` span therefore reproduces exactly the
 * pre-fix spelling, on the real component, with no git and nothing that can
 * rot.  Returns how many spans it touched so a shape change fails loudly
 * instead of quietly proving nothing.
 */
async function applyPreFixSpelling(page) {
  return page.evaluate(() => {
    const spans = document.querySelectorAll('[data-karaoke-word-idx]')
    let n = 0
    for (const s of spans) {
      const t = s.textContent ?? ''
      const stripped = t.replace(/^\s+/, '')
      if (stripped !== t) { s.textContent = stripped; n++ }
    }
    return { touched: n, spans: spans.length }
  })
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
    return { error: 'no <video> mounted in the preview harness' }
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

  await page.evaluate((t) => { window.__ui.setState({ videoSeekRequestSec: t }) }, SAMPLE_SEC)
  await page.waitForTimeout(500)

  if (preFix) {
    const r = await applyPreFixSpelling(page)
    if (r.spans === 0) return { error: 'negative control found no karaoke spans' }
    if (r.touched === 0) return { error: 'negative control changed nothing — spelling shape moved' }
    await page.waitForTimeout(100)
  }

  const png = path.join(DIR, 'p.png')
  await frame.screenshot({ path: png })
  const raw = path.join(DIR, 'p.rgb')
  ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], 'png')
  const m = inkWidth(readFileSync(raw), w, h)
  return m === null ? { error: 'no ink in the preview' } : m
}

// --- Cases --------------------------------------------------------------------
// The stored `words` spell 「テストです」; every case edits ONLY `text`, which
// is what the owner did.  The 0-space row is the baseline the others must beat.
const TEXTS = [
  ['0 spaces', 'テストです'],
  ['1 halfwidth', 'テスト です'],
  ['3 halfwidth (the report)', 'テスト   です'],
  ['3 fullwidth', 'テスト　　　です'],
]

console.log('verify:text-whitespace — does typed whitespace reach the screen and the MP4?')
console.log('metric: cue ink WIDTH in its own glyph heights (grows with every space rendered)\n')

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: PREVIEW_W + 40, height: PREVIEW_H + 80 } })
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

const rows = []
for (const [label, text] of TEXTS) {
  const on = { text, karaoke: true }
  const off = { text, karaoke: false }
  const row = {
    label,
    burnOn: measureBurn(burnSide.renderAss(on), 'on'),
    burnOff: measureBurn(burnSide.renderAss(off), 'off'),
    burnPre: measureBurn(burnSide.renderAssPreFix(on), 'pre'),
    prevOn: await measurePreview(page, on),
    // The 0-space row has no whitespace to remove, so there is no pre-fix
    // state to reproduce; controls run on the spaced rows only.
    prevPre: text === TEXTS[0][1] ? null : await measurePreview(page, on, true),
  }
  rows.push(row)
  const f = (m) => (m === null ? 'n/a' : m.error ? `ERR(${m.error})` : m.ratio.toFixed(3))
  console.log(
    `  ${label.padEnd(26)} burn on=${f(row.burnOn)} off=${f(row.burnOff)} ` +
    `| preview on=${f(row.prevOn)} | pre-fix burn=${f(row.burnPre)} preview=${f(row.prevPre)}`,
  )
}

await browser.close()
server.close()

// --- Verdict ------------------------------------------------------------------
console.log('\n=== verdict ===')
let fail = false
const bad = (msg) => { fail = true; console.log(`  FAIL  ${msg}`) }
let worstKaraoke = 0, worstEngine = 0

for (const r of rows) {
  for (const [k, v] of Object.entries(r)) {
    if (k === 'label') continue
    if (k === 'prevPre' && v === null) continue // n/a on the 0-space row
    if (v === null || v?.error) bad(`${r.label}: ${k} → ${v?.error ?? 'no ink'}`)
  }
  if (r.burnOn && r.burnOff && !r.burnOn.error && !r.burnOff.error) {
    const d = Math.abs(r.burnOn.ratio - r.burnOff.ratio)
    worstKaraoke = Math.max(worstKaraoke, d)
    if (d > TOL_KARAOKE) bad(`${r.label}: burn karaoke ON vs OFF differ by ${d.toFixed(3)} (tol ${TOL_KARAOKE})`)
  }
  if (r.prevOn && r.burnOn && !r.prevOn.error && !r.burnOn.error) {
    const d = Math.abs(r.prevOn.ratio - r.burnOn.ratio)
    worstEngine = Math.max(worstEngine, d)
    if (d > TOL_ENGINE) bad(`${r.label}: preview vs burn differ by ${d.toFixed(3)} (tol ${TOL_ENGINE})`)
  }
}

// (C) the gap must actually track the text.
const ladder = rows.filter((r) => r.burnOn && !r.burnOn.error).map((r) => r.burnOn.ratio)
for (let i = 1; i < ladder.length; i++) {
  if (ladder[i] - ladder[i - 1] < MIN_WIDTH_STEP) {
    bad(`cue did not widen from "${rows[i - 1].label}" to "${rows[i].label}" `
      + `(${ladder[i - 1].toFixed(3)} → ${ladder[i].toFixed(3)}, need +${MIN_WIDTH_STEP})`)
  }
}

console.log(`(A) worst |karaoke ON − OFF| (burn)    = ${worstKaraoke.toFixed(3)} (tol ${TOL_KARAOKE})`)
console.log(`(B) worst |preview − burn|            = ${worstEngine.toFixed(3)} (tol ${TOL_ENGINE})`)
console.log(`(C) width ladder (burn, karaoke on)   = ${ladder.map((v) => v.toFixed(3)).join(' → ')}`)

// Controls: on every case that HAS spaces, the pre-fix render must lose them.
let negBurn = 0, negPrev = 0, spaced = 0
for (const r of rows.slice(1)) {
  if (!r.burnOn || r.burnOn.error) continue
  spaced++
  if (r.burnPre && !r.burnPre.error && r.burnOn.ratio - r.burnPre.ratio >= NEG_MIN) negBurn++
  if (r.prevPre && !r.prevPre.error && r.prevOn.ratio - r.prevPre.ratio >= NEG_MIN) negPrev++
}
console.log(`negative controls: burn ${negBurn}/${spaced}, preview ${negPrev}/${spaced} detected (≥${NEG_MIN})`)

rmSync(DIR, { recursive: true, force: true })
for (const f of [DUMP, BUNDLE]) if (existsSync(f)) rmSync(f, { force: true })

if (negBurn < spaced || negPrev < spaced) {
  console.error('\nFAIL: a negative control was not detected — the gate proves nothing.')
  process.exit(1)
}
if (fail) {
  console.error('\nFAIL: typed whitespace does not survive to the screen and the MP4.')
  process.exit(1)
}
console.log('\nOK: a karaoke cue spells its own text — typed whitespace reaches both the preview and the burn.')
