/**
 * REQ-0536 §2 — candidate remedies, measured on one fixture.
 *
 * `node scripts/measure-rotation-edges/candidates.mjs [--extra-font id=path]`
 *
 * §1 established that the burn's rotated edges ARE correctly antialiased and
 * that the preview's are simply SOFTER (a wider ramp). So the candidates here
 * are about the ramp width, and each is judged on the same metric plus the
 * cost it carries.
 *
 * ★ Nothing here changes production. Every candidate is applied by perturbing
 * the ASS that the real `generateAss` produced, or by changing the ffmpeg
 * invocation — a prototype, exactly as REQ-0536 §3 requires. Whichever the
 * owner picks is implemented in a later REQ, in the product code, with its own
 * gate.
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
const DUMP = path.join(HERE, '.dumpc.cjs')
const OUT = path.join(REPO, 'dev-docs', 'req-0536-crops')
const DIR = path.join(tmpdir(), `mojioko-rotc-${process.pid}`)
const FF = path.join(REPO, 'resources', 'bin', 'ffmpeg', 'ffmpeg.exe')
const BUNDLED_FONTS = path.join(REPO, 'resources', 'fonts', 'Noto_Sans_JP', 'static')

const EXTRA = new Map()
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--extra-font' && process.argv[i + 1]) {
    const [id, ...rest] = process.argv[i + 1].split('=')
    EXTRA.set(id, rest.join('='))
  }
}

const W = 1920, H = 1080
const ANGLE = 15

esbuild.buildSync({
  entryPoints: [path.join(HERE, 'dump-entry.ts')],
  bundle: true, outfile: DUMP, format: 'cjs', platform: 'node',
  define: { __dirname: JSON.stringify(HERE) },
  loader: { '.css': 'empty', '.png': 'empty' },
  alias: { '@': path.join(REPO, 'src/renderer') },
  logLevel: 'silent',
})
const burnSide = require(DUMP)

mkdirSync(DIR, { recursive: true })
mkdirSync(OUT, { recursive: true })
/**
 * The candidates are compared on the RAW render, without the encode step.
 *
 * That is not a shortcut: `index.mjs` measured every subject both raw and
 * through the app's real encoder and they agreed to within 0.004 px of
 * residual and 0.03 px of transition width. The encoder is therefore not a
 * variable in this comparison, and leaving it out keeps each candidate's
 * timing free of nvenc's own variance.
 */

const SUBSET = ['noto-sans-jp-semibold', 'noto-sans-jp-black', 'dela-gothic-one']
const fonts = burnSide.FONTS.filter((f) => SUBSET.includes(f.id)).map((f) => {
  const bundled = path.join(BUNDLED_FONTS, f.fileName)
  const extra = EXTRA.get(f.id)
  const at = extra && existsSync(extra) ? extra : existsSync(bundled) ? bundled : null
  return { ...f, at, viaExtra: Boolean(extra && existsSync(extra)) }
}).filter((f) => {
  if (!f.at) console.log(`  ${f.displayName}: NOT AVAILABLE — skipped, and NOT substituted`)
  return f.at
})

const STAGE = path.join(DIR, 'fonts')
mkdirSync(STAGE, { recursive: true })
for (const f of fonts) copyFileSync(f.at, path.join(STAGE, f.fileName))

const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:')
const ff = (args, tag) => {
  const t0 = Date.now()
  const r = spawnSync(FF, ['-y', '-v', 'error', ...args])
  if (r.status !== 0) { console.error(`ffmpeg failed (${tag}):`, r.stderr?.toString()); process.exit(2) }
  return Date.now() - t0
}

function inkBox(buf, w, h, thr = 8) {
  let x0 = w, x1 = -1, y0 = h, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (lumaAt(buf, w, x, y) > thr) {
      if (x < x0) x0 = x; if (x > x1) x1 = x
      if (y < y0) y0 = y; if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, x1, y0, y1 }
}

/**
 * CANDIDATE (b) — soften the edge with a small `\blur`.
 *
 * Injected into the override block the real writer produced, right before the
 * closing brace, so every other tag is production's own.
 */
