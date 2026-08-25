/**
 * REQ-0536 §1 — how good is a ROTATED subtitle edge, and where does it get worse?
 *
 * `npm run measure:rotation-edges`
 *
 * A MEASUREMENT, not a gate (CLAUDE.md §18): it prints numbers and writes crops,
 * and never decides pass/fail. Nothing here changes production behaviour.
 *
 * ## Two decompositions, because "jaggy" has more than one candidate cause
 *
 * WHAT is rotated:
 *   shape  — a `\p1` DRAWING rotated by the same `\frz`. No font, no glyph
 *            outline, no hinting: libass's rasteriser and transform ALONE.
 *   glyph  — real text, `\bord0`, so only the glyph body is drawn.
 *   border — real text with a thick outline, outer edge measured, so the
 *            border layer is what is under test rather than the body.
 *
 * WHERE it is measured:
 *   raw     — straight out of the `subtitles` filter as RGB. This is what
 *             libass produced.
 *   encoded — through the app's REAL encoder arguments (`buildEncoderArgs`,
 *             so nvenc `-preset p5 -tune hq -rc vbr -cq 20`, no `-pix_fmt`,
 *             i.e. yuv420p), then decoded back. This is what the owner
 *             actually watches.
 *
 * The second split is the one that matters and it is easy to skip: measuring
 * the filter output alone answers "did libass draw it well", which is NOT the
 * question asked. The reported complaint compares an ENCODED mp4 against an
 * un-encoded preview, so the encoder has to be inside the measurement or the
 * comparison is not the user's.
 */
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import { spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'fs'
import { tmpdir } from 'os'
import { followEdge, lumaAt, QUANTISED_RMS } from './metric.mjs'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const DUMP = path.join(HERE, '.dump.cjs')
const OUT = path.join(REPO, 'dev-docs', 'req-0536-crops')
const DIR = path.join(tmpdir(), `mojioko-rot-${process.pid}`)
const FF = path.join(REPO, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')
const BUNDLED_FONTS = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')
const USER_FONTS = path.join(process.env.APPDATA ?? '', 'MOJIOKO', 'fonts')
/**
 * Extra TTFs to measure that are not installed on this machine, as
 * `--extra-font <id>=<path>`.  Dela Gothic One is the reported font and is a
 * paid-tier download, so a dev box need not have it; naming it on the command
 * line beats silently measuring something else.
 */
const EXTRA = new Map()
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--extra-font' && process.argv[i + 1]) {
    const [id, ...rest] = process.argv[i + 1].split('=')
    EXTRA.set(id, rest.join('='))
  }
}

const W = 1920, H = 1080
const ANGLES = [0, 5, 15, 45]
const SUBSET = ['noto-sans-jp-semibold', 'noto-sans-jp-black', 'dela-gothic-one']

esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: DUMP, format: 'cjs', platform: 'node',
  define: { __dirname: JSON.stringify(HERE) },
  loader: { '.css': 'empty', '.png': 'empty' },
  alias: { '@': path.join(REPO, 'src/renderer') },
  logLevel: 'silent',
})
const burnSide = require(DUMP)

if (!existsSync(FF)) { console.error(`bundled ffmpeg missing: ${FF}`); process.exit(2) }
mkdirSync(DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })

const ff = (args, tag) => {
  const r = spawnSync(FF, ['-y', '-v', 'error', ...args])
  if (r.status !== 0) { console.error(`ffmpeg failed (${tag}):`, r.stderr?.toString()); process.exit(2) }
}
const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:')

// --- the app's own encoder choice --------------------------------------------
const encoders = spawnSync(FF, ['-encoders', '-hide_banner'], { encoding: 'utf8' }).stdout ?? ''
const ENCODER = ['h264_nvenc', 'h264_amf', 'h264_qsv', 'h264_mf'].find((e) => encoders.includes(e)) ?? 'h264_mf'
const ENCODER_ARGS = burnSide.encoderArgs(ENCODER)

// --- fonts -------------------------------------------------------------------
const fonts = burnSide.FONTS.filter((f) => SUBSET.includes(f.id)).map((f) => {
  const bundled = path.join(BUNDLED_FONTS, f.fileName)
  const user = path.join(USER_FONTS, f.id, f.fileName)
  const extra = EXTRA.get(f.id)
  const at = extra && existsSync(extra) ? extra
    : existsSync(bundled) ? bundled
      : existsSync(user) ? user : null
  return { ...f, at, viaExtra: Boolean(extra && existsSync(extra)) }
})

console.log(`ffmpeg  : ${FF}`)
console.log(`encoder : ${ENCODER}  ${ENCODER_ARGS.join(' ')}`)
console.log('fonts   :')
for (const f of fonts) {
  console.log(`  ${f.displayName.padEnd(22)} ${f.at ? (f.viaExtra ? '(--extra-font) ' : '') + f.at : 'NOT INSTALLED — skipped, and NOT substituted'}`)
}
const usable = fonts.filter((f) => f.at)
if (usable.length === 0) { console.error('no fonts available'); process.exit(2) }

const STAGE = path.join(DIR, 'fonts')
mkdirSync(STAGE, { recursive: true })
for (const f of usable) copyFileSync(f.at, path.join(STAGE, f.fileName))

/**
 * A font supplied via `--extra-font` is the UPSTREAM file, whose family is the
 * plain name; the app ships a namespaced copy (`MOJIOKO …`, REQ-0275) so libass
 * cannot pick up a system font of the same name.  Rewriting the Style's
 * Fontname is a harness-only substitution — every tag production emitted is
 * untouched — and it is verified below by checking the render is not Noto's.
 */
