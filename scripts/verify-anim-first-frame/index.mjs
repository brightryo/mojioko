/**
 * REQ-0379 — REAL-PIXEL gate for the entrance-animation first-frame flash.
 *
 * Renders the REAL `VideoPreviewPanel` in headless chromium, injects a real
 * <video>, plays through a cue's start, and samples the overlay's COMPUTED
 * opacity (the pixel-determining quantity for this bug) every animation frame.
 * The flash is: the overlay's FIRST present frame painted at settled opacity
 * (~1) before the animation's initial (~0) — logic tests could not see it.
 *
 * Pass: for every entrance type, the first present frame's opacity is LOW
 * (animation initial), not ~1.  A negative control — the same harness with the
 * pre-REQ-0379 rule swapped back into `resolveCueAnimState`, see
 * `pre-fix-cue-animation.ts` — proves the sampler detects the flash.  Requires
 * playwright + esbuild (already deps); touches git not at all.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const { chromium } = require('playwright')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const OUT = path.join(HERE, '.bundle.js')
const HTML = path.join(HERE, '.harness.html')
const VIDEO_DATA = 'data:video/mp4;base64,' + readFileSync(path.join(HERE, 'testvid.mp4')).toString('base64')
const START = 2.0

const TYPES = ['blur', 'fade', 'scale', 'pop']
const FLASH_OPACITY = 0.5 // first-present opacity above this = settled flash

const PRE_FIX_ANIM = path.join(HERE, 'pre-fix-cue-animation.ts')

/**
 * Bundle the harness.  `preFix` swaps the ONE decision under test
 * (`resolveCueAnimState`) for its pre-REQ-0379 form — see
 * `pre-fix-cue-animation.ts` for why the control is a perturbation rather than
 * a `git checkout` of the historical sources.  Everything else in both bundles
 * is the real production code.
 *
 * The swap is an onResolve plugin, not an `alias`: `cue-animation` is imported
 * by several files at several relative depths, and an alias matches the
 * specifier STRING, so it would catch some importers and miss others.
 */
async function bundle(preFix = false) {
  const swapAnimation = {
    name: 'pre-fix-cue-animation',
    setup(build) {
      build.onResolve({ filter: /(^|[\\/])cue-animation$/ }, (args) => {
        // The shim itself imports the real module by absolute path, so it is
        // not caught here and there is no cycle.
        if (args.importer === PRE_FIX_ANIM) return null
        return { path: PRE_FIX_ANIM }
      })
    },
  }
  await esbuild.build({
    entryPoints: [path.join(HERE, 'harness-entry.tsx')],
    bundle: true,
    outfile: OUT,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.css': 'empty', '.png': 'empty', '.svg': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
    alias: {
      '@': path.join(REPO, 'src/renderer'),
      'react-i18next': path.join(HERE, 'react-i18next-stub.ts'),
    },
    plugins: preFix ? [swapAnimation] : [],
    logLevel: 'silent',
  })
}

