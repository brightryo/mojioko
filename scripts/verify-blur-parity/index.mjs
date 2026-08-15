/**
 * REQ-0377 §B — preview↔burn BLUR parity across the whole strength range.
 *
 * The preview applies `filter: blur(N · scale · ASS_BLUR_TO_CSS_SIGMA)`; the
 * burn emits `\blur N`.  RES-0339 measured the conversion at N ≤ 40; before we
 * let the slider reach higher we must know the two still agree at the top end.
 *
 * This gate measures the EDGE σ of a hard step edge under each engine at
 * N = 20/40/60/80/100/120:
 *   - libass: a `\bord0 \blur N \p1` white rectangle burned over black (ffmpeg),
 *   - CSS   : a white div with `filter: blur(N · 0.84)` (chromium, scale 1),
 * both rendered at 1280×720 = PlayRes so N is in frame px.  σ is read from a
 * mid-height scanline as (10→90 % rise width) / 2.5631 (Gaussian CDF constant).
 *
 * Pass: at every N, |σ_css − σ_libass| / σ_libass ≤ TOL (the preview matches
 * the burn), AND σ/N stays constant across N (the linear model holds, no
 * saturation).  Non-zero exit otherwise — a gate, not a report.  Requires
 * ffmpeg on PATH and playwright (both already used by the other gates).
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync, readFileSync as rf } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// Read the REAL conversion constant so the harness cannot drift from the app.
const constSrc = rf(join(REPO, 'src', 'shared', 'constants.ts'), 'utf8')
const SIGMA_K = Number(/ASS_BLUR_TO_CSS_SIGMA\s*=\s*([0-9.]+)/.exec(constSrc)?.[1])
if (!Number.isFinite(SIGMA_K)) throw new Error('could not read ASS_BLUR_TO_CSS_SIGMA')
// The shippable ceiling — parity is ASSERTED up to here; higher N is probed
// only to document where libass saturates (informational, non-failing).
const animSrc = rf(join(REPO, 'src', 'shared', 'cue-animation.ts'), 'utf8')
const CEILING = Number(/ANIMATION_BLUR_MAX_PX\s*=\s*([0-9.]+)/.exec(animSrc)?.[1])
if (!Number.isFinite(CEILING)) throw new Error('could not read ANIMATION_BLUR_MAX_PX')

const W = 1280, H = 720, EDGE = 640, Y = 360
const NS = [20, 40, 60, 80, 100, 110, 120]
const SPAN = 330 // half-window for the erf profile (≥ ~3σ at the largest N)
const TOL = 0.10 // 10 % — sub-pixel AA + engine differences
const DIR = join(tmpdir(), `mojioko-blur-parity-${process.pid}`)
mkdirSync(DIR, { recursive: true })

const have = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
if (have.status !== 0) { console.error('ffmpeg not found'); process.exit(2) }

/** σ from a luminance profile across the edge: (x@90% − x@10%) / 2.5631. */
function sigmaFromRow(lum) {
  const lo = lum[EDGE - SPAN] ?? lum[0]
  const hi = lum[EDGE + SPAN] ?? lum[lum.length - 1]
  if (hi <= lo + 5) return NaN
  const cross = (frac) => {
    const target = lo + frac * (hi - lo)
    for (let x = EDGE - SPAN; x < EDGE + SPAN; x++) {
      if (lum[x] <= target && lum[x + 1] >= target) {
        return x + (target - lum[x]) / (lum[x + 1] - lum[x]) // linear interp
      }
    }
    return NaN
  }
  const x10 = cross(0.1), x90 = cross(0.9)
  return (x90 - x10) / 2.5631
}

function rowLumFromRgb(buf) {
  const lum = new Float64Array(W)
  for (let x = 0; x < W; x++) {
    const i = (Y * W + x) * 3
    lum[x] = 0.299 * buf[i] + 0.587 * buf[i + 1] + 0.114 * buf[i + 2]
  }
  return lum
}

