/**
 * REQ-0327 §2 — outline-ring PAINT gate.
 *
 *   npm run verify:ring-paint
 *
 * Exits non-zero when the painted ring is not where it should be.  This is a
 * gate, not a report: run it after any change to the ring paint path, the
 * overlay's transform composition, or the animation layer.
 *
 * ## What this covers that `verify:outline-ring` CANNOT
 *
 * The SSR gate renders fixtures with `renderToStaticMarkup`, so React's
 * `useLayoutEffect` never runs and **no ring is ever painted**.  It re-runs
 * `measureRuns` by hand and compares its numbers against the DOM — i.e. it
 * validates the INPUTS to the paint, in a page where no transform is ever
 * active.  Nothing downstream of `measureRuns` is exercised: not
 * `computeRingBox`, not `prepareCanvas`'s dpr handling, not `paintRing`'s
 * stroke-then-punch, and not the interaction between the canvas's untransformed
 * local space and a CSS transform on the shared parent.
 *
 * That gap let a real bug through (REQ-0326, fixed in f7b5364): when the ring's
 * layout effect re-ran while a `transform: scale()` was active, `measureRuns`
 * read `getBoundingClientRect()` — TRANSFORMED viewport coordinates — while the
 * canvas draws in the span's UNTRANSFORMED local space with an unscaled
 * `ctx.font`.  The ring landed up to ~16px out vertically.  The effect has no
 * dependency array and `video-preview-panel` re-renders the overlay from
 * `onTimeUpdate`, so it fires mid-animation in production.
 *
 * This gate paints the REAL `outline-ring.ts` into a REAL canvas inside a REAL
 * Electron window, captures the pixels, and measures where the ring sits
 * relative to the glyphs.  Both orders are covered:
 *
 *   paint-then-scale — the ordinary path (paint at 1, animation scales it).
 *   scale-then-paint — the REQ-0326 regression: scale first, then re-run the
 *                      effect.  This is the case that used to be ~16px out.
 *
 * Do not delete it as redundant with `verify:outline-ring`; they test disjoint
 * halves of the same feature.
 *
 * ## Negative control (how to prove the gate still works)
 *
 *   RING_PAINT_BREAK=rotation-only npm run verify:ring-paint   # pre-f7b5364
 *   RING_PAINT_BREAK=never         npm run verify:ring-paint   # no neutralisation
 *
 * Both MUST fail on the `scale-then-paint` rows.  If they pass, the gate has
 * stopped testing anything — fix it before trusting a green run.
 *
 * ## Method
 *
 * The ring is painted RED (#FF0000) on a BLACK stage under a WHITE fill, so the
 * two shapes separate cleanly in one capture:
 *   ink   = max(R,G,B)/255 — composite silhouette; its outer edge is the ring's.
 *   white = min(G,B)/255   — the fill alone.
 * Edges are read at the 0.5-coverage crossing with linear interpolation between
 * the bracketing samples, not as integer bbox extents — antialiasing biases a
 * soft edge inward by a few tenths of a pixel, and both the ring's outer edge
 * and the fill's edge carry that bias, so it largely cancels in `dx`/`dy` and
 * shows up only as a small constant deficit in thickness.  The fixtures use
 * `HEIT`, whose four extremes are all FLAT (H stem, cap line, baseline, T arm),
 * so every row/column along an edge agrees and the estimate is stable.
 *
 * ## Not covered (honest limits)
 *
 * - React itself: the effect body is PORTED into page.html, so commit ordering,
 *   ref timing and the dependency array are not exercised.  Keep the port in
 *   step with `subtitle-overlay.tsx` by hand.
 * - One font, one weight, one line, Latin only.  Multi-line, CJK, emphasis runs
 *   and per-run font changes are `verify:outline-ring`'s job.
 * - Rotation, shadow canvas, opacity, karaoke sweep.
 * - GPU rasterisation: hardware acceleration is disabled for determinism.
 */
import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, copyFileSync, existsSync, writeFileSync, readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const WORK = path.join(HERE, '.work')
const ELECTRON = path.join(REPO, 'node_modules/electron/dist/electron.exe')

/**
 * Ring drift tolerance, CSS px.  MEASURED, not guessed (REQ-0327 §2):
 *
 *   - Run-to-run spread over 3 repeats of all 20 shipped cases: 0.000px.
 *     Rasterisation here is fully deterministic, so there is no random noise
 *     to budget for.
 *   - The residual is SYSTEMATIC and phase-dependent.  Sweeping 26 scales
 *     (0.2 … 1.3) x 2 dpr x 2 outline widths, worst |dx| was 0.21px and worst
 *     |dy| was 0.56px.  |dy| does not scale with the outline width (bord 4 and
 *     bord 20 report the same figure at the same scale), so it is not the ring
 *     landing off the glyphs: it is the DOM's glyph rasteriser and the canvas's
 *     disagreeing by up to half a pixel vertically — the DOM grid-fits glyph
 *     outlines in y, `strokeText` traces the unfitted path.  Nothing this gate
 *     does can remove that; it is a property of comparing the two engines.
 *
 * So 0.5px — the SSR gate's tolerance — is NOT achievable against real
 * rasterised pixels; 0.56px was observed on a correct build.  0.75px is the
 * smallest value with meaningful headroom over that (~1.3x).
 *
 * Against the signal: the negative control puts the broken rows at |dy| =
 * 1.6, 2.4, 2.6, 9.1, 9.4, 10.3, 13.1, 13.4, 16.0, 16.2px.  The worst is ~21x
 * the tolerance; the SMALLEST (bord 4 at S=10%, where the whole cue is 9px
 * tall) is only ~2.1x it, so do not raise this number casually — the quietest
 * broken row is the one that would go first.
 */
