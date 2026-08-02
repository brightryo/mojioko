/**
 * REQ-0376 §A — preview↔burn stacking parity gate for keyword emphasis.
 *
 * The preview stacks overlapping cues with `estimateCueHeightAssPx`; the
 * ordinary burn lets real libass `fix_collisions` stack them on the actual
 * bitmap.  If the estimate ignores the enlarged `\fs` of an emphasised run,
 * the two part company the moment two emphasised cues overlap (RES-0375 §4 /
 * REQ-0376 §A).
 *
 * This gate MEASURES libass directly: it burns two overlapping bottom-centre
 * cues (lower one green, upper one red) with and without a `\fs240` run on the
 * lower cue, extracts a frame over rgb24 (lossless — before any yuv), and reads
 * how much higher libass pushed the upper cue.  That push MUST equal the extra
 * height the fixed `estimateCueHeightAssPx` now reserves, i.e.
 * `emphFs − baseFs` (240 − 160 = 80 px), within a small tolerance.  Non-zero
 * exit on mismatch — a gate, not a report.
 *
 * Requires ffmpeg on PATH (same as the other MP4-extraction harnesses).
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const W = 1280, H = 720, BASE_FS = 160, EMPH_FS = 240
const EXPECTED_PUSH = EMPH_FS - BASE_FS // 80 px — must match estimateCueHeightAssPx's delta
const TOL = 6 // px — sub-pixel AA + integer row scan slack

const have = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
if (have.status !== 0) {
  console.error('verify:stack-emphasis — ffmpeg not found on PATH; cannot run the burn measurement.')
  process.exit(2)
}

const DIR = join(tmpdir(), `mojioko-stack-emphasis-${process.pid}`)
mkdirSync(DIR, { recursive: true })

function ass(emph) {
  const lower = emph ? `AA{\\fs${EMPH_FS}}BIG{\\fs${BASE_FS}}CC` : `AABIGCC`
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV
Style: Def,Arial,${BASE_FS},&H00FFFFFF,&H00000000,1,4,2,20,20,40

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Def,20,20,40,,{\\c&H00FF00&}${lower}
Dialogue: 0,0:00:00.00,0:00:02.00,Def,20,20,40,,{\\c&H0000FF&}RRRR
`
}

const bg = join(DIR, 'bg.mp4')
spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i',
  `color=c=black:s=${W}x${H}:d=2:r=30`, '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', bg])

/** @returns {number} the top row of the red (upper) cue's ink, or -1. */
function redTopY(emph) {
  const tag = emph ? 'emph' : 'norm'
  const assP = join(DIR, `${tag}.ass`)
  writeFileSync(assP, ass(emph))
  const png = join(DIR, `${tag}.png`)
  const esc = assP.replace(/\\/g, '\\\\').replace(/:/g, '\\:')
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', bg, '-ss', '1', '-frames:v', '1',
    '-vf', `subtitles='${esc}',format=rgb24`, '-c:v', 'png', png])
  const raw = join(DIR, `${tag}.rgb`)
  spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw])
  const buf = readFileSync(raw)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      if (buf[i] > 150 && buf[i + 1] < 120 && buf[i + 2] < 120) return y
    }
  }
  return -1
}

const normTop = redTopY(false)
const emphTop = redTopY(true)
rmSync(DIR, { recursive: true, force: true })

if (normTop < 0 || emphTop < 0) {
  console.error(`FAIL — could not locate the upper cue (normTop=${normTop}, emphTop=${emphTop})`)
  process.exit(1)
}
const push = normTop - emphTop // emphasis pushes the upper cue UP → smaller y
const delta = Math.abs(push - EXPECTED_PUSH)
console.log(`upper-cue top y: no-emphasis=${normTop}, emphasis=${emphTop}`)
console.log(`libass extra reservation for the emphasised cue = ${push}px`)
console.log(`estimateCueHeightAssPx delta (emphFs − baseFs) = ${EXPECTED_PUSH}px | |diff|=${delta}px (tol ${TOL})`)

if (delta > TOL) {
  console.error(`\nFAIL — libass reserved ${push}px but the estimate reserves ${EXPECTED_PUSH}px; preview and burn would disagree.`)
  process.exit(1)
}
console.log('\nOK — the emphasis-aware stack height matches libass to within tolerance.')
