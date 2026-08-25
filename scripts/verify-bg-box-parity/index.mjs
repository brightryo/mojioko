/**
 * REQ-0535 — `npm run verify:bg-box-parity`.
 *
 * ## What it asserts
 *
 * A cue's background must read as ONE uniform layer, at any opacity: no darker
 * band where two display lines' boxes meet, and no gap where the source shows
 * through.  It is checked on BOTH sides — the real `generateAss` through real
 * ffmpeg/libass, and the real `VideoPreviewPanel` in real chromium — from ONE
 * cue builder (`case-spec.ts`).
 *
 * ## Why it judges by ABSOLUTE value, not by preview/burn agreement
 *
 * This defect existed on both sides simultaneously and they AGREED with each
 * other throughout (REQ-0333 measured exactly that agreement and concluded the
 * preview was fine).  So agreement proves nothing here.  The source is a flat
 * grey, which makes the correct answer predictable in advance: a background at
 * opacity p lands on `src × (1 − p)`, and a second blend of the same layer on
 * `src × (1 − p)²`.  Every band is judged against that number.
 *
 * `src` is MEASURED per image rather than assumed: the burn decodes the grey to
 * exactly 128, the preview's `<video>` to 126.
 *
 * ## The metric
 *
 * Per row of the background region, the MODE of the pixels darker than the
 * source — the level that most of that row's background actually sits at.  A
 * row whose background is missing across most of its width is a GAP; a row whose
 * mode is below one layer has been painted twice.
 *
 * The obvious metric — the row MINIMUM — does not survive contact with a real
 * renderer, and neither does a low percentile.  Chromium leaves a soft dark
 * patch near the line boundary from text rasterisation alone (present with the
 * background canvas hidden), which owns any fixed rank and reported ~17 phantom
 * "painted twice" rows per case.  The mode cannot be moved by a minority of
 * pixels, while a genuinely doubled band moves it by definition — it darkens
 * EVERY background pixel on the row.  No column or margin is chosen, so the
 * metric makes no assumption about where the glyphs are.
 *
 * ## The empty-set trap (§3-1)
 *
 * "Every row is correct" is trivially true of no rows.  So the band is asserted
 * to EXIST first: the region must be at least `MIN_REGION_ROWS` tall, and the
 * control must actually fail.  A case that stops producing a background fails
 * rather than passes.
 *
 * ## The negative control (§3-2)
 *
 * Both controls perturb an INPUT of the current code — no `git checkout`, no
 * historical import, nothing that rots when the tree moves on (CLAUDE.md §18,
 * learned in REQ-0514):
 *
 *   burn    — withhold the font metrics, which is the exact input that makes
 *             `generateAss` fall back to libass's per-line `BorderStyle=3` box.
 *   preview — put `background-color` back on the live wrapper and hide the
 *             canvas layer, i.e. the pre-REQ-0535 CSS, on the real component.
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
const DIR = path.join(tmpdir(), `mojioko-bgbox-${process.pid}`)
const FONTS_DIR = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')
const FONT_CSS_FAMILY = 'MOJIOKO Noto Sans JP'
const PREVIEW_W = 1280
const PREVIEW_H = 720

/**
 * Tolerance, in 8-bit levels, on a band's darkest pixel.
 *
 * The defect is not subtle: one layer is 51, two are 19 — a gap of 32.  Rounding
 * between libass and chromium accounts for ~2 (measured 19 vs 21 for the same
 * double-blend).  3 sits an order of magnitude below the signal.
 */
const LEVEL_TOL = 3
/** A region shorter than this is not a two-line cue; treat it as a broken case. */
const MIN_REGION_ROWS = 40

esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: DUMP, format: 'cjs', platform: 'node',
  // `gate-metrics.ts` reads the TTF relative to its own directory; the bundle
  // lives elsewhere, so `__dirname` has to be pinned to the source location.
  define: { __dirname: JSON.stringify(HERE) },
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
  alias: { '@': path.join(REPO, 'src/renderer'), 'react-i18next': path.join(HERE, 'react-i18next-stub.ts') },
  logLevel: 'silent',
})

