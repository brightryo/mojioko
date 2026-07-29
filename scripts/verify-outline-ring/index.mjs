/**
 * REQ-0317 §1 — outline-ring verification harness.
 *
 *   npm run verify:outline-ring
 *
 * Prints a dx/dy table for every layout case and exits non-zero if the ring
 * drifts off the glyphs.  Run it after ANY change that touches how the subtitle
 * preview lays out text — a new visual feature, a font change, a wrap change.
 *
 * ## Why this lives in scripts/ and not in the scratchpad
 *
 * CLAUDE.md §18 tells us to delete one-off verification scripts once their
 * result is recorded.  This is not one of those: it is a tool that has to be
 * re-run every time a visual feature lands.  Deleting it after REQ-0316 left
 * the project with no regression detector at all, which is exactly how
 * REQ-0313's flawed harness went unnoticed.  Same lesson the font
 * `varLib.instancer` script taught when it was left in an untracked build/ dir.
 *
 * ## What makes it faithful (and what made the old one useless)
 *
 *   1. Fixtures come from the REAL component (`fixtures.tsx`), never hand-written
 *      HTML.  REQ-0313's harness wrote `Hello<br>World`; production's plain path
 *      uses a real newline in ONE text node.  `<br>` splits text nodes, so the
 *      union-rect bug could not reproduce in the harness.
 *   2. Fonts are registered exactly as production does — one @font-face per
 *      FONT_REGISTRY entry, keyed by (cssFontFamily, weight).  REQ-0325 §3-1
 *      widened this from the three bundled Noto faces to every face the
 *      fixtures name, so all nine Noto weights, a single-weight control family
 *      and Montserrat are exercised rather than SemiBold alone.
 *   3. Ground truth is collected INDEPENDENTLY of `measureRuns`, by walking the
 *      DOM's own line rects, so the harness cannot agree with a bug by
 *      construction.
' *   4. Structure is asserted before anything is measured.
 *
 * ## Two independent measurements, two tolerances
 *
 * `dx`/`dy` (TOLERANCE_PX) catch ring DRIFT — the ring box landing off the
 * glyph box.  They cannot catch a font mismatch: `measureRuns` reads its `x`
 * and extents from DOM client rects and the ground truth walks those same
 * rects, so both sides move together regardless of which face the CANVAS
 * resolved.  The canvas font reaches the ring only via `run.font` (what
 * `strokeText` paints with) and via `baselineY` (scaled by the canvas
 * fontBoundingBox ratio).
 *
 * `dw` (WIDTH_TOLERANCE_PX) closes that hole: it replays each run through
 * `measureText` under that run's own computed `font` shorthand and compares
 * against the DOM rect width.  Two engines, one string — if they disagree
 * about the face (a weight the DOM synthesised but the shorthand did not
 * request, or a shorthand that dropped the weight), the advances separate.
 *
 * ## Diagnostics
 *
 * `RING_DEBUG=multiline,notosansjp-w900 npm run verify:outline-ring` dumps
 * per-run [text, DOM width, |dw|, font shorthand] for the named cases.
 *
 * ## Known limitation: zustand settings read their INITIAL value here
 *
 * Fixtures are server-rendered, and zustand feeds `useSyncExternalStore` its
 * `getInitialState()` as the server snapshot.  So `setState` before rendering
 * does NOT reach the component — verified with an unrelated field
 * (`activeFontId`), which also failed to change the output.  This is a property
 * of server rendering, not of any one setting.
 *
 * Consequence: a store-driven variant (e.g. karaoke `sweep`) can only be
 * exercised here by changing its DEFAULT.  The sweep path was measured that way
 * (dx/dy 0.00px, word boxes present); once sweep becomes the shipping default
 * it will be covered by the normal run.
 */
import { mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('@playwright/test')
const esbuild = require('esbuild')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const WORK = path.join(HERE, '.work')
/** Where the downloadable font set lands — same path `paths.ts` writes to. */
const USER_FONTS = path.join(process.env.APPDATA ?? '', 'MOJIOKO', 'fonts')
/** Fail the run if any line drifts further than this from the DOM. */
const TOLERANCE_PX = 0.5
/**
 * REQ-0325 §3-1 — separate tolerance for the DOM-vs-canvas advance check
 * (`dw`).  It is NOT the ring drift tolerance and must not be conflated with
 * it: `dw` compares two different measurement engines over the same text,
 * where `dx`/`dy` compare two readings of the same DOM rects.
 *
 * Calibration on this machine (Electron 30 / Chromium 124):
 *   - Baseline noise, every passing case: <= 0.02px, EXCEPT the fixtures
 *     containing 'もう一行あります', which sit at 0.68px.  That gap is
 *     content-specific (same value at every weight, and absent from the other
 *     CJK fixtures), i.e. a shaping difference between Chromium's DOM text
 *     layout and measureText — not a face mismatch.
 *   - Smallest signal we must still catch: one adjacent-weight slip on the
 *     weight fixtures, ~3px (w500 vs w600 on the MIXED string).
 * 1.0px sits above the noise floor and well under the smallest real signal.
 */
const WIDTH_TOLERANCE_PX = 1.0

rmSync(WORK, { recursive: true, force: true })
mkdirSync(path.join(WORK, 'fonts'), { recursive: true })

// Bundle the ring module for the page, and the fixtures for node.
esbuild.buildSync({
  entryPoints: [path.join(REPO, 'src/renderer/lib/outline-ring.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Ring',
  outfile: path.join(WORK, 'ring.js'),
})

/**
 * REQ-0325 §3-1 — swap two modules that are unreachable under server
 * rendering.  `useInstalledFontIds` is a useState+useEffect hook (effect never
 * runs → empty set) and `useAppEnvStore.isMsix` is null until an IPC that
 * never happens here.  Together they made `resolveRenderableFontId` collapse
 * EVERY fixture to `DEFAULT_FONT_ID`, so the gate silently measured Noto
 * SemiBold no matter which `fontId` a fixture asked for.  The stubs stand for
 * a real production state (paid build, font set downloaded); the tier policy
 * (`canSelectFontInTier`) and everything else is the real code.
 */
const stubPlugin = {
  name: 'harness-stubs',
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/use-installed-fonts$/ }, () => ({
      path: path.join(HERE, 'stubs/use-installed-fonts.ts'),
    }))
    build.onResolve({ filter: /^@\/stores\/app-env-store$/ }, () => ({
      path: path.join(HERE, 'stubs/app-env-store.ts'),
    }))
  },
}

// Async form: esbuild refuses plugins in the synchronous API.
await esbuild.build({
  entryPoints: [path.join(HERE, 'fixtures.tsx')],
  bundle: true,
  // CJS, not ESM: some transitive deps (lucide-react) ship CommonJS and
  // esbuild's ESM interop turns their require() into a throwing shim.
  format: 'cjs',
  platform: 'node',
  // Match the app's React 18 automatic runtime; the classic transform would
  // emit React.createElement into modules that never import React.
  jsx: 'automatic',
  // The renderer uses the '@/' alias from tsconfig.paths; esbuild needs it spelled out.
  alias: { '@': path.join(REPO, 'src/renderer') },
  plugins: [stubPlugin],
  outfile: path.join(WORK, 'fixtures.cjs'),
})
const { buildCases, requiredFaces } = require(path.join(WORK, 'fixtures.cjs'))
const cases = buildCases()

// Register every face the fixtures need, exactly as production does: one
// @font-face per registry entry, keyed by (cssFontFamily, weight).  Chromium
// only fetches a face it actually matches, so declaring all of them costs
// nothing per page.  A face whose TTF is absent on this machine (the font set
// was never downloaded) is dropped, and the cases needing it are SKIPPED
// rather than measured against a fallback face — a green row for the wrong
// font would be worse than no row at all.
const missingFonts = new Set()
const faceRules = []
for (const f of requiredFaces()) {
  const src = f.bundledRelativeDir
    ? path.join(REPO, 'resources/fonts', f.bundledRelativeDir, f.fileName)
    : path.join(USER_FONTS, f.id, f.fileName)
  if (!existsSync(src)) {
    missingFonts.add(f.id)
    continue
  }
  const dest = path.join(WORK, 'fonts', `${f.id}.ttf`)
  copyFileSync(src, dest)
  faceRules.push(
    `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};` +
      `src:url('file:///${dest.replace(/\\/g, '/')}') format('truetype');}`,
  )
}
const faceRulesCss = faceRules.join('\n ')

