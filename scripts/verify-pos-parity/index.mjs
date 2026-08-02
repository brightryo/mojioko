// REQ-0389 / REQ-0391 (positioning-redesign) — verify:pos-parity
//
// Real-MP4 pixel gate: for a single cue per case, burn the historical
// libass-MarginV placement (`forceSelfPositionAll = false`) and the production
// all-`\pos` placement (`= true`, via computeCuePlacement) through the app's
// real ffmpeg/libass with the real bundled font, then compare ink-band
// positions in pixels.  Passes only when the `\pos` render lands within
// tolerance of the MarginV reference for every case, a negative control (a
// deliberately displaced cue) is detected, and no case renders zero ink.
//
// As of Phase 1b (REQ-0391) all-`\pos` is the production default; the MarginV
// path (`false`) is retained solely as this gate's ground-truth reference, so
// this remains a permanent guard that the shipping placement still matches what
// libass' own MarginV placement produced.
//
// Exit 0 = pass, 1 = a parity/scope failure, 2 = environment (no ffmpeg).

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const OUT = path.join(HERE, '.dump.cjs')
const DIR = path.join(tmpdir(), `mojioko-pos-${process.pid}`)
// Real bundled TTFs (Latin + Japanese), name-table already MOJIOKO-namespaced.
const FONTS_DIR = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')

// --- Tolerances (spec §10-3) --------------------------------------------------
const TOL_EDGE = 1.0 // |Δ| line ink band top/bottom, px
const TOL_CX = 0.5 // |Δ| horizontal centre, px
const NEG_MIN = 2.0 // negative control must be detected at ≥ this, px
const NEG_SHIFT = 6 // px the negative-control cue is displaced by

const W = 1920
const H = 1080
const T = 2.0 // playhead inside the cue's [1,4) window

// --- Bundle the real app code -------------------------------------------------
esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: OUT, format: 'cjs', platform: 'node',
  loader: { '.css': 'empty', '.png': 'empty' },
  alias: { '@': path.join(REPO, 'src/renderer') },
  logLevel: 'silent',
})
const { renderPair, renderNegControl, ASS_FONT_NAME } = require(OUT)