const DRIFT_TOL_PX = 0.75
/**
 * Thickness tolerance, CSS px, against the expected `outlinePx * S`.
 *
 * Looser than drift on purpose: thickness is a DIFFERENCE of two soft edges, so
 * the antialiasing inward bias does not cancel the way it does in dx/dy.  Worst
 * deviation measured over the same 26-scale sweep: 0.7px (0.6px within the
 * shipped case set).  1.25px keeps ~2x headroom while still catching the
 * REQ-0326 signature, which crushes one side to a few px and inflates the
 * other (bord 20 at S=115%: 6/39 where 23/23 is correct).
 */
const THICK_TOL_PX = 1.25
/** Below this expected thickness the ring is sub-pixel and a 0.5 crossing is meaningless. */
const THICK_MIN_MEASURABLE_PX = 1.0

const BREAK = process.env.RING_PAINT_BREAK ?? 'always'
const REPEATS = Number(process.env.RING_PAINT_REPEATS ?? 1)
const DPRS = (process.env.RING_PAINT_DPR ?? '1,1.5').split(',').map(Number)

if (!existsSync(ELECTRON)) {
  console.error(`electron binary not found at ${ELECTRON} — run npm install`)
  process.exit(1)
}

rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })

// The REAL ring module, bundled for the page.  IIFE rather than ESM: a
// `type="module"` script is blocked at a `file://` origin.
esbuild.buildSync({
  entryPoints: [path.join(REPO, 'src/renderer/lib/outline-ring.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'Ring',
  outfile: path.join(WORK, 'ring.js')
})
copyFileSync(path.join(HERE, 'page.html'), path.join(WORK, 'page.html'))

// Production's default face.  Bundled, so it is always present.
const FONT_FILE = path.join(REPO, 'resources/fonts/Noto_Sans_JP/static/NotoSansJP-SemiBold.ttf')
if (!existsSync(FONT_FILE)) {
  console.error(`bundled font missing: ${FONT_FILE}`)
  process.exit(1)
}
const fontDest = path.join(WORK, 'face.ttf')
copyFileSync(FONT_FILE, fontDest)

const STAGE = { width: 800, height: 480 }
const BASE = {
  left: 240,
  top: 200,
  fontSizePx: 90,
  lineHeight: 1.2,
  fontFamily: 'MOJIOKO Noto Sans JP',
  fontWeight: 600,
  textColor: '#FFFFFF',
  ringColor: '#FF0000',
  // Four FLAT extremes: H's stem (left), cap line (top), baseline (bottom),
  // T's arm (right).  A round extreme would make the 0.5 crossing depend on a
  // single glyph pixel instead of a whole edge.
  text: 'HEIT',
  neutralise: BREAK,
  rotationDeg: 0
}
/**
 * `RING_PAINT_SCALES=0,0.25,0.4,...` widens the sweep.  Used to CALIBRATE the
 * tolerance: the residual below is phase-dependent (it comes from where the
 * scaled edges land on the pixel grid), so it has to be sampled over many
 * scales, not just the five the gate ships with.
 */
const SCALES = (process.env.RING_PAINT_SCALES ?? '0,0.1,0.5,1.0,1.15').split(',').map(Number)
const BORDS = [4, 20]
const ORDERS = ['paint-then-scale', 'scale-then-paint']

const cases = []
for (const order of ORDERS) {
  for (const outlinePx of BORDS) {
    for (const scale of SCALES) {
      cases.push({
        ...BASE,
        name: `${order === 'paint-then-scale' ? 'paint@1' : 'paint@S'} bord${String(outlinePx).padStart(2)} S=${String(Math.round(scale * 100)).padStart(3)}%`,
        order,
        outlinePx,
        scale
      })
    }
  }
}

console.log('\n=== ring-paint gate — real canvas paint, real pixels (REQ-0327 §2) ===')
if (BREAK !== 'always') {
  console.log(`!! NEGATIVE CONTROL: neutralise = '${BREAK}' (production is 'always')`)
}
console.log(
  `cases ${cases.length} x dpr [${DPRS.join(', ')}] x repeats ${REPEATS}` +
    `   tol: drift ${DRIFT_TOL_PX}px, thickness ${THICK_TOL_PX}px`
)

let failures = 0
let worstDrift = 0
let worstSpread = 0

for (const dpr of DPRS) {
  const jobPath = path.join(WORK, `job-${dpr}.json`)
  const outJson = path.join(WORK, `out-${dpr}.json`)
  writeFileSync(
    jobPath,
    JSON.stringify({
      dpr,
      stage: STAGE,
      workDir: WORK,
      repeats: REPEATS,
      show: process.env.RING_PAINT_SHOW === '1',
      setup: {
        fontUrl: 'file:///' + fontDest.replace(/\\/g, '/'),
        fontFamily: BASE.fontFamily,
        fontWeight: BASE.fontWeight
      },
      cases
    }),
    'utf8'
  )
  const run = spawnSync(ELECTRON, [path.join(HERE, 'electron-main.cjs'), jobPath, outJson], {
    encoding: 'utf8',
    timeout: 300_000
  })
  if (!existsSync(outJson)) {
    console.error(`electron produced no result for dpr ${dpr}`)
    console.error(run.stdout ?? '')
    console.error(run.stderr ?? '')
    process.exit(1)
  }
  const res = JSON.parse(readFileSync(outJson, 'utf8'))
  if (res.error) {
    console.error(`electron error at dpr ${dpr}: ${res.error}`)
    process.exit(1)
  }

  console.log(`\n--- dpr ${dpr} (page reported ${res.setup.dpr}) ---`)
  console.log(
    'case                       dx      dy   thick L/R/T/B (css px)      expect   spread   verdict'
  )
  for (const r of res.results) {
    const rows = r.reps.map((rep) => {
      const s = rep.devScale
      if (rep.maxInk < 0.02) return { empty: true }
      const g = (e) => ({
        l: e.left,
        r: e.right,
        t: e.top,
        b: e.bottom
      })
      const ink = g(rep.ink)
      const fill = g(rep.fill)
      return {
        empty: false,
        dx: ((ink.l + ink.r) / 2 - (fill.l + fill.r) / 2) / s,
        dy: ((ink.t + ink.b) / 2 - (fill.t + fill.b) / 2) / s,
        tl: (fill.l - ink.l) / s,
        tr: (ink.r - fill.r) / s,
        tt: (fill.t - ink.t) / s,
        tb: (ink.b - fill.b) / s
      }
    })
    const expect = r.spec.outlinePx * r.spec.scale
    const first = rows[0]
    const bad = []

    if (r.spec.scale === 0) {
      // Nothing must survive a zero scale — no ring left behind at the anchor.
      if (!first.empty) bad.push('INK AT S=0')
      console.log(
        r.name.padEnd(24) +
          (first.empty ? '   (blank — correct)' : '   INK PRESENT') +
          '   ' +
          (bad.length ? '<-- FAIL' : 'ok')
      )
      if (bad.length) failures++
      continue
    }
    if (first.empty) {
      console.log(r.name.padEnd(24) + '   NOTHING PAINTED   <-- FAIL')
      failures++
      continue
    }

    const spread = (k) => Math.max(...rows.map((x) => x[k])) - Math.min(...rows.map((x) => x[k]))
    const sp = Math.max(spread('dx'), spread('dy'))
    worstSpread = Math.max(worstSpread, sp)
    worstDrift = Math.max(worstDrift, Math.abs(first.dx), Math.abs(first.dy))

    if (!(Math.abs(first.dx) <= DRIFT_TOL_PX)) bad.push('dx')
    if (!(Math.abs(first.dy) <= DRIFT_TOL_PX)) bad.push('dy')
    if (expect >= THICK_MIN_MEASURABLE_PX) {
      for (const k of ['tl', 'tr', 'tt', 'tb']) {
        if (!(Math.abs(first[k] - expect) <= THICK_TOL_PX)) bad.push(k)
      }
    }
    if (bad.length) failures++
    const f = (v) => v.toFixed(2).padStart(6)
    console.log(
      r.name.padEnd(24) +
        f(first.dx) +
        f(first.dy) +
        '   ' +
        [first.tl, first.tr, first.tt, first.tb].map((v) => v.toFixed(1).padStart(5)).join(' ') +
        expect.toFixed(2).padStart(11) +
        sp.toFixed(2).padStart(9) +
        '   ' +
        (bad.length
          ? '<-- FAIL ' + bad.join(',')
          : expect < THICK_MIN_MEASURABLE_PX
            ? 'ok (thickness sub-pixel, not asserted)'
            : 'ok')
    )
  }
}

rmSync(WORK, { recursive: true, force: true })
console.log(
  `\nworst |drift| ${worstDrift.toFixed(2)}px` +
    (REPEATS > 1 ? `   worst repeat spread ${worstSpread.toFixed(3)}px` : '')
)
if (failures > 0) {
  console.error(`\nFAILED: ${failures} case(s) outside tolerance.`)
  process.exit(1)
}
if (BREAK !== 'always') {
  console.error(
    `\nFAILED: the negative control '${BREAK}' PASSED — the gate is not testing anything.`
  )
  process.exit(1)
}
console.log('OK — the painted ring sits on the glyphs at every scale, in both orders.')