function fixFontName(ass, f) {
  return f.viaExtra ? ass.split(f.assFontName).join(f.displayName) : ass
}

function rawFrame(tag, ass) {
  const assPath = path.join(DIR, `${tag}.ass`)
  writeFileSync(assPath, ass, 'utf-8')
  const raw = path.join(DIR, `${tag}.rgb`)
  ff(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1`,
    '-vf', `subtitles='${esc(assPath)}':fontsdir='${esc(STAGE)}'`,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], tag)
  return { buf: readFileSync(raw), path: raw }
}

function encodedFrame(tag, ass) {
  const assPath = path.join(DIR, `${tag}.ass`)
  writeFileSync(assPath, ass, 'utf-8')
  const mp4 = path.join(DIR, `${tag}.mp4`)
  ff(['-f', 'lavfi', '-i', `color=black:s=${W}x${H}:d=1:r=30`,
    '-vf', `subtitles='${esc(assPath)}':fontsdir='${esc(STAGE)}'`,
    ...ENCODER_ARGS, mp4], `${tag}-encode`)
  const raw = path.join(DIR, `${tag}-enc.rgb`)
  ff(['-i', mp4, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], `${tag}-decode`)
  return { buf: readFileSync(raw), path: raw }
}

function inkBox(buf, thr = 8) {
  let x0 = W, x1 = -1, y0 = H, y1 = -1
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (lumaAt(buf, W, x, y) > thr) {
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 }
}
const inkArea = (buf, thr = 128) => {
  let n = 0
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (lumaAt(buf, W, x, y) > thr) n++
  return n
}

function crop(tag, rgbPath, at, scale = 10, size = 40) {
  // Centred on the segment the metric actually measured, so the picture and
  // the number are about the same piece of edge.
  const cx = Math.max(0, Math.min(W - size, Math.round(at.x0 - size / 2)))
  const cy = Math.max(0, Math.min(H - size, Math.round(at.y0 - size / 2)))
  ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', rgbPath,
    '-vf', `crop=${size}:${size}:${cx}:${cy},scale=${size * scale}:${size * scale}:flags=neighbor`,
    path.join(OUT, `${tag}.png`)], `crop-${tag}`)
}

const rows = []
function run(subject, stage, angle, tag, ass, wantCrop) {
  const f = stage === 'raw' ? rawFrame(tag, ass) : encodedFrame(tag, ass)
  const box = inkBox(f.buf)
  if (!box) { console.log(`${subject.padEnd(26)} ${stage.padEnd(7)} ${String(angle).padStart(3)}   (no ink)`); return null }
  const m = followEdge(f.buf, W, H, box)
  if (!m) { console.log(`${subject.padEnd(26)} ${stage.padEnd(7)} ${String(angle).padStart(3)}   (no edge)`); return null }
  rows.push({ subject, stage, angle, ...m })
  console.log(
    `${subject.padEnd(26)} ${stage.padEnd(7)} ${String(angle).padStart(3)}  ` +
    `${m.residualRms.toFixed(4).padStart(11)}  ${m.transitionPx.toFixed(2).padStart(12)}  ${String(m.levels).padStart(6)}  ${String(m.rows).padStart(4)}  ${m.angleDeg.toFixed(1).padStart(6)}`)
  if (wantCrop) crop(tag, f.path, { x0: Math.round(m.atX), y0: Math.round(m.atY) })
  return { m, buf: f.buf }
}

console.log(`\nresidualRms in px — an edge with NO antialiasing cannot beat ${QUANTISED_RMS.toFixed(3)}`)
console.log('\nsubject                    stage   ang  residualRms  transitionPx  levels')

for (const angle of ANGLES) {
  const ass = burnSide.shapeAss(angle, W, H)
  run('shape (\\p1, control)', 'raw', angle, `shape-raw-${angle}`, ass, true)
  run('shape (\\p1, control)', 'encoded', angle, `shape-enc-${angle}`, ass, true)
}

// A Noto reference render, to prove an --extra-font really rendered.
let notoArea = null
for (const f of usable) {
  for (const angle of ANGLES) {
    for (const mode of ['glyph', 'border']) {
      const ass = fixFontName(burnSide.cueAss({ fontId: f.id, rotation: angle, mode }), f)
      const label = `${mode} ${f.displayName.replace('Noto Sans JP ', 'Noto ')}`
      const r = run(label, 'raw', angle, `${mode}-${f.id}-raw-${angle}`, ass, angle === 15 || angle === 0)
      run(label, 'encoded', angle, `${mode}-${f.id}-enc-${angle}`, ass, angle === 15 || angle === 0)
      if (mode === 'glyph' && angle === 0 && r) {
        const area = inkArea(r.buf)
        if (f.id === 'noto-sans-jp-semibold') notoArea = area
        else if (f.viaExtra && notoArea !== null && Math.abs(area - notoArea) / notoArea < 0.05) {
          console.error(`\n!! ${f.displayName} rendered within 5% of Noto's ink area (${area} vs ${notoArea}).`)
          console.error('   libass almost certainly SUBSTITUTED the font — these rows measure the wrong face.')
          process.exit(3)
        }
      }
    }
  }
}

writeFileSync(path.join(OUT, 'measurements.json'), JSON.stringify(rows, null, 2), 'utf-8')
console.log(`\ncrops + measurements.json → ${OUT}`)
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
try { rmSync(DUMP, { force: true }) } catch { /* best effort */ }