// --- ffmpeg preflight ---------------------------------------------------------
if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status !== 0) {
  console.error('verify:pos-parity: ffmpeg not found on PATH')
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

// Black background sized to the ASS PlayRes.
const BG = path.join(DIR, 'bg.mp4')
ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=6:r=30`,
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', BG], 'bg')

const escapeFilterPath = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
const FONTS_ESC = escapeFilterPath(FONTS_DIR)

/** Burn an ASS string onto the black bg at t=T and return the raw rgb24 frame. */
function burn(ass, tag) {
  const assPath = path.join(DIR, `${tag}.ass`)
  const rawPath = path.join(DIR, `${tag}.rgb`)
  writeFileSync(assPath, ass, 'utf8')
  ff(['-i', BG, '-ss', String(T), '-frames:v', '1',
    '-vf', `format=rgb24,subtitles='${escapeFilterPath(assPath)}':fontsdir='${FONTS_ESC}'`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath], tag)
  return readFileSync(rawPath)
}

// --- Measurement --------------------------------------------------------------
// An "ink" pixel is any pixel meaningfully brighter than the black background
// (white text, coloured emphasis, or an opaque box all qualify; a black outline
// on black is invisible and simply not measured — it affects both sides
// equally).  Rows are grouped into contiguous ink BANDS; per band we record the
// top/bottom row and the horizontal centre of its ink.
const THRESH = 90
const MIN_ROW_PIX = 2
function measureBands(buf) {
  const rows = new Array(H)
  for (let y = 0; y < H; y++) {
    let cnt = 0, minX = W, maxX = -1
    const rowBase = y * W * 3
    for (let x = 0; x < W; x++) {
      const i = rowBase + x * 3
      if (buf[i] > THRESH || buf[i + 1] > THRESH || buf[i + 2] > THRESH) {
        cnt++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
    rows[y] = cnt >= MIN_ROW_PIX ? { minX, maxX } : null
  }
  const bands = []
  let cur = null
  for (let y = 0; y < H; y++) {
    if (rows[y]) {
      if (!cur) cur = { top: y, bottom: y, minX: rows[y].minX, maxX: rows[y].maxX }
      else {
        cur.bottom = y
        cur.minX = Math.min(cur.minX, rows[y].minX)
        cur.maxX = Math.max(cur.maxX, rows[y].maxX)
      }
    } else if (cur) { bands.push(cur); cur = null }
  }
  if (cur) bands.push(cur)
  return bands.map((b) => ({ top: b.top, bottom: b.bottom, centerX: (b.minX + b.maxX) / 2 }))
}

function compareBands(legacy, pos) {
  if (legacy.length === 0 || pos.length === 0) {
    return { ok: false, reason: `no ink (legacy ${legacy.length} bands, pos ${pos.length})` }
  }
  if (legacy.length !== pos.length) {
    // Different band counts ⇒ libass wrapped one side but not the other, i.e.
    // the `\N` assumption (spec §3-2, decision B) broke.
    return { ok: false, reason: `band count ${legacy.length}≠${pos.length} (\\N/wrap divergence)` }
  }
  let dTop = 0, dBot = 0, dCx = 0
  for (let i = 0; i < legacy.length; i++) {
    dTop = Math.max(dTop, Math.abs(legacy[i].top - pos[i].top))
    dBot = Math.max(dBot, Math.abs(legacy[i].bottom - pos[i].bottom))
    dCx = Math.max(dCx, Math.abs(legacy[i].centerX - pos[i].centerX))
  }
  const ok = dTop <= TOL_EDGE && dBot <= TOL_EDGE && dCx <= TOL_CX
  return { ok, dTop, dBot, dCx, nbands: legacy.length }
}

// --- Case matrix (spec §10-5) -------------------------------------------------
// Baseline, then single-dimension sweeps, then high-order interaction cells
// (the RES-0350 cross-product hole), then positive-spacing multi-line cells for
// the `\N` line-count check.  Deduped by identity.  Each cell = ONE cue.
const BASE = {
  h: 'center', v: 'bottom', L: 2, marginV: 40, fs: 100,
  lineSpacing: 0, emphasis: false, script: 'latin', bgBox: false, outline: 3,
}
const H3 = ['left', 'center', 'right']
const V3 = ['top', 'center', 'bottom']
const raw = []
// alignments (\an1..9)
for (const h of H3) for (const v of V3) raw.push({ ...BASE, h, v })
// line counts
for (const L of [1, 2, 3]) raw.push({ ...BASE, L })
// vertical margins.  0 is handled separately (intentional correction, below):
// ASS treats a Dialogue MarginV of 0 as "use the Style default", so the current
// burn ignores a user's 0 — a divergence the all-\pos render deliberately fixes.
for (const marginV of [40, 100, 200]) raw.push({ ...BASE, marginV })
// font sizes
for (const fs of [73, 100, 150]) raw.push({ ...BASE, fs })
// line spacing
for (const lineSpacing of [-50, 0, 100]) raw.push({ ...BASE, lineSpacing })
// emphasis / script / bg-box / outline (single-dim)
raw.push({ ...BASE, emphasis: true })
raw.push({ ...BASE, script: 'jp' })
raw.push({ ...BASE, script: 'mixed' })
raw.push({ ...BASE, bgBox: true })
raw.push({ ...BASE, outline: 0 })
// high-order interactions (spacing 0 ⇒ legacy is libass, the real parity test)
raw.push({ ...BASE, L: 3, emphasis: true, script: 'jp', bgBox: true, h: 'left', v: 'top' })
raw.push({ ...BASE, L: 3, emphasis: true, script: 'mixed', h: 'center', v: 'center', fs: 150 })
raw.push({ ...BASE, L: 2, emphasis: true, script: 'jp', bgBox: true, h: 'right', v: 'bottom', marginV: 200 })
raw.push({ ...BASE, L: 2, emphasis: true, bgBox: true, outline: 0, h: 'left', v: 'bottom' })
raw.push({ ...BASE, L: 3, script: 'jp', bgBox: true, h: 'center', v: 'top', fs: 73 })
raw.push({ ...BASE, L: 2, emphasis: true, script: 'mixed', outline: 0, h: 'right', v: 'top' })
// positive-spacing multi-line (\N line-count check)
raw.push({ ...BASE, L: 2, lineSpacing: 100 })
raw.push({ ...BASE, L: 3, lineSpacing: 100 })
raw.push({ ...BASE, L: 2, lineSpacing: 100, script: 'jp' })
raw.push({ ...BASE, L: 3, lineSpacing: 100, emphasis: true })

const seen = new Set()
const CASES = []
for (const c of raw) {
  const key = JSON.stringify(c)
  if (!seen.has(key)) { seen.add(key); CASES.push(c) }
}

// --- Run ----------------------------------------------------------------------
console.log(`verify:pos-parity — font "${ASS_FONT_NAME}", ${CASES.length} cases`)
console.log('(curated sample of the spec §10-5 cross-product: every dimension swept, plus emphasis×multiline×script×bg-box×alignment interaction cells)')

let fail = false
let worstTop = 0, worstBot = 0, worstCx = 0
let nCheckedNCount = 0

let idx = 0
for (const spec of CASES) {
  idx++
  const tag = `c${idx}`
  const { legacyAss, posAss, expectedLines } = renderPair(spec)
  const legacy = measureBands(burn(legacyAss, `${tag}-leg`))
  const pos = measureBands(burn(posAss, `${tag}-pos`))
  const r = compareBands(legacy, pos)
  const label = `an=${legacy.length ? '' : ''}${spec.h[0]}${spec.v[0]} L${spec.L} mV${spec.marginV} fs${spec.fs} ls${spec.lineSpacing} ${spec.emphasis ? 'E' : '-'} ${spec.script} ${spec.bgBox ? 'box' : '---'} o${spec.outline}`
  if (!r.ok) {
    fail = true
    console.log(`  FAIL  ${label}: ${r.reason ?? `Δtop=${r.dTop} Δbot=${r.dBot} Δcx=${r.dCx.toFixed(2)} (${r.nbands} bands)`}`)
    continue
  }
  worstTop = Math.max(worstTop, r.dTop)
  worstBot = Math.max(worstBot, r.dBot)
  worstCx = Math.max(worstCx, r.dCx)
  // \N line-count proof (spec §10-4): where positive spacing separates the
  // lines, the burned band count must equal the expected \N line count.
  if (spec.lineSpacing > 0 && expectedLines > 1) {
    nCheckedNCount++
    if (pos.length !== expectedLines) {
      fail = true
      console.log(`  FAIL  ${label}: \\N line-count ${pos.length}≠${expectedLines}`)
    }
  }
}

// --- Intentional correction: verticalMarginPx = 0 (spec decision A) -----------
// The current burn emits a Dialogue MarginV of 0, which ASS interprets as "use
// the Style default" (= 40px), so the burn ignores the user's 0 while the
// PREVIEW (which honours 0) already disagrees with it today.  All-\pos honours 0
// literally, so its render sits ~40px BELOW the legacy render — a WYSIWYG fix,
// not a parity failure.  Pin the direction and magnitude so the correction is
// documented and cannot silently change.
const STYLE_MV = 40
const mz = renderPair({ ...BASE, marginV: 0 })
const mzLeg = measureBands(burn(mz.legacyAss, 'mz-leg'))
const mzPos = measureBands(burn(mz.posAss, 'mz-pos'))
let mzDelta = 0, mzPosLower = false
if (mzLeg.length && mzPos.length) {
  const legBot = Math.max(...mzLeg.map((b) => b.bottom))
  const posBot = Math.max(...mzPos.map((b) => b.bottom))
  mzDelta = Math.abs(posBot - legBot)
  mzPosLower = posBot > legBot
}
const mzOk = mzPosLower && Math.abs(mzDelta - STYLE_MV) <= 3
console.log(`marginV=0 intentional correction: \\pos sits ${mzDelta}px ${mzPosLower ? 'below' : 'above'} legacy (expect ≈${STYLE_MV} below = the Style-default fallback the burn applies today)`)
if (!mzOk) {
  fail = true
  console.log(`  FAIL  marginV=0 correction unexpected (Δ=${mzDelta}px, below=${mzPosLower})`)
}

// --- Negative control ---------------------------------------------------------
const nc = renderNegControl(NEG_SHIFT)
const ncLegacy = measureBands(burn(nc.legacyAss, 'neg-leg'))
const ncPos = measureBands(burn(nc.posAss, 'neg-pos'))
let ncDelta = 0
if (ncLegacy.length && ncPos.length && ncLegacy.length === ncPos.length) {
  for (let i = 0; i < ncLegacy.length; i++) {
    ncDelta = Math.max(ncDelta, Math.abs(ncLegacy[i].bottom - ncPos[i].bottom), Math.abs(ncLegacy[i].top - ncPos[i].top))
  }
}
const negDetected = ncDelta >= NEG_MIN

// --- Verdict ------------------------------------------------------------------
console.log('')
console.log(`worst live Δ: top=${worstTop}px bot=${worstBot}px centreX=${worstCx.toFixed(2)}px  (tol edge≤${TOL_EDGE}, cx≤${TOL_CX})`)
console.log(`\\N line-count checked on ${nCheckedNCount} positive-spacing multi-line cases`)
console.log(`negative control (${NEG_SHIFT}px shift): measured Δ=${ncDelta}px, detected=${negDetected} (needs ≥${NEG_MIN})`)

rmSync(DIR, { recursive: true, force: true })
rmSync(OUT, { force: true })

if (!negDetected) {
  console.error('FAIL: negative control not detected — the gate proves nothing.')
  process.exit(1)
}
if (fail) {
  console.error('FAIL: one or more cases exceeded tolerance.')
  process.exit(1)
}
console.log('OK: single-cue \\pos placement matches the MarginV render within tolerance across all cases.')
