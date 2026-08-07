/**
 * REQ-0383 — REAL-CHROMIUM gate for the one-frame step (Shift+←/→).
 *
 * Reproduces the panel's frame-step loop: the NEXT step reads back the drifted
 * `video.currentTime` (as the panel does via handleTimeUpdate → videoCurrentTimeSec),
 * feeds it to the REAL `frameStepSec`, seeks, and measures the DISPLAYED frame
 * two ways — the UI number `floor(readback·fps)` and the ACTUAL composited frame
 * via `requestVideoFrameCallback().mediaTime`.  Both must advance 1,2,…,N with
 * no duplicate or skip, then step back to 0.  Tested at 60 AND 59.94 fps.
 *
 * Negative control: the pre-fix boundary-snap formula, run through the SAME
 * loop, MUST dup/skip — else the metric proves nothing.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const { chromium } = require('playwright')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, '.dump.cjs')
const DIR = path.join(tmpdir(), `mojioko-framestep-${process.pid}`)
mkdirSync(DIR, { recursive: true })

if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('ffmpeg not found'); process.exit(2)
}

esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: OUT, format: 'cjs', platform: 'node', logLevel: 'silent',
})
const { frameStepSec } = require(OUT)

const EPS = 1e-6
// Pre-fix formula (negative control): snap to nearest frame, seek to the grid
// BOUNDARY k/fps.  Kept verbatim from RES-0382 so the control is faithful.
const oldStep = (cur, fps, dir, max) => {
  const maxF = Math.max(0, Math.floor((max > 0 ? max : 0) * fps + EPS))
  const c = Math.round((cur > 0 ? cur : 0) * fps)
  return Math.min(maxF, Math.max(0, c + dir)) / fps
}

const N = 12

async function loadVideo(page, videoPath) {
  const uri = 'data:video/mp4;base64,' + readFileSync(videoPath).toString('base64')
  await page.setContent('<!doctype html><video id="v" muted></video>')
  await page.evaluate((u) => new Promise((res) => {
    const v = document.getElementById('v')
    v.src = u
    v.addEventListener('loadeddata', () => res(), { once: true })
  }), uri)
}

async function seekMeasure(page, target, fps) {
  const r = await page.evaluate(({ target }) => new Promise((res) => {
    const v = document.getElementById('v')
    let got = false
    v.requestVideoFrameCallback((_n, meta) => { got = true; res({ readback: v.currentTime, mediaTime: meta.mediaTime }) })
    v.addEventListener('seeked', () => {
      setTimeout(() => { if (!got) res({ readback: v.currentTime, mediaTime: v.currentTime }) }, 150)
    }, { once: true })
    v.currentTime = target
  }), { target })
  return { readback: r.readback, uiFrame: Math.floor(r.readback * fps + EPS), videoFrame: Math.round(r.mediaTime * fps) }
}

/** Run the step loop with a given step function; return the ui/video sequences. */
async function runLoop(page, fps, dur, stepFn) {
  let cur = 0
  const ui = [], vid = []
  for (let i = 0; i < N; i++) {
    const m = await seekMeasure(page, stepFn(cur, fps, 1, dur), fps)
    cur = m.readback; ui.push(m.uiFrame); vid.push(m.videoFrame)
  }
  const back = []
  for (let i = 0; i < N; i++) {
    const m = await seekMeasure(page, stepFn(cur, fps, -1, dur), fps)
    cur = m.readback; back.push(m.uiFrame)
  }
  return { ui, vid, back }
}

const browser = await chromium.launch()
const page = await browser.newPage()
let bad = false
let negProved = true

const fwdExpect = Array.from({ length: N }, (_, i) => i + 1).join(',')
const backExpect = Array.from({ length: N }, (_, i) => Math.max(0, N - 1 - i)).join(',')

// The video's TRUE rate is the left rational; `fps` is what the app feeds
// frameStepSec — `parseFps` rounds r_frame_rate to 2 decimals, so a 60000/1001
// stream is driven as 59.94.  Testing the rounded value against the true-rate
// video is the faithful case (§1.2).
for (const [label, fpsArg, fps, dur] of [['60fps', '60', 60, 3], ['59.94fps', '60000/1001', 59.94, 3.003]]) {
  const vid = path.join(DIR, `v_${label}.mp4`)
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    `testsrc=s=320x180:r=${fpsArg}:d=${dur + 0.2}`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', vid])
  await loadVideo(page, vid)

  console.log(`\n===== ${label} =====`)
  const fixed = await runLoop(page, fps, dur, frameStepSec)
  console.log(`  fixed  uiFrame  fwd: ${fixed.ui.join(',')}`)
  console.log(`  fixed  video    fwd: ${fixed.vid.join(',')}`)
  console.log(`  fixed  uiFrame  back:${fixed.back.join(',')}`)
  const okFwdUi = fixed.ui.join(',') === fwdExpect
  const okFwdVid = fixed.vid.join(',') === fwdExpect
  const okBack = fixed.back.join(',') === backExpect
  if (!okFwdUi) { console.error(`  ✗ ui forward not 1..${N}`); bad = true }
  if (!okFwdVid) { console.error(`  ✗ displayed video frame forward not 1..${N}`); bad = true }
  if (!okBack) { console.error(`  ✗ backward not ${N - 1}..0`); bad = true }
  if (okFwdUi && okFwdVid && okBack) console.log('  OK — one frame per step, forward and back, ui == video.')

  // Negative control — the pre-fix boundary formula MUST dup/skip.
  const old = await runLoop(page, fps, dur, oldStep)
  const oldDupSkip = old.ui.join(',') !== fwdExpect || old.vid.join(',') !== fwdExpect
  console.log(`  neg    uiFrame  fwd: ${old.ui.join(',')}  ${oldDupSkip ? '✓ dup/skip (detected)' : '✗ did NOT dup/skip?!'}`)
  if (!oldDupSkip) negProved = false
}

await browser.close()
rmSync(DIR, { recursive: true, force: true })
rmSync(OUT, { force: true })

console.log('')
if (!negProved) { console.error('FAIL — the negative control did NOT dup/skip; the gate proves nothing.'); bad = true }
else console.log('OK — negative control (pre-fix boundary seek) dup/skips (bug reproduced).')
if (bad) process.exit(1)
console.log('\nOK — Shift+←/→ steps exactly one displayed frame (ui AND video) at 60 and 59.94 fps.')
