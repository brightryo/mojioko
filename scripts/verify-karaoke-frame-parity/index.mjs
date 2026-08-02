/**
 * REQ-0381 — REAL-PIXEL karaoke frame-export parity gate.
 *
 * The image export burns the subtitle with ffmpeg's `subtitles` (libass)
 * filter, which evaluates every time-based tag (karaoke `\k`/`\kf`) at the
 * frame's pts.  A single-pass output-side `-ss` render leaves that pts at the
 * extracted frame's own time (`floor(t·fps)/fps`), so the still's karaoke
 * colouring lagged the preview by the intra-frame remainder (up to 1/fps).
 * REQ-0381 splits the export into two passes — extract the frame (unchanged
 * §3 selection), then burn the subtitle at the continuous playhead time via
 * `frameExportSubtitleFilter` (`settb=AVTB,setpts=<t>/TB,subtitles`).
 *
 * This gate burns the app's REAL karaoke-sweep ASS and measures the red
 * (spoken) fraction at several playheads:
 *   - reference = libass at EXACTLY t (continuous, fine timebase, on black)
 *   - fixed     = the REAL two-pass export (extract@seekSec → burn@t)
 *   - pre-fix   = the OLD single-pass command (raw subtitles @ frame pts) — the
 *                 negative control that MUST lag, else the metric proves nothing
 * A separate moving-background check proves the fix does NOT change the
 * selected video frame (§3 preserved).
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
const DIR = path.join(tmpdir(), `mojioko-kfp-${process.pid}`)
mkdirSync(DIR, { recursive: true })

if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('ffmpeg not found'); process.exit(2)
}

esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: OUT, format: 'cjs', platform: 'node',
  loader: { '.css': 'empty', '.png': 'empty' }, alias: { '@': path.join(REPO, 'src/renderer') },
  logLevel: 'silent',
})
const { buildAss, displayedFrameSeekSec, frameExportSubtitleFilter, SWEEP_START, SWEEP_END, FPS } = require(OUT)

const { ass, playResX: W, playResY: H } = buildAss()
writeFileSync(path.join(DIR, 'k.ass'), ass)

// Black bg → only the subtitle is red/white (clean redFrac); moving bg → prove
// the fix does not reselect the video frame.
spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
  `color=c=black:s=${W}x${H}:d=6:r=${FPS}`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
  path.join(DIR, 'black.mp4')])
spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
  `testsrc2=s=${W}x${H}:d=6:r=${FPS}`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p',
  path.join(DIR, 'move.mp4')])

const SUB = `subtitles=k.ass`
const ff = (args, tag) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...args], { cwd: DIR })
  if (r.status !== 0) { console.error(`ffmpeg failed (${tag}):`, r.stderr?.toString()); process.exit(2) }
}

/** Continuous-t reference: libass rendered at EXACTLY t (fine timebase, black). */
function refRed(t) {
  ff(['-i', 'black.mp4', '-ss', '0', '-frames:v', '1',
    '-vf', `format=rgb24,settb=AVTB,setpts=${t.toFixed(6)}/TB,${SUB}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'ref.rgb'], `ref-${t}`)
  return redFraction(readFileSync(path.join(DIR, 'ref.rgb')))
}

/** The REAL two-pass export at playhead t on a background video → rgb buffer. */
function twoPassExport(bg, t, out) {
  const seekSec = displayedFrameSeekSec(t, FPS)
  ff(['-i', bg, '-ss', String(seekSec), '-frames:v', '1', '-c:v', 'png', 'raw.png'], `p1-${t}`)
  ff(['-i', 'raw.png', '-vf', `format=rgb24,${frameExportSubtitleFilter(t, SUB)}`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], `p2-${t}`)
  return readFileSync(path.join(DIR, out))
}

/** The OLD single-pass command (negative control): raw subtitles @ frame pts. */
function preFixExport(bg, t, out) {
  const seekSec = displayedFrameSeekSec(t, FPS)
  ff(['-i', bg, '-ss', String(seekSec), '-frames:v', '1',
    '-vf', `format=rgb24,${SUB}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', out], `pre-${t}`)
  return readFileSync(path.join(DIR, out))
}

function redFraction(buf) {
  let red = 0, white = 0
  for (let i = 0; i < buf.length; i += 3) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2]
    if (r > 140 && g < 90 && b < 90) red++
    else if (r > 150 && g > 150 && b > 150) white++
  }
  const tot = red + white
  return tot ? red / tot : NaN
}