function withBlur(ass, amount) {
  // Dialogue fields are Layer,Start,End,Style,MarginL,MarginR,MarginV,Effect,
  // Text — seven commas after the Layer field, then the one that opens Text.
  const out = ass.replace(/^(Dialogue:[^,]*(?:,[^,]*){7},\{)/gm, `$1\\blur${amount}`)
  // ★ An injection that silently misses reports BASELINE numbers under the
  // candidate's name. That is not hypothetical: the first version of this
  // regex counted one comma too many, and every blur row printed baseline's
  // figures to four decimals — which reads exactly like the real finding
  // "blur changes nothing".
  if (out === ass) {
    throw new Error(`blur ${amount}: injection matched no Dialogue line — the candidate was never applied`)
  }
  return out
}

const results = []
function record(font, candidate, mode, m, ms, note) {
  results.push({ font, candidate, mode, ...(m ?? {}), ms, note })
  if (!m) { console.log(`${font.padEnd(16)} ${candidate.padEnd(14)} ${mode.padEnd(7)}  (no edge)  ${note ?? ''}`); return }
  console.log(
    `${font.padEnd(16)} ${candidate.padEnd(14)} ${mode.padEnd(7)}  ` +
    `${m.residualRms.toFixed(4).padStart(11)}  ${m.transitionPx.toFixed(2).padStart(12)}  ` +
    `${String(m.levels).padStart(6)}  ${m.angleDeg.toFixed(1).padStart(6)}  ${String(ms).padStart(6)}ms  ${note ?? ''}`)
}

/** Baseline + blur candidates: same pipeline, only the ASS differs. */
function runAss(tag, ass, scale) {
  const assPath = path.join(DIR, `${tag}.ass`)
  writeFileSync(assPath, ass, 'utf-8')
  const w = W * scale, h = H * scale
  const raw = path.join(DIR, `${tag}.rgb`)
  // Supersampling (candidate c) renders the WHOLE frame at `scale`, then
  // downscales with a proper filter — which is what "render high, resample"
  // means in practice, and it is why its cost is the interesting number.
  const vf = scale === 1
    ? `subtitles='${esc(assPath)}':fontsdir='${esc(STAGE)}'`
    : `subtitles='${esc(assPath)}':fontsdir='${esc(STAGE)}',scale=${W}:${H}:flags=lanczos`
  const ms = ff(['-f', 'lavfi', '-i', `color=black:s=${w}x${h}:d=1:r=30`,
    '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], tag)
  return { buf: readFileSync(raw), path: raw, ms }
}

console.log(`\nall rows are rotation ${ANGLE}deg. residualRms floor for NO antialiasing = ${QUANTISED_RMS.toFixed(3)}\n`)
console.log('font             candidate      layer        residualRms  transitionPx  levels  fitAng    time')

for (const f of fonts) {
  for (const mode of ['glyph', 'border']) {
    const base = burnSide.cueAss({ fontId: f.id, rotation: ANGLE, mode })
    const ass = f.viaExtra ? base.split(f.assFontName).join(f.displayName) : base

    const CANDIDATES = [
      ['baseline', ass, 1, ''],
      ['blur 0.4', withBlur(ass, 0.4), 1, ''],
      ['blur 0.6', withBlur(ass, 0.6), 1, ''],
      ['blur 1.0', withBlur(ass, 1.0), 1, ''],
      ['supersample2x', burnSide.cueAss({ fontId: f.id, rotation: ANGLE, mode, scale: 2 }), 2, 'whole frame at 2x'],
    ]
    for (const [name, a, scale, note] of CANDIDATES) {
      const useAss = name === 'supersample2x' && f.viaExtra
        ? a.split(f.assFontName).join(f.displayName) : a
      const tag = `${f.id}-${mode}-${name.replace(/[^a-z0-9]+/gi, '')}`
      const r = runAss(tag, useAss, scale)
      const box = inkBox(r.buf, W, H)
      const m = box ? followEdge(r.buf, W, H, box) : null
      record(f.displayName.replace('Noto Sans JP ', 'Noto '), name, mode, m, r.ms, note)
      if (m) {
        const size = 40, sc = 10
        const cx = Math.max(0, Math.min(W - size, Math.round(m.atX - size / 2)))
        const cy = Math.max(0, Math.min(H - size, Math.round(m.atY - size / 2)))
        ff(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', r.path,
          '-vf', `crop=${size}:${size}:${cx}:${cy},scale=${size * sc}:${size * sc}:flags=neighbor`,
          path.join(OUT, `cand-${tag}.png`)], 'crop')
      }
    }
  }
}

writeFileSync(path.join(OUT, 'measurements-candidates.json'), JSON.stringify(results, null, 2), 'utf-8')
console.log(`\ncrops + measurements-candidates.json → ${OUT}`)
try { rmSync(DIR, { recursive: true, force: true }) } catch { /* best effort */ }
try { rmSync(DUMP, { force: true }) } catch { /* best effort */ }