const burnSide = require(DUMP)
const { CASES, VIDEO_W, VIDEO_H, SOURCE_GREY } = burnSide
// Fails loudly if the real font did not load — otherwise `generateAss` keeps its
// libass-box fallback and this gate would measure the defect it is testing for.
burnSide.assertRealFont()

if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('verify:bg-box-parity: ffmpeg not found on PATH')
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
const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:')

let failures = 0
const check = (ok, label, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`)
}

// --- The metric ---------------------------------------------------------------

/**
 * Rows of the background region, each reduced to its darkest pixel.
 *
 * Returns null when no background was painted at all.  The first and last row
 * are dropped: a box edge is antialiased against the source and is neither one
 * layer nor a gap.
 */
function backgroundRows(buf, w, h, region = null) {
  // Mean of R,G,B, not the red channel alone.  Chromium antialiases text with
  // SUBPIXEL (LCD) rendering, which pushes the channels in opposite directions
  // at a glyph edge: measured red dipping to 45–47 against a 51 background,
  // purely as colour fringing.  Reading one channel would report that as "the
  // background was painted twice" — 19 phantom rows per case, in exactly the
  // columns the glyphs occupy.  The mean cancels the fringe; `--disable-lcd-text`
  // at launch removes most of it in the first place.
  const px = (x, y) => {
    const i = (y * w + x) * 3
    return (buf[i] + buf[i + 1] + buf[i + 2]) / 3
  }
  // ★ The source level, MEASURED, not assumed to be exactly SOURCE_GREY.
  //
  // The burn decodes the flat grey to exactly 128; the preview's <video> does
  // not — it lands on 126 after h264 + yuv→rgb. Assuming 128 made a gap read as
  // "126, which is darker than the source, so it must be background", and the
  // +40 control — whose whole point is that it GAPS — passed as if it had no
  // gap. Sampling the top rows (always outside the cue) keeps the absolute
  // prediction honest on both sides.
  let src = SOURCE_GREY
  {
    const counts = new Map()
    let bestN = 0
    for (let y = 0; y < Math.min(4, h); y++) {
      for (let x = 0; x < w; x++) {
        const k = Math.round(px(x, y))
        const n = (counts.get(k) ?? 0) + 1
        counts.set(k, n)
        if (n > bestN) { bestN = n; src = k }
      }
    }
  }
  const DARK_MARGIN = 4

  let x0 = w, x1 = -1, y0 = h, y1 = -1
  if (region) {
    // ★ The caller knows exactly where the cue's background is, and says so.
    //
    // Deriving the region from "every pixel darker than the source" looked
    // equivalent and is not: the preview panel paints its own chrome, and a
    // small dark element at the frame CENTRE was swept into the bounding box.
    // It sat at the same absolute y in every case — regardless of the cue's
    // spacing or height — and reported ~19 rows "painted twice" that had
    // nothing to do with any background.  Measuring only where the background
    // actually is removes the whole class of false positive.
    x0 = region.x0; x1 = region.x1; y0 = region.y0; y1 = region.y1
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Darker than the source ⇒ background.  Text is white; it can only
        // lighten, so it never enters this set.
        if (px(x, y) < src - DARK_MARGIN) {
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
  }
  x0 = Math.max(0, x0); y0 = Math.max(0, y0)
  x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1)
  if (x1 < x0 || y1 - y0 + 1 < 3) return null
  // Per row: the 10th percentile of the pixels that are darker than the source.
  //
  // NOT the row minimum.  Chromium renders a handful of pixels around the line
  // boundary slightly darker than the source — measured 98 against a 128
  // backdrop, five pixels, and still there with the background canvas hidden,
  // so it is text rasterisation and nothing to do with this REQ.  A single such
  // pixel drags a row minimum from 51 to 39 (`51 × 98/128`) and the gate
  // reported ~17 phantom "painted twice" rows per case.
  //
  // A REAL doubled band covers the whole row — every background pixel in it is
  // darkened — so a low percentile still catches it while ignoring a few
  // outliers.  The 10th is well below any plausible stray count and well above
  // zero.
  const rows = []
  const width = x1 - x0 + 1
  for (let y = y0 + 1; y <= y1 - 1; y++) {
    const dark = []
    for (let x = x0; x <= x1; x++) {
      const v = px(x, y)
      if (v < src - DARK_MARGIN) dark.push(v)
    }
    // A gap row has essentially NO background on it.  It is not "fewer than
    // half": a row through the middle of the glyphs legitimately has few
    // background pixels, because the glyphs are white and so never counted as
    // dark.  Requiring a majority declared every text row a gap.
    // 15 %, not "a couple of pixels": a box EDGE contributes a handful of
    // antialiased pixels to an otherwise empty row, which was enough to stop a
    // real gap being recognised (the +40 control gaps by design and reported
    // none).  A row that genuinely carries background has it across most of its
    // width — glyphs cover part of it, never nearly all.
    if (dark.length < width * 0.15) { rows.push(src); continue }
    // The MODE of the row's background pixels.
    //
    // Neither the minimum nor a low percentile survives contact with Chromium's
    // text rasterisation: it leaves a soft dark blob (~17 px across, faint —
    // 98 against a 128 backdrop at its darkest) near the line boundary, present
    // even with the background canvas hidden.  That is enough pixels to own any
    // fixed rank.  The mode cannot be moved by it, because the background is by
    // far the most common value on the row — while a genuinely doubled band
    // moves the mode itself, since it darkens EVERY background pixel on the row.
    // No assumption about where the glyphs are, so it works for any alignment.
    const counts = new Map()
    let best = dark[0], bestN = 0
    for (const v of dark) {
      const k = Math.round(v)
      const n = (counts.get(k) ?? 0) + 1
      counts.set(k, n)
      if (n > bestN) { bestN = n; best = k }
    }
    rows.push(best)
  }
  return { rows, x0, x1, y0, y1, src }
}

/** Judge a region against the single-layer prediction. */
function judge(region, opacityPercent) {
  const expected = Math.round(region.src * (1 - opacityPercent / 100))
  const darker = region.rows.filter((v) => v < expected - LEVEL_TOL).length
  const gaps = region.rows.filter((v) => v >= region.src - 4).length
  const lighter = region.rows.filter((v) => v > expected + LEVEL_TOL && v < region.src - 4).length
  const worst = region.rows.reduce((a, v) => (Math.abs(v - expected) > Math.abs(a - expected) ? v : a), expected)
  return { darker, gaps, lighter, worst, expected, count: region.rows.length }
}

// --- Burn side ----------------------------------------------------------------

function burn(tag, ass) {
  const assPath = path.join(DIR, `${tag}.ass`)
  writeFileSync(assPath, ass, 'utf-8')
  const raw = path.join(DIR, `${tag}.rgb`)
  ff(['-f', 'lavfi', '-i', `color=c=0x808080:s=${VIDEO_W}x${VIDEO_H}:d=2`,
    '-vf', `subtitles='${esc(assPath)}':fontsdir='${esc(FONTS_DIR)}'`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], tag)
  return readFileSync(raw)
}

// --- Preview side -------------------------------------------------------------

const BG_MP4 = path.join(DIR, 'bg.mp4')
ff(['-f', 'lavfi', '-i', `color=c=0x808080:s=${VIDEO_W}x${VIDEO_H}:d=6:r=30`,
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', BG_MP4], 'bg')

let currentHtml = ''
const MIME = { '.js': 'text/javascript', '.html': 'text/html', '.ttf': 'font/ttf', '.mp4': 'video/mp4' }
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0]
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(currentHtml); return
  }
  const local = url === '/.bundle.js' ? BUNDLE
    : url === '/bg.mp4' ? BG_MP4
      : url.startsWith('/fonts/') ? path.join(REPO, 'resources', url.slice(1)) : null
  if (!local || !existsSync(local)) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': MIME[path.extname(local)] ?? 'application/octet-stream' })
  res.end(readFileSync(local))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const ORIGIN = `http://127.0.0.1:${server.address().port}`

const harnessHtml = (spec) => `<!doctype html><html><head><meta charset="utf-8">
<style>
@font-face{font-family:'${FONT_CSS_FAMILY}';src:url('/fonts/Noto_Sans_JP/static/NotoSansJP-SemiBold.ttf') format('truetype');font-weight:600;font-style:normal;}
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
<script>window.__spec=${JSON.stringify(spec)};window.__videoUrl='/bg.mp4'</script>
<script src="/.bundle.js"></script></body></html>`

/**
 * ★ THE NEGATIVE CONTROL, preview side.
 *
 * Restores the pre-REQ-0535 CSS on the LIVE component: the translucent
 * `background-color` back on the wrapper (which paints per line fragment and
 * composites each separately) and the canvas layer hidden.  Returns what it
 * touched so a shape change fails loudly instead of quietly proving nothing.
 */
async function applyPreFixCss(page, colorRgba) {
  return page.evaluate((rgba) => {
    const wrap = document.querySelector('[data-subtitle-text-wrapper]')
    const canvases = document.querySelectorAll('canvas')
    if (!wrap || canvases.length === 0) return { wrapped: 0, hidden: 0 }
    wrap.style.backgroundColor = rgba
    let hidden = 0
    for (const c of canvases) {
      if (c.width > 0 && c.height > 0) { c.style.display = 'none'; hidden++ }
    }
    return { wrapped: 1, hidden }
  }, colorRgba)
}

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    // Greyscale text antialiasing, so a glyph edge cannot fringe the channels
    // apart and read as a doubled background (see `backgroundRows`).
    '--disable-lcd-text',
    '--force-color-profile=srgb',
  ],
})
const page = await browser.newPage({ viewport: { width: PREVIEW_W + 40, height: PREVIEW_H + 80 } })