/** Max abs per-channel diff over the top `rows` (background only, no subtitle). */
function topRegionMaxDiff(a, b, rows) {
  const n = Math.min(a.length, b.length, rows * W * 3)
  let max = 0
  for (let i = 0; i < n; i++) { const d = Math.abs(a[i] - b[i]); if (d > max) max = d }
  return max
}

// Playheads spread across the sweep, each at a distinct intra-frame position so
// the pre-fix lag (t − floor(t·fps)/fps) is exercised from ~0 up to ~1/fps.
const PLAYHEADS = [1.200, 1.216, 1.230, 1.316, 1.416, 1.450, 1.483]
const PARITY_TOL = 0.015   // fixed must match reference within this (incl. PNG round-trip)
const DETECT_MIN = 0.020   // negative control must lag by at least this somewhere

console.log(`sweep [${SWEEP_START},${SWEEP_END}]s @ ${FPS}fps  frame=${(1 / FPS).toFixed(4)}s\n`)
console.log('  t       framePts  seekSec   ref     fixed   Δfix    pre-fix Δpre')

let parityFail = false
let maxPreLag = 0
for (const t of PLAYHEADS) {
  const framePts = Math.floor(t * FPS) / FPS
  const seekSec = displayedFrameSeekSec(t, FPS)
  const ref = refRed(t)
  const fixed = redFraction(twoPassExport(path.join(DIR, 'black.mp4'), t, `fix-${t}.rgb`))
  const pre = redFraction(preFixExport(path.join(DIR, 'black.mp4'), t, `pre-${t}.rgb`))

  const dFix = Math.abs(fixed - ref)
  const dPre = Math.abs(pre - ref)
  maxPreLag = Math.max(maxPreLag, dPre)
  if (dFix > PARITY_TOL || Number.isNaN(dFix)) parityFail = true
  console.log(`  ${t.toFixed(3)}   ${framePts.toFixed(4)}    ${seekSec.toFixed(4)}    ` +
    `${ref.toFixed(4)}  ${fixed.toFixed(4)}  ${dFix.toFixed(4)}  ${pre.toFixed(4)}  ${dPre.toFixed(4)}` +
    `${dFix > PARITY_TOL ? '  ✗ FIX' : ''}`)
}

// Video-frame non-regression: on a MOVING background, the two-pass export's
// video frame (top region, above the bottom-anchored subtitle) must be
// pixel-identical to the pre-fix single-pass frame — i.e. the fix moved the
// subtitle clock, not the selected frame.
console.log('\n----- video-frame non-regression (moving bg) -----')
const tF = 1.316
const TOP_ROWS = Math.floor(H * 0.4)
const fFix = twoPassExport(path.join(DIR, 'move.mp4'), tF, 'mframe-fix.rgb')
const fPre = preFixExport(path.join(DIR, 'move.mp4'), tF, 'mframe-pre.rgb')
const diff = topRegionMaxDiff(fFix, fPre, TOP_ROWS)
console.log(`  top-region max diff  two-pass-fixed vs pre-fix = ${diff}`)
const frameRegressed = diff > 1

rmSync(DIR, { recursive: true, force: true })
rmSync(OUT, { force: true })

console.log('')
let bad = false
if (parityFail) { console.error('FAIL — fixed export karaoke colouring does NOT match the playhead (reference) at some t.'); bad = true }
if (maxPreLag < DETECT_MIN) {
  console.error(`FAIL — negative control did not lag (max Δpre=${maxPreLag.toFixed(4)} < ${DETECT_MIN}); the gate proves nothing.`); bad = true
} else {
  console.log(`OK — negative control lags by up to Δpre=${maxPreLag.toFixed(4)} (pre-fix bug reproduced).`)
}
if (frameRegressed) { console.error('FAIL — the fix changed the selected video frame (§3 regression).'); bad = true }
else console.log('OK — video frame unchanged by the subtitle-time fix (§3 frame selection preserved).')

if (bad) process.exit(1)
console.log('\nOK — image-export karaoke colouring matches the preview at the playhead; frame preserved; pre-fix reproduced.')
