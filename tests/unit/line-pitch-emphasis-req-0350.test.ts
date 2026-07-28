import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { generateAss } from '../../src/main/services/ass-generator'
import { KARAOKE_STYLE_DEFAULT } from '../../src/shared/karaoke-style'
import {
  cueLineAnchors,
  lineHeightsAssPx,
  maxFontSizeInLineBodyAssPx,
} from '../../src/shared/line-spacing'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'

/**
 * REQ-0350 — line spacing × keyword emphasis: the burned lines must not merge.
 *
 * ## The defect
 *
 * A cue with a non-zero line spacing is split into one `\pos` event per
 * display line (REQ-0332), because libass gives no way to change the pitch
 * inside a single event.  The pitch handed to `cueLineAnchors` was
 * `linePitchAssPx(entry.fontSizePx, spacing)` — the cue's BASE font size.
 *
 * Keyword emphasis emits its runs with `\fs<scaled>` (160 → 240 px at 150 %),
 * so a line containing an emphasised word is taller than the base size — but
 * every line was still spaced by the base pitch, and the tall lines ran into
 * their neighbours.  Burned at the owner's settings (4 lines, `\fs160`,
 * −30 %, emphasis 150 %) four lines produced **three** ink bands: two pairs
 * had merged.
 *
 * At spacing 0 % the cue is NOT split — libass lays the lines out itself and
 * grows each to its own tallest glyph — which is why the defect needed BOTH a
 * non-zero spacing AND an emphasis before it appeared.  The preview never had
 * it: a unitless CSS `line-height` multiplies each run's own font size, so the
 * line box grows automatically.
 *
 * ## Why the axes are CROSSED
 *
 * RES-0332 §6 measured 18 pitch points and found every one exact — spacing ×
 * alignment × line count × font size, with **no emphasis anywhere**.  RES-0338
 * measured emphasis, at the default spacing.  Each axis was covered; the PAIR
 * was not, and the bug lives only in the pair.  So this gate crosses them.
 *
 * ## Method
 *
 * Real `generateAss` → bundled ffmpeg → libass → FFV1/gbrp (lossless; the
 * bundled build has no libx264) → rawvideo rgb24 → per-row ink profile.  A
 * "line" is a maximal run of inked rows.  Nothing here re-implements the
 * writer: the ASS burned is the bytes production emits.
 *
 * The assertion is the USER-VISIBLE property — four lines must appear as four
 * separated bands — rather than a golden pitch, because the ink-top distance
 * legitimately varies with which glyphs land on each line.  A merged pair is
 * unambiguous and is exactly what the owner saw.
 *
 * ## Negative control
 *
 * `it('...the pre-fix arithmetic still fails')` re-derives the anchors the OLD
 * way (uniform base pitch) and burns those, asserting the merge reappears.  If
 * that test ever passes, this gate has stopped testing anything.
 */
const REPO = path.resolve(__dirname, '../..')
const FFMPEG = path.join(REPO, 'resources/bin/ffmpeg/ffmpeg.exe')
const FONTS = path.join(REPO, 'resources/fonts/Noto_Sans_JP/static')
const W = 1920
const H = 1080

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: W, heightPx: H,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
}

/** Four lines; emphasis lands on lines 1 and 3, as in the owner's screenshot. */
const TEXT = 'デモ版です\\Nこれはテスト\\Nボリューム調整\\N最後の行です'
const KEYWORDS = ['デモ版', 'ボリューム']
const LINE_COUNT = 4

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 2, text: TEXT,
    fontSizePx: 160, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 10, fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
  }
  return { id: 'e1', ...base, isDeleted: false, isEdited: false, original: { ...base }, ...patch }
}

const esc = (p: string) => p.replace(/\\/g, '/').replace(/:/g, '\\:')