const page = (overlay) => `<!doctype html><meta charset="utf-8"><style>
 ${faceRulesCss}
 html,body{margin:0;padding:0}
 #stage{position:relative;width:641px;height:361px;background:#000;overflow:hidden}
 .absolute{position:absolute}.pointer-events-none{pointer-events:none}
</style><div id="stage">${overlay}</div>
<script src="ring.js"></script>
<script>
window.__run = (async () => {
  await document.fonts.ready
  const outer = document.querySelector('#stage > span')
  if (!outer) return { error: 'no overlay span' }
  const wrap = outer.querySelector('[data-subtitle-text-wrapper]')
  if (!wrap) return { error: 'no text wrapper' }
  const canvases = outer.querySelectorAll('canvas')
  if (canvases.length !== 2) return { error: 'expected 2 canvases, got ' + canvases.length }
  const mctx = document.createElement('canvas').getContext('2d')

  // Same rotation neutralisation the overlay's layout effect performs.
  const prev = outer.style.transform
  const rotated = /rotate\\(/.test(prev)
  if (rotated) outer.style.transform = 'none'
  const o = outer.getBoundingClientRect()
  const { runs, extents } = Ring.measureRuns(wrap, o.left, o.top, mctx)

  // GROUND TRUTH, independent of measureRuns: every line rect of every text
  // node in the wrapper, in document order.  Zero-width rects (the newline
  // itself reports one) are dropped.
  const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT)
  const truth = []
  const rr = document.createRange()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue || n.nodeValue.trim().length === 0) continue
    rr.selectNodeContents(n)
    for (const c of rr.getClientRects()) {
      if (c.width > 0.01) truth.push({ left: c.left - o.left, top: c.top - o.top })
    }
  }
  if (rotated) outer.style.transform = prev

  const deltas = []
  for (let i = 0; i < Math.min(runs.length, truth.length); i++) {
    deltas.push({ dx: runs[i].x - truth[i].left, dy: extents[i].top - truth[i].top })
  }

  // REQ-0325 §3-1 — DOM vs CANVAS face agreement.
  //
  // dx/dy above cannot see a weight mismatch.  measureRuns takes its x and its
  // extents from DOM client rects, and the ground truth walks the same rects,
  // so both sides move together no matter which face the CANVAS resolved.  The
  // canvas font only enters the ring through run.font (what strokeText paints
  // with) and through baselineY (derived from fontBoundingBoxAscent/Descent).
  //
  // This measures the one thing that does diverge: replay each run's text
  // through measureText under that run's own computed font shorthand, and
  // compare against the DOM rect width.  If the DOM synthesised a weight the
  // canvas shorthand does not request — or the shorthand dropped the weight —
  // the two resolve different faces and the advances separate.
  const widthDeltas = []
  for (let i = 0; i < runs.length; i++) {
    mctx.font = runs[i].font
    widthDeltas.push(Math.abs(mctx.measureText(runs[i].text).width - extents[i].width))
  }
  // What face the DOM actually settled on.  Without this the run cannot prove
  // that a notosansjp-w100 fixture really rendered Thin rather than silently
  // falling back to the bundled SemiBold.
  const cs = getComputedStyle(wrap)
  return {
    runs: runs.length,
    truth: truth.length,
    deltas,
    dw: widthDeltas.length ? Math.max(...widthDeltas) : 0,
    DEBUG: runs.map((r,i)=>[r.text, Math.round(extents[i].width*1000)/1000, Math.round(widthDeltas[i]*1000)/1000, r.font]),
    face: cs.fontFamily.replace(/["']/g, '').split(',')[0] + ' ' + cs.fontWeight,
    // Rendered advance width.  Evidence that a weight fixture actually
    // matched a DIFFERENT face: if w100 and w900 report the same width, the
    // browser resolved both to the same TTF and the row proves nothing.
    w: Math.round(wrap.getBoundingClientRect().width * 100) / 100,
    fonts: [...new Set(runs.map((r) => r.font))].length,
    hasBr: wrap.innerHTML.includes('<br'),
    hasNewline: wrap.textContent.includes(String.fromCharCode(10)),
    sweep: wrap.innerHTML.includes('data-karaoke-word-box'),
  }
})()
</script>`

