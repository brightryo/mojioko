/**
 * REQ-0391 (positioning-redesign Phase 1b) — REAL-MP4 WYSIWYG overlap + z-order
 * gate (repurposed from REQ-0380's auto-stack gate, whose premise inverted).
 *
 * All-\pos means MOJIOKO positions every cue itself with NO auto-stacking, so:
 *   1. three time-overlapping SAME-position cues OVERLAP in the burn (their ink
 *      bands coincide, vertical spread ≈ 0) — matching the preview — instead of
 *      being spread apart by libass' fix_collisions; and
 *   2. the later-emitted of two identical overlapping cues paints ON TOP
 *      (Dialogue order = z-order), so the visible colour is the front cue's.
 *
 * Negative control (no git checkout): the historical MarginV path
 * (`forceSelfPositionAll = false`) still auto-stacks case 1 (spread ≫ 0) and
 * shows BOTH colours in case 2 — proving the gate distinguishes the two models.
 *
 * Exit 0 = pass, 1 = a parity failure / control didn't fire, 2 = no ffmpeg.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const OUT = path.join(HERE, '.dump.cjs')
const DIR = path.join(tmpdir(), `mojioko-overlap-${process.pid}`)
mkdirSync(DIR, { recursive: true })

if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('ffmpeg not found'); process.exit(2)
}
esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: OUT, format: 'cjs', platform: 'node',
  loader: { '.css': 'empty', '.png': 'empty' }, alias: {
    '@': path.join(REPO, 'src/renderer'),
    // REQ-0537 — `ass-generator` now imports `main/lib/paths` statically, which
    // imports electron; the npm shim throws when bundled for plain node.
    electron: path.join(REPO, 'scripts/electron-stub.ts'),
  },
  logLevel: 'silent',
})
const { buildOverlapAss, buildZOrderAss, buildLayerOverrideAss } = require(OUT)

const STACK_MIN = 40 // reference (stacked) vertical spread must be at least this
const OVERLAP_MAX = 12 // all-\pos overlap: the three bands must coincide within this

let bgMade = false
/** Burn an ASS string at t=3.5 (all cues active) → raw rgb24 buffer. */
function burn(ass, W, H, tag) {
  const bg = path.join(DIR, 'bg.mp4')
  if (!bgMade) {
    spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
      `color=c=black:s=${W}x${H}:d=6:r=30`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', bg])
    bgMade = true
  }
  const assPath = path.join(DIR, `${tag}.ass`)
  writeFileSync(assPath, ass)
  const esc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  const raw = path.join(DIR, `${tag}.rgb`)
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', bg, '-ss', '3.5', '-frames:v', '1',
    '-vf', `format=rgb24,subtitles='${esc}':fontsdir='${esc}'`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw])
  return { buf: readFileSync(raw), W, H }
}

const CHANS = { R: [0, 1, 2], G: [1, 0, 2], B: [2, 0, 1] } // [strong, weak, weak]

/** Vertical ink band (top/bottom/mid rows) for each of R/G/B. */
function bands({ buf, W, H }) {
  const out = []
  for (const [color, [s, w1, w2]] of Object.entries(CHANS)) {
    let top = Infinity, bot = -1
    for (let y = 0; y < H; y++) {
      let hit = false
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3
        if (buf[i + s] > 140 && buf[i + w1] < 110 && buf[i + w2] < 110) { hit = true; break }
      }
      if (hit) { top = Math.min(top, y); bot = Math.max(bot, y) }
    }
    out.push({ color, mid: bot < 0 ? null : Math.round((top + bot) / 2) })
  }
  return out
}

/** Count strongly-coloured pixels for one channel. */
function pixelCount({ buf }, color) {
  const [s, w1, w2] = CHANS[color]
  let n = 0
  for (let i = 0; i < buf.length; i += 3) {
    if (buf[i + s] > 140 && buf[i + w1] < 110 && buf[i + w2] < 110) n++
  }
  return n
}