/** Burn an ASS string and return the maximal runs of inked rows. */
function burnBands(ass: string, dir: string): { top: number; bottom: number }[] {
  const assPath = path.join(dir, 'a.ass')
  writeFileSync(assPath, ass, 'utf8')
  const mkv = path.join(dir, 'b.mkv')
  const raw = path.join(dir, 'f.rgb')
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1:r=1`,
    '-vf', `subtitles='${esc(assPath)}':fontsdir='${esc(FONTS)}'`,
    '-frames:v', '1', '-c:v', 'ffv1', '-pix_fmt', 'gbrp', mkv], { stdio: 'pipe' })
  execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error',
    '-i', mkv, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { stdio: 'pipe' })
  const buf = readFileSync(raw)
  const bands: { top: number; bottom: number }[] = []
  let start = -1
  for (let y = 0; y < H; y++) {
    let ink = 0
    const b = y * W * 3
    for (let x = 0; x < W && ink < 3; x++) {
      const o = b + x * 3
      if (buf[o] > 40 || buf[o + 1] > 40 || buf[o + 2] > 40) ink++
    }
    const on = ink >= 3
    if (on && start < 0) start = y
    if (!on && start >= 0) { bands.push({ top: start, bottom: y - 1 }); start = -1 }
  }
  if (start >= 0) bands.push({ top: start, bottom: H - 1 })
  return bands
}

function assFor(spacing: number, emphasisPercent: number | null): string {
  const e = makeEntry(emphasisPercent === null
    ? { lineSpacingPercent: spacing }
    : {
        lineSpacingPercent: spacing,
        keywordEmphasisEnabled: true,
        emphasisScalePercent: emphasisPercent,
        emphasisKeywords: KEYWORDS,
      })
  return generateAss([e], video, burnin, undefined,
    'MOJIOKO Noto Sans JP SemiBold', true, KARAOKE_STYLE_DEFAULT)
}

const HAVE_FFMPEG = existsSync(FFMPEG)
const SPACINGS = [-50, -30, 0, 50, 100]
const EMPHASES: (number | null)[] = [null, 50, 130, 150]

describe('REQ-0350 — burned line pitch across spacing × emphasis', () => {
  it.skipIf(!HAVE_FFMPEG)(
    "the owner's reported case renders all four lines separately",
    () => {
      // The blocker itself, stated on its own so a regression names it:
      // 4 lines, \fs160, outline 10, spacing −30 %, emphasis 150 %.
      // Before REQ-0350 this burned as THREE ink bands.
      const dir = mkdtempSync(path.join(tmpdir(), 'mojioko-pitch-owner-'))
      try {
        const bands = burnBands(assFor(-30, 150), dir)
        // eslint-disable-next-line no-console
        console.log(`[REQ-0350 owner case] bands=${bands.length} tops=[${bands.map((b) => b.top).join(',')}]`)
        expect(bands.length, 'four display lines must produce four separated ink bands').toBe(LINE_COUNT)
        for (let i = 1; i < bands.length; i++) {
          expect(bands[i].top, `line ${i} starts below line ${i - 1}`).toBeGreaterThan(bands[i - 1].bottom)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    300_000,
  )

  it.skipIf(!HAVE_FFMPEG)(
    'turning emphasis on never separates the lines less well than emphasis off',
    () => {
      /*
       * The invariant, chosen after burning the full grid.
       *
       * "Always four bands" is NOT true, and asserting it would be asserting a
       * bug of its own — two of the twenty combinations legitimately produce
       * fewer, for reasons that have nothing to do with this fix:
       *
       *   spacing −50 %  — the line BOX (160 × 0.5 = 80 px) is shorter than
       *     the glyphs standing in it, so the lines overlap on purpose.  The
       *     module header calls −50 % "lines overlap noticeably"; it is the
       *     documented floor, and it merges with emphasis OFF too.
       *
       *   spacing +100 % with a large emphasis — the block is ~1600 px tall in
       *     a 1080 px frame, so the top line is CLIPPED off the top edge, not
       *     merged.  Emphasis-off at that spacing already starts at row 0.
       *
       * What the defect actually was: switching emphasis ON made the lines
       * merge where they had been separate.  So that is what is asserted —
       * emphasis must never reduce the number of separated bands — with the
       * already-at-the-edge cases excluded by MEASUREMENT (reference band
       * starts at row 0) rather than by naming spacings.
       */
      const dir = mkdtempSync(path.join(tmpdir(), 'mojioko-pitch-grid-'))
      const failures: string[] = []
      try {
        for (const spacing of SPACINGS) {
          const ref = burnBands(assFor(spacing, null), dir)
          const clipped = ref.length > 0 && ref[0].top === 0
          // eslint-disable-next-line no-console
          console.log(`[REQ-0350] spacing=${String(spacing).padStart(4)}% emphasis= off bands=${ref.length}` +
            ` tops=[${ref.map((b) => b.top).join(',')}]${clipped ? '  (block already at the frame edge)' : ''}`)
          for (const emph of EMPHASES) {
            if (emph === null) continue
            const got = burnBands(assFor(spacing, emph), dir)
            // eslint-disable-next-line no-console
            console.log(`[REQ-0350] spacing=${String(spacing).padStart(4)}% emphasis=${String(emph).padStart(3)}% ` +
              `bands=${got.length} tops=[${got.map((b) => b.top).join(',')}]`)
            if (clipped) continue
            if (got.length < ref.length) {
              failures.push(
                `spacing=${spacing}% emphasis=${emph}%: ${got.length} band(s) vs ${ref.length} with emphasis off ` +
                '— enabling emphasis merged lines that were separate',
              )
            }
            for (let i = 1; i < got.length; i++) {
              if (got[i].top <= got[i - 1].bottom) {
                failures.push(`spacing=${spacing}% emphasis=${emph}%: bands ${i - 1}/${i} overlap`)
              }
            }
          }
        }
        expect(failures, 'emphasis degraded line separation').toEqual([])
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    900_000,
  )

  it.skipIf(!HAVE_FFMPEG)(
    'NEGATIVE CONTROL — the pre-fix uniform-pitch anchors still merge the lines',
    () => {
      // Rebuild the owner's case with the arithmetic REQ-0350 replaced: one
      // pitch for every line, taken from the cue's BASE font size.  Burning it
      // must still reproduce the defect, otherwise the assertion above is not
      // actually sensitive to the thing that was fixed.
      const dir = mkdtempSync(path.join(tmpdir(), 'mojioko-pitch-neg-'))
      try {
        const ass = assFor(-30, 150)
        const lines = ass.split(/\r?\n/)
        const dialogues = lines.filter((l) => l.startsWith('Dialogue:'))
        expect(dialogues.length, 'the cue is split into per-line events').toBe(LINE_COUNT)

        // Uniform pitch = base font size × factor, the pre-REQ-0350 value.
        const uniform = lineHeightsAssPx(new Array(LINE_COUNT).fill(160), -30)
        const old = cueLineAnchors({
          lineHeightsPx: uniform,
          horizontalPosition: 'center', verticalPosition: 'bottom',
          verticalMarginPx: 40, playResX: W, playResY: H, marginLrPx: 60,
        })
        let k = 0
        const broken = lines.map((l) => l.startsWith('Dialogue:')
          ? l.replace(/\\pos\([-\d.]+,[-\d.]+\)/, `\\pos(${W / 2},${old[k++].y})`)
          : l).join('\n')

        const bands = burnBands(broken, dir)
        // eslint-disable-next-line no-console
        console.log(`[REQ-0350 negative control] bands=${bands.length} (expected < ${LINE_COUNT})`)
        expect(
          bands.length,
          'the pre-fix anchors no longer merge the lines — this gate has stopped testing anything',
        ).toBeLessThan(LINE_COUNT)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    300_000,
  )
})

describe('REQ-0350 — the per-line height arithmetic', () => {
  it('reads the largest \\fs in a line body, falling back to the base size', () => {
    expect(maxFontSizeInLineBodyAssPx('plain text', 160)).toBe(160)
    expect(maxFontSizeInLineBodyAssPx('{\\fs240\\c&H00}big{\\fs160}', 160)).toBe(240)
    // A SMALLER emphasis must not shrink the line below the base size: the
    // unemphasised runs on that line are still full size.
    expect(maxFontSizeInLineBodyAssPx('{\\fs80}small{\\fs160}', 160)).toBe(160)
  })

  it('is the same box height the PREVIEW lays out (why the burn now matches it)', () => {
    /*
     * The preview never had this bug, and the reason is arithmetic worth
     * pinning rather than re-deriving next time.
     *
     * `subtitle-overlay` sets a UNITLESS css line-height:
     *
     *     lineHeight = (1 / libassScale) × lineSpacingFactor(percent)
     *
     * A unitless line-height multiplies each element's OWN font-size, and a
     * run is rendered at `fs × libassScale × scale`.  So the line box of a run
     * — and therefore of the line, which takes the tallest — is
     *
     *     box = (fs × libassScale × scale) × (1 / libassScale) × factor
     *         = fs × factor × scale
     *
     * `libassScale` cancels, exactly as REQ-0332 documented for the uniform
     * case.  Dividing out the preview's `scale` leaves `fs × factor`, which is
     * `lineHeightsAssPx` — so feeding the ASS writer the same per-line maximum
     * makes the two sides lay lines out by one formula instead of two.
     */
    const libassScale = 0.6906
    const scale = 0.5
    for (const percent of [-50, -30, 0, 50, 100]) {
      for (const maxFs of [160, 240, 80]) {
        const cssLineHeight = (1 / libassScale) * (1 + percent / 100)
        const cssBoxPx = (maxFs * libassScale * scale) * cssLineHeight
        const assBoxPx = lineHeightsAssPx([maxFs], percent)[0]
        expect(cssBoxPx, `preview box vs ASS box at ${percent}% / fs${maxFs}`)
          .toBeCloseTo(assBoxPx * scale, 6)
      }
    }
  })

  it('collapses to the old uniform-pitch anchors when every line is the same height', () => {
    // The guarantee that keeps REQ-0332's frame-identity result valid: with no
    // emphasis the arithmetic must be term-for-term what it was.
    const pitch = 112 // 160 × 0.7
    for (const v of ['top', 'center', 'bottom'] as const) {
      const got = cueLineAnchors({
        lineHeightsPx: [pitch, pitch, pitch],
        horizontalPosition: 'center', verticalPosition: v,
        verticalMarginPx: 40, playResX: W, playResY: H, marginLrPx: 60,
      }).map((a) => a.y)
      const want = [0, 1, 2].map((i) =>
        v === 'bottom' ? H - 40 - (3 - 1 - i) * pitch
        : v === 'top' ? 40 + i * pitch
        : H / 2 + (i - (3 - 1) / 2) * pitch)
      expect(got, `${v} anchors`).toEqual(want)
    }
  })
})