const app = await electron.launch({
  args: [path.join(REPO, 'out/main/index.js')],
  timeout: 30_000,
})
const win = await app.firstWindow()

console.log('\n=== outline-ring harness — real component DOM, registry face set ===')
console.log(`registered faces: ${faceRules.length}` +
  (missingFonts.size ? `   NOT ON DISK: ${[...missingFonts].join(', ')}` : ''))
console.log(
  'case                          runs/lines   max|dx|  max|dy|  max|dw|  fonts  br   LF   sweep     width  face',
)
const DEBUG_CASES = new Set((process.env.RING_DEBUG ?? '').split(',').filter(Boolean))
let worst = 0
let failures = 0
let skipped = 0
for (const c of cases) {
  if (c.fontId && missingFonts.has(c.fontId)) {
    console.log(c.name.padEnd(30) + `  SKIPPED — ${c.fontId} not installed on this machine`)
    skipped++
    continue
  }
  writeFileSync(path.join(WORK, 'p.html'), page(c.html), 'utf8')
  await win.goto('file:///' + path.join(WORK, 'p.html').replace(/\\/g, '/'))
  const r = await win.evaluate(() => window.__run)
  if (r.error) {
    console.log(c.name.padEnd(30) + '  ERROR: ' + r.error)
    failures++
    continue
  }
  const dxs = r.deltas.map((d) => Math.abs(d.dx))
  const dys = r.deltas.map((d) => Math.abs(d.dy))
  const mdx = dxs.length ? Math.max(...dxs) : NaN
  const mdy = dys.length ? Math.max(...dys) : NaN
  worst = Math.max(worst, mdx || 0, mdy || 0)
  const countBad = r.runs !== r.truth
  const driftBad = !(mdx <= TOLERANCE_PX) || !(mdy <= TOLERANCE_PX)
  const faceBad = !(r.dw <= WIDTH_TOLERANCE_PX)
  if (countBad || driftBad || faceBad) failures++
  console.log(
    c.name.padEnd(30) +
      `${r.runs}/${r.truth}`.padStart(10) +
      mdx.toFixed(2).padStart(10) +
      mdy.toFixed(2).padStart(9) +
      r.dw.toFixed(2).padStart(9) +
      String(r.fonts).padStart(7) +
      String(r.hasBr)[0].padStart(4) +
      String(r.hasNewline)[0].padStart(5) +
      String(r.sweep)[0].padStart(7) +
      String(r.w).padStart(10) +
      '  ' + String(r.face) +
      (countBad ? '   <-- run/line COUNT MISMATCH' : '') +
      (driftBad ? '   <-- DRIFT' : '') +
      (faceBad ? '   <-- DOM/CANVAS FACE MISMATCH' : ''),
  )
  if (DEBUG_CASES.has(c.name)) console.log('   DEBUG ' + JSON.stringify(r.DEBUG))
}
await app.close()
rmSync(WORK, { recursive: true, force: true })

console.log(`\nworst |delta| across every case and line: ${worst.toFixed(3)}px`)
if (skipped > 0) {
  console.log(`${skipped} case(s) skipped — font not installed on this machine.`)
}
if (failures > 0) {
  console.error(
    `\nFAILED: ${failures} case(s) outside tolerance ` +
      `(drift ${TOLERANCE_PX}px / face ${WIDTH_TOLERANCE_PX}px).`,
  )
  process.exit(1)
}
console.log('OK — the ring sits on the glyphs in every case.')
