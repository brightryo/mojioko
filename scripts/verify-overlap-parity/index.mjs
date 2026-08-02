/**
 * REQ-0380 — REAL-MP4 parity gate for time-overlapping cues.
 *
 * Burns 3 fully time-overlapping cues (distinct R/G/B colours) via the app's
 * REAL generateAss, extracts a plateau frame (all active, opacity 1) over a
 * reversible rgb24 path, and measures each colour's vertical band.  The
 * preview stacks them (computeFixedStackOffsets); the burn must too.  Bug =
 * the three ink bands collapse onto one position in the MP4 while the preview
 * offsets say they should be separated.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { spawnSync, execSync } from 'node:child_process'
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
function loadBuildAss() {
  delete require.cache[require.resolve(OUT)]
  esbuild.buildSync({
    entryPoints: [path.join(HERE, 'dump-entry.ts')],
    bundle: true, outfile: OUT, format: 'cjs', platform: 'node',
    loader: { '.css': 'empty', '.png': 'empty' }, alias: { '@': path.join(REPO, 'src/renderer') },
    logLevel: 'silent',
  })
  return require(OUT).buildAss
}
let buildAss = loadBuildAss()

/** @returns {Array<{color:string, top:number, bot:number}>} vertical ink bands */
function bandsFor(animType) {
  const { ass, playResX: W, playResY: H, offsets, dialogues } = buildAss(animType)
  const assPath = path.join(DIR, `${animType}.ass`)
  writeFileSync(assPath, ass)
  const bg = path.join(DIR, 'bg.mp4')
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
    `color=c=black:s=${W}x${H}:d=6:r=30`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', bg])
  const png = path.join(DIR, `${animType}.png`)
  const esc = assPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  // t=3.5s: all three active and at the animation plateau (opacity 1).
  // format=rgb24 BEFORE subtitles so the marker colours survive losslessly.
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', bg, '-ss', '3.5', '-frames:v', '1',
    '-vf', `format=rgb24,subtitles='${esc}':fontsdir='${esc}'`, '-c:v', 'png', png])
  const raw = path.join(DIR, `${animType}.rgb`)
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw])
  const buf = readFileSync(raw)
  const chans = { R: [0, 1, 2], G: [1, 0, 2], B: [2, 0, 1] } // [strong, weak, weak]
  const bands = []
  for (const [color, [s, w1, w2]] of Object.entries(chans)) {
    let top = Infinity, bot = -1
    for (let y = 0; y < H; y++) {
      let hit = false
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3
        if (buf[i + s] > 140 && buf[i + w1] < 110 && buf[i + w2] < 110) { hit = true; break }
      }
      if (hit) { top = Math.min(top, y); bot = Math.max(bot, y) }
    }
    bands.push({ color, top: bot < 0 ? null : top, bot: bot < 0 ? null : bot, mid: bot < 0 ? null : Math.round((top + bot) / 2) })
  }
  return { bands, offsets, dialogues }
}

let fail = false
// 'none' is the built-in positive control (libass collides static cues); the
// animation types are the ones that regressed before this fix.
for (const animType of ['none', 'fade', 'blur', 'scale', 'pop']) {
  console.log(`\n===== animType=${animType} =====`)
  const { bands, offsets } = bandsFor(animType)
  console.log('preview offsets:', offsets.map((o) => `${o.id}=${o.offset}`).join(' '))
  for (const b of bands) console.log(`  burn ${b.color}: rows ${b.top}-${b.bot} mid=${b.mid}`)
  const mids = bands.map((b) => b.mid).filter((m) => m != null).sort((a, b) => a - b)
  // Distinct rows = stacked; all-equal (or <2 distinct) = collapsed.
  const spread = mids.length >= 2 ? mids[mids.length - 1] - mids[0] : 0
  const collapsed = bands.some((b) => b.mid == null) || spread < 40
  console.log(`  => burn vertical spread across cues = ${spread}px  ${collapsed ? 'COLLAPSED (all overlap!) ✗' : 'stacked ok'}`)
  if (collapsed) fail = true
}
// Negative control — the pre-fix ass-generator MUST collapse the blur case, so
// a pass above is proof of the fix, not of a blind gate.  Resolve the pre-fix
// state by the REQ-0380 commit's PARENT (not a hardcoded HEAD~1, which drifts
// the moment any later commit lands on top and silently defeats the control).
// Path-limited so it resolves the commit that actually changed the burn code
// for REQ-0380, not some later commit that merely mentions REQ-0380 in its
// message (e.g. a gate-maintenance commit).
const FIX_COMMIT = execSync(
  'git rev-list -1 --grep=REQ-0380 HEAD -- src/main/services/ass-generator.ts',
  { cwd: REPO }).toString().trim()
const PRE_FIX = `${FIX_COMMIT}~1`
console.log(`\n===== negative control (pre-fix ${PRE_FIX.slice(0, 11)}, blur) =====`)
let negCollapsed = false
try {
  execSync(`git checkout ${PRE_FIX} -- src/main/services/ass-generator.ts`, { cwd: REPO, stdio: 'pipe' })
  buildAss = loadBuildAss()
  const { bands } = bandsFor('blur')
  const mids = bands.map((b) => b.mid).filter((m) => m != null).sort((a, b) => a - b)
  const spread = mids.length >= 2 ? mids[mids.length - 1] - mids[0] : 0
  for (const b of bands) console.log(`  burn ${b.color}: mid=${b.mid}`)
  console.log(`  => pre-fix blur spread = ${spread}px  ${spread < 40 ? 'COLLAPSED (detected) ✓' : 'NOT collapsed?!'}`)
  negCollapsed = spread < 40
} finally {
  execSync('git checkout HEAD -- src/main/services/ass-generator.ts', { cwd: REPO, stdio: 'pipe' })
}
rmSync(DIR, { recursive: true, force: true })

if (!negCollapsed) {
  console.error('\nFAIL — the negative control did NOT collapse pre-fix, so the gate is not proving anything.')
  process.exit(1)
}
if (fail) {
  console.error('\nFAIL — overlapping cues collapse onto one position in the burn while the preview stacks them.')
  process.exit(1)
}
console.log('\nOK — overlapping cues (static AND every animation type) are stacked in the burn, matching the preview; pre-fix collapsed.')