async function previewFrame(spec, preFix) {
  currentHtml = harnessHtml(spec)
  await page.goto(ORIGIN + '/')
  await page.waitForFunction('window.__ready === true', { timeout: 20000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(200)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.waitForTimeout(300)
  await page.waitForSelector('video', { timeout: 10000 })
  await page.evaluate(async () => {
    const v = document.querySelector('video')
    v.muted = true
    if (v.readyState < 2) await new Promise((res) => { v.onloadeddata = res; setTimeout(res, 6000) })
    v.pause()
  })
  const frame = await page.$('div[class*="bg-input"][class*="isolate"]')
  if (!frame) return { error: 'preview frame box not found' }
  const box = await frame.boundingBox()
  const w = Math.round(box.width), h = Math.round(box.height)

  // The cue's background region, straight from the element that DEFINES it.
  // Inset by 1 px so the box's own antialiased edge is not measured as a band.
  const region = await page.evaluate(({ fx, fy }) => {
    const wrap = document.querySelector('[data-subtitle-text-wrapper]')
    if (!wrap) return null
    const rs = [...wrap.getClientRects()]
    if (rs.length === 0) return null
    return {
      x0: Math.ceil(Math.min(...rs.map((r) => r.left)) - fx) + 1,
      x1: Math.floor(Math.max(...rs.map((r) => r.right)) - fx) - 1,
      y0: Math.ceil(Math.min(...rs.map((r) => r.top)) - fy) + 1,
      y1: Math.floor(Math.max(...rs.map((r) => r.bottom)) - fy) - 1,
    }
  }, { fx: box.x, fy: box.y })
  if (!region) return { error: 'no text wrapper to locate the background' }

  let touched = null
  if (preFix) {
    const rgba = spec.opacity / 100
    touched = await applyPreFixCss(page, `rgba(0, 0, 0, ${rgba})`)
    if (touched.wrapped === 0) return { error: 'control found no wrapper' }
    if (touched.hidden === 0) return { error: 'control hid no canvas — the background layer is gone?' }
    await page.waitForTimeout(120)
  }

  const png = path.join(DIR, 'p.png')
  await frame.screenshot({ path: png })
  const raw = path.join(DIR, 'p.rgb')
  ff(['-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], 'png')
  return { buf: readFileSync(raw), w, h, touched, region }
}

// --- Run ----------------------------------------------------------------------

console.log(`source grey ${SOURCE_GREY}; a layer at opacity p lands on ${SOURCE_GREY}*(1-p)\n`)

for (const spec of CASES) {
  const expected = Math.round(SOURCE_GREY * (1 - spec.opacity / 100))
  const twice = Math.round(SOURCE_GREY * (1 - spec.opacity / 100) ** 2)
  const tag = spec.name.replace(/[^a-z0-9]+/gi, '_')
  console.log(`\n--- ${spec.name}  (one layer = ${expected}, two = ${twice}) ---`)

  // ---- burn ----
  const fixed = backgroundRows(burn(tag, burnSide.renderAss(spec)), VIDEO_W, VIDEO_H)
  if (!fixed) { check(false, 'burn: a background was painted at all'); continue }
  check(fixed.rows.length >= MIN_REGION_ROWS,
    'burn: the region is a real multi-line band (not an empty set)',
    `rows=${fixed.rows.length}`)
  const fj = judge(fixed, spec.opacity)
  check(fj.darker === 0, 'burn: no row is painted twice', `darker=${fj.darker} worst=${fj.worst}`)
  check(fj.gaps === 0, 'burn: no gap between the lines', `gapRows=${fj.gaps}`)
  check(fj.lighter === 0, 'burn: every row is one full layer', `off=${fj.lighter} worst=${fj.worst}`)

  // ---- burn, negative control ----
  const ctl = backgroundRows(burn(`${tag}_ctl`, burnSide.renderAssPreFix(spec)), VIDEO_W, VIDEO_H)
  if (!ctl) {
    check(false, 'burn CONTROL: painted a background to compare against')
  } else {
    const cj = judge(ctl, spec.opacity)
    check(cj.darker > 0 || cj.gaps > 0,
      '★ burn NEGATIVE CONTROL: the pre-fix box really does fail this test',
      `darker=${cj.darker} gapRows=${cj.gaps} worst=${cj.worst}`)
  }

  // ---- preview ----
  const pv = await previewFrame(spec, false)
  if (pv.error) { check(false, `preview: ${pv.error}`); continue }
  const pfixed = backgroundRows(pv.buf, pv.w, pv.h, pv.region)
  if (!pfixed) { check(false, 'preview: a background was painted at all'); continue }
  check(pfixed.rows.length >= MIN_REGION_ROWS / 2,
    'preview: the region is a real multi-line band (not an empty set)',
    `rows=${pfixed.rows.length}`)
  const pj = judge(pfixed, spec.opacity)
  check(pj.darker === 0, 'preview: no row is painted twice', `darker=${pj.darker} worst=${pj.worst}`)
  check(pj.gaps === 0, 'preview: no gap between the lines', `gapRows=${pj.gaps}`)
  check(pj.lighter === 0, 'preview: every row is one full layer', `off=${pj.lighter} worst=${pj.worst}`)

  // ---- preview, negative control ----
  const pctl = await previewFrame(spec, true)
  if (pctl.error) {
    check(false, `preview CONTROL: ${pctl.error}`)
  } else {
    const pc = backgroundRows(pctl.buf, pctl.w, pctl.h, pctl.region)
    if (!pc) {
      check(false, 'preview CONTROL: painted a background to compare against')
    } else {
      const pcj = judge(pc, spec.opacity)
      check(pcj.darker > 0 || pcj.gaps > 0,
        '★ preview NEGATIVE CONTROL: the pre-fix CSS really does fail this test',
        `darker=${pcj.darker} gapRows=${pcj.gaps} worst=${pcj.worst}`)
    }
  }
}

await browser.close()
server.close()
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
try { rmSync(DUMP, { force: true }); rmSync(BUNDLE, { force: true }) } catch { /* best effort */ }

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