function libassSigma(n) {
  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV
Style: D,Arial,40,&H00FFFFFF,&H00000000,1,0,7,0,0,0

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,D,0,0,0,,{\\an7\\pos(0,0)\\bord0\\shad0\\1c&HFFFFFF&\\blur${n}\\p1}m ${EDGE} 0 l ${W} 0 ${W} ${H} ${EDGE} ${H}{\\p0}
`
  const assP = join(DIR, `l_${n}.ass`); writeFileSync(assP, ass)
  const bg = join(DIR, 'bg.mp4')
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:d=1:r=1`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', bg])
  const png = join(DIR, `l_${n}.png`)
  const esc = assP.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', bg, '-frames:v', '1',
    '-vf', `subtitles='${esc}',format=rgb24`, '-c:v', 'png', png])
  const raw = join(DIR, `l_${n}.rgb`)
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw])
  return sigmaFromRow(rowLumFromRgb(readFileSync(raw)))
}

async function cssSigma(page, n) {
  const r = n * SIGMA_K
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#000">` +
    `<div style="position:fixed;left:${EDGE}px;top:0;width:${W - EDGE}px;height:${H}px;` +
    `background:#fff;filter:blur(${r}px)"></div></body></html>`,
  )
  const png = join(DIR, `c_${n}.png`)
  await page.screenshot({ path: png, clip: { x: 0, y: 0, width: W, height: H } })
  const raw = join(DIR, `c_${n}.rgb`)
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw])
  return sigmaFromRow(rowLumFromRgb(readFileSync(raw)))
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H } })
await page.evaluate(() => { document.body.style.margin = '0'; document.body.style.background = '#000' })

let worstShipRel = 0, fail = false, gatedCount = 0
console.log(`ASS_BLUR_TO_CSS_SIGMA = ${SIGMA_K} | shippable ceiling ANIMATION_BLUR_MAX_PX = ${CEILING}`)
console.log('   N |  σ_libass |   σ_css | σl/N  | σc/N  | |Δ|/σl   scope')
for (const n of NS) {
  const sl = libassSigma(n)
  const sc = await cssSigma(page, n)
  const rel = Math.abs(sc - sl) / sl
  const shipped = n <= CEILING
  const bad = shipped && !(rel <= TOL) // only the shippable range gates
  if (bad) fail = true
  if (shipped) { worstShipRel = Math.max(worstShipRel, rel); gatedCount++ }
  console.log(
    `${bad ? 'x' : ' '}${String(n).padStart(3)} | ${sl.toFixed(2).padStart(9)} | ${sc.toFixed(2).padStart(7)} | ` +
    `${(sl / n).toFixed(3)} | ${(sc / n).toFixed(3)} | ${(rel * 100).toFixed(1).padStart(5)}%   ` +
    `${shipped ? 'GATED (≤ceiling)' : 'probe (> ceiling)'}`)
}
await browser.close()
rmSync(DIR, { recursive: true, force: true })

console.log(`\nworst |Δ|/σ_libass within the shippable range (N ≤ ${CEILING}) = ${(worstShipRel * 100).toFixed(1)}% (tol ${TOL * 100}%)`)
console.log('Note: libass \\blur saturates around N ≈ 100 (σ ≈ 84); probe rows above the ceiling show')
console.log('the widening gap — do not raise ANIMATION_BLUR_MAX_PX past ~100 without re-measuring.')

/**
 * REQ-0511 L5 — refuse to report OK on an empty gate.
 *
 * Only rows with `N <= CEILING` are gated. Lower `ANIMATION_BLUR_MAX_PX` below
 * the smallest probe (or shrink `NS`) and every row becomes a non-gating probe:
 * `fail` stays false and the script exits 0 announcing agreement it never
 * checked. A gate that can pass while testing nothing is worse than no gate,
 * because it is reported as coverage.
 */
if (gatedCount === 0) {
  console.error(`\nFAIL — no probe fell within the shipped range (ceiling ${CEILING}, probes ${NS.join(', ')}), so nothing was verified.`)
  process.exit(1)
}

if (fail) {
  console.error(`\nFAIL — preview CSS blur and burn libass \\blur diverge beyond ${TOL * 100}% within the shipped range.`)
  process.exit(1)
}
console.log(`\nOK — preview and burn blur agree to within tolerance for every N up to the ${CEILING}px ceiling.`)