async function measure(page, animType) {
  writeFileSync(
    HTML,
    `<!doctype html><html><head><meta charset="utf-8">
     <style>html,body{margin:0;background:#000}#root{width:640px;height:560px}
     /* minimal Tailwind layout shim — the real CSS is emptied at bundle time,
        so re-provide only the utilities the panel's flex height chain and the
        overlay positioning need (REQ-0379 harness). */
     .flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1 1 0%}
     .h-full{height:100%}.w-full{width:100%}.min-h-0{min-height:0}
     .items-center{align-items:center}.justify-center{justify-content:center}
     .relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}
     .overflow-hidden{overflow:hidden}.flex-shrink-0{flex-shrink:0}
     /* force the preview body (identified by bg-surface-0) to a real height so
        the panel's ResizeObserver measures a non-zero box and mounts <video>. */
     [class*="bg-surface-0"]{min-height:440px !important;width:640px}
     video{width:100%;height:100%;object-fit:contain}</style></head>
     <body><div id="root"></div>
     <script>window.__animType=${JSON.stringify(animType)}</script>
     <script src="./.bundle.js"></script></body></html>`,
  )
  await page.goto('file://' + HTML.replace(/\\/g, '/'))
  await page.waitForFunction('window.__ready === true', { timeout: 15000 })
  await page.waitForTimeout(300)
  await page.evaluate(() => window.dispatchEvent(new Event('resize')))
  await page.waitForTimeout(300)
  try {
    await page.waitForSelector('video', { timeout: 8000 })
  } catch {
    const diag = await page.evaluate(() => {
      const r = (el) => el ? `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}` : 'null'
      const flex1 = document.querySelector('[class*="bg-surface-0"]')
      return {
        videoCount: document.querySelectorAll('video').length,
        bgInput: document.querySelectorAll('[class*="bg-input"]').length,
        previewBody: r(flex1),
        clientHW: flex1 ? `${flex1.clientWidth}x${flex1.clientHeight}` : 'null',
      }
    })
    return { error: `no <video> (count=${diag.videoCount}) bgInput(container)=${diag.bgInput} previewBody(rect)=${diag.previewBody} clientHW=${diag.clientHW}` }
  }

  const timeline = await page.evaluate(async ({ dataUrl, start }) => {
    const v = document.querySelector('video')
    if (!v) return { error: 'no <video> element rendered' }
    v.muted = true
    v.src = dataUrl
    v.load()
    await new Promise((res) => { v.onloadeddata = res; setTimeout(res, 4000) })

    // Selector for the overlay's OUTER positioned span (holds the animation
    // opacity).  It is the position:absolute span containing the cue text.
    const findOverlay = () => {
      for (const s of document.querySelectorAll('span')) {
        if (s.textContent && s.textContent.replace(/\s/g, '').includes('ANIMATIONTEST') &&
            getComputedStyle(s).position === 'absolute') return s
      }
      return null
    }

    // Owner scenario: seek the PAUSED preview to the cue's start via the panel's
    // OWN seek-request path (= clicking a subtitle row), which shows the cue's
    // settled editing view, THEN press play.  The reported flash is a settled
    // frame surviving into playback before the animation takes over.
    v.pause()
    // eslint-disable-next-line no-undef
    window.__ui.setState({ videoSeekRequestSec: start })
    await new Promise((res) => setTimeout(res, 900))
    const pausedEl = findOverlay()
    const pausedOpacity = pausedEl ? Number(getComputedStyle(pausedEl).opacity) : null

    const samples = []
    await v.play().catch(() => {})
    await new Promise((resolve) => {
      const tick = () => {
        const el = findOverlay()
        samples.push({
          t: v.currentTime,
          paused: v.paused,
          present: !!el,
          opacity: el ? Number(getComputedStyle(el).opacity) : null,
        })
        if (v.currentTime > start + 0.5 || samples.length > 400) { v.pause(); resolve(null) }
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    return { samples, pausedOpacity }
  }, { dataUrl: VIDEO_DATA, start: START })

  return timeline
}

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
const page = await browser.newPage({ viewport: { width: 700, height: 620 } })
// Rewrite the panel's `mojioko-media://` <video> src to the real test clip
// BEFORE it loads, so the video plays instead of erroring into `hasError`
// (which unmounts the <video> and the overlay with it).
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
page.on('console', (m) => { if (m.type() === 'error') console.error('  [console.error]', m.text().split('\n')[0].slice(0, 200)) })

async function runAll(label, preFix = false) {
  await bundle(preFix)
  const results = {}
  for (const animType of TYPES) {
    const r = await measure(page, animType)
    if (r.error) { console.log(`  ${label} ${animType}: ERROR ${r.error}`); results[animType] = null; continue }
    // The metric: with the playhead paused AT an animated cue's start, the
    // overlay's opacity.  Settled (~1) = the flash the owner sees; animation
    // initial (~0) = decision B (no settled frame in front of the entrance).
    const early = r.samples.filter((s) => s.present && !s.paused && s.t > START && s.t <= START + 0.15)
    const maxEarlyPlay = early.length ? Math.max(...early.map((s) => s.opacity)) : null
    results[animType] = r.pausedOpacity
    console.log(`  ${label} ${animType.padEnd(6)}: paused-at-start opacity=${r.pausedOpacity == null ? 'n/a' : r.pausedOpacity.toFixed(3)}  (max early-play=${maxEarlyPlay == null ? 'n/a' : maxEarlyPlay.toFixed(2)})`)
  }
  return results
}

console.log('=== current HEAD (with fix) ===')
const head = await runAll('HEAD')

// Negative control — re-run the WHOLE harness with the pre-REQ-0379 rule
// swapped back into `resolveCueAnimState`, and confirm the SAME sampler
// detects the settled flash.  A pass on HEAD means nothing without this.
//
// ★ REQ-0514 — this used to `git checkout` the four pre-fix source files and
// bundle them, then `git checkout HEAD --` them back.  Both halves were wrong.
// Bundling historical sources against a CURRENT tree rots on any refactor
// elsewhere (REQ-0508 moved `font-tier`, REQ-0466 dropped an `active-entry`
// export — by REQ-0514 the historical bundle could not be built at all, and
// this gate had been dying on that, unnoticed, ever since).  And the restore
// discarded uncommitted work in those four files, which is how it was found.
// `pre-fix-cue-animation.ts` documents the perturbation and why it is the
// right size.
console.log('\n=== negative control (pre-REQ-0379 resolveCueAnimState) ===')
const neg = await runAll('PRE ', true)

await browser.close()

// Verdict — with the fix (decision B) the paused-at-start view of an animated
// cue is the entrance INITIAL (low opacity), not settled (~1).  The negative
// control (pre-fix) must show the settled ~1, proving the sampler detects it.
console.log('\n=== verdict ===')
let fail = false, negProved = true
for (const t of TYPES) {
  const h = head[t], n = neg[t]
  const headSettled = h != null && h > FLASH_OPACITY
  const negSettled = n != null && n > FLASH_OPACITY
  console.log(`  ${t.padEnd(6)}: HEAD paused-at-start=${h == null ? 'n/a' : h.toFixed(3)} ${headSettled ? 'SETTLED✗' : 'anim-initial ok'} | pre-fix=${n == null ? 'n/a' : n.toFixed(3)} ${negSettled ? 'settled(detected)' : 'NOT-settled?'}`)
  if (headSettled) fail = true
  if (!negSettled) negProved = false
}
if (!negProved) {
  console.error('\nFAIL — the negative control did NOT show the pre-fix settled view, so the sampler is not proving anything.')
  process.exit(1)
}
if (fail) {
  console.error('\nFAIL — a paused animated cue still shows the settled view (~1) on HEAD instead of the entrance initial.')
  process.exit(1)
}
console.log('\nOK — paused-at-start of an animated cue shows the entrance initial (decision B); pre-fix showed the settled flash.')