function spreadOf(frame) {
  const mids = bands(frame).map((b) => b.mid).filter((m) => m != null).sort((a, b) => a - b)
  return { spread: mids.length >= 2 ? mids[mids.length - 1] - mids[0] : 0, n: mids.length }
}

let fail = false

// ---- Check 1: overlap (all-\pos) vs stack (reference) ------------------------
const ovPos = buildOverlapAss(true)
const ovRef = buildOverlapAss(false)
const posOverlap = spreadOf(burn(ovPos.ass, ovPos.W, ovPos.H, 'ov-pos'))
const refOverlap = spreadOf(burn(ovRef.ass, ovRef.W, ovRef.H, 'ov-ref'))
console.log('===== Check 1: overlap vs stack =====')
console.log(`  all-\\pos:   ${posOverlap.n} colour bands, vertical spread = ${posOverlap.spread}px  (want ≤ ${OVERLAP_MAX} = overlapping)`)
console.log(`  reference:  ${refOverlap.n} colour bands, vertical spread = ${refOverlap.spread}px  (want ≥ ${STACK_MIN} = stacked)`)
if (posOverlap.n < 3 || posOverlap.spread > OVERLAP_MAX) {
  fail = true; console.log('  FAIL — all-\\pos cues did not overlap (WYSIWYG broken).')
}
if (refOverlap.n < 3 || refOverlap.spread < STACK_MIN) {
  fail = true; console.log('  FAIL — reference did not stack: the gate proves nothing.')
}

// ---- Check 2: z-order (later cue paints on top) -----------------------------
const zPosAss = buildZOrderAss(true)
const zRefAss = buildZOrderAss(false)
const zPos = burn(zPosAss.ass, zPosAss.W, zPosAss.H, 'z-pos')
const zRef = burn(zRefAss.ass, zRefAss.W, zRefAss.H, 'z-ref')
const zPosBlue = pixelCount(zPos, 'B'), zPosRed = pixelCount(zPos, 'R')
const zRefBlue = pixelCount(zRef, 'B'), zRefRed = pixelCount(zRef, 'R')
console.log('===== Check 2: z-order (front cue = last emitted) =====')
console.log(`  all-\\pos (same text/pos): blue=${zPosBlue}px red=${zPosRed}px  (want blue≫0, red≈0 = blue on top)`)
console.log(`  reference (stacked):      blue=${zRefBlue}px red=${zRefRed}px  (want both ≫0 = separate bands)`)
// Front (blue, last-emitted) must dominate; the covered red is nearly gone.
if (!(zPosBlue > 100 && zPosRed < zPosBlue * 0.1)) {
  fail = true; console.log('  FAIL — the later cue did not paint on top in the overlap.')
}
// Control: stacked, both colours are separately visible.
if (!(zRefBlue > 100 && zRefRed > 100)) {
  fail = true; console.log('  FAIL — reference did not show both colours: the z-order control proves nothing.')
}

// ---- Check 3: an explicit `layer` overrides emission order ------------------
const loAss = buildLayerOverrideAss()
const lo = burn(loAss.ass, loAss.W, loAss.H, 'lo')
const loRed = pixelCount(lo, 'R'), loBlue = pixelCount(lo, 'B')
console.log('===== Check 3: layer overrides emission order =====')
console.log(`  red(layer 1, emitted first) vs blue(layer 0, emitted last): red=${loRed}px blue=${loBlue}px  (want red on top)`)
// Red carries the higher layer, so it must win despite being emitted first.
if (!(loRed > 100 && loBlue < loRed * 0.1)) {
  fail = true; console.log('  FAIL — the higher `layer` did not paint on top (z-order not honoured).')
}

rmSync(DIR, { recursive: true, force: true })
rmSync(OUT, { force: true })

if (fail) {
  console.error('\nFAIL — WYSIWYG overlap / z-order parity broken.')
  process.exit(1)
}
console.log('\nOK — overlapping same-position cues overlap (not stacked) and the later cue paints on top, matching the preview.')
