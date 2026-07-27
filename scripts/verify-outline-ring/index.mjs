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
 *   2. Fonts are registered exactly as fonts.css does: ONE family, three
 *      @font-face rules at weights 400/500/600.  The old harness registered a
 *      single face and so never exercised canvas weight selection.
 *   3. Ground truth is collected INDEPENDENTLY of `measureRuns`, by walking the
 *      DOM's own line rects, so the harness cannot agree with a bug by
 *      construction.
' *   4. Structure is asserted before anything is measured.
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
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('@playwright/test')
const esbuild = require('esbuild')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const WORK = path.join(HERE, '.work')
const WEIGHTS = [
  ['Regular', 400],
  ['Medium', 500],
  ['SemiBold', 600],
]
/** Fail the run if any line drifts further than this from the DOM. */
const TOLERANCE_PX = 0.5

rmSync(WORK, { recursive: true, force: true })
mkdirSync(path.join(WORK, 'fonts'), { recursive: true })
for (const [face] of WEIGHTS) {
  copyFileSync(
    path.join(REPO, `resources/fonts/Noto_Sans_JP/static/NotoSansJP-${face}.ttf`),
    path.join(WORK, `fonts/NotoSansJP-${face}.ttf`),
  )
}

// Bundle the ring module for the page, and the fixtures for node.
esbuild.buildSync({
  entryPoints: [path.join(REPO, 'src/renderer/lib/outline-ring.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Ring',
  outfile: path.join(WORK, 'ring.js'),
})
esbuild.buildSync({
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
  outfile: path.join(WORK, 'fixtures.cjs'),
})
const { buildCases } = require(path.join(WORK, 'fixtures.cjs'))
const cases = buildCases()

const fontUrl = (face) =>
  'file:///' + path.join(WORK, `fonts/NotoSansJP-${face}.ttf`).replace(/\\/g, '/')
const faceRules = WEIGHTS.map(
  ([face, weight]) =>
    `@font-face{font-family:'MOJIOKO Noto Sans JP';font-weight:${weight};` +
    `src:url('${fontUrl(face)}') format('truetype');}`,
).join('\n ')

const page = (overlay) => `<!doctype html><meta charset="utf-8"><style>
 ${faceRules}
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
  return {
    runs: runs.length,
    truth: truth.length,
    deltas,
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

console.log('\n=== outline-ring harness — real component DOM, fonts.css face set ===')
console.log('case                          runs/lines   max|dx|  max|dy|  fonts  br   LF   sweep')
let worst = 0
let failures = 0
for (const c of cases) {
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
  if (countBad || driftBad) failures++
  console.log(
    c.name.padEnd(30) +
      `${r.runs}/${r.truth}`.padStart(10) +
      mdx.toFixed(2).padStart(10) +
      mdy.toFixed(2).padStart(9) +
      String(r.fonts).padStart(7) +
      String(r.hasBr)[0].padStart(4) +
      String(r.hasNewline)[0].padStart(5) +
      String(r.sweep)[0].padStart(7) +
      (countBad ? '   <-- run/line COUNT MISMATCH' : '') +
      (driftBad ? '   <-- DRIFT' : ''),
  )
}
await app.close()
rmSync(WORK, { recursive: true, force: true })

console.log(`\nworst |delta| across every case and line: ${worst.toFixed(3)}px`)
if (failures > 0) {
  console.error(`\nFAILED: ${failures} case(s) outside tolerance (${TOLERANCE_PX}px).`)
  process.exit(1)
}
console.log('OK — the ring sits on the glyphs in every case.')
