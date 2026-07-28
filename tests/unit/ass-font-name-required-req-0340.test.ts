import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { generateAss } from '../../src/main/services/ass-generator'
import { FONT_REGISTRY, DEFAULT_FONT_ID, getFontMeta } from '../../src/shared/fonts'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'

/**
 * REQ-0340 §3 — `generateAss` must not carry a default `assFontName`.
 *
 * ## What went wrong
 *
 * The parameter defaulted to `'Noto Sans JP SemiBold'`.  That is the
 * `displayName` of the app's default face, but it is NOT its `assFontName`:
 * every TTF the app stages is renamed at build time to a namespaced family
 * (`'MOJIOKO Noto Sans JP SemiBold'`) precisely so libass' DirectWrite
 * provider cannot silently substitute a same-named font installed on the
 * user's machine (REQ-0275, `scripts/build-fonts-v3.py`).
 *
 * So the default named a family present in no `fontsdir` the app ever builds.
 * libass does not warn about a missing family — it substitutes.  The result is
 * a burn (or, in RES-0333's case, a measurement run) rendered in ArialMT that
 * looks plausible enough not to be questioned.
 *
 * ## Why an arity assertion
 *
 * `Function.prototype.length` counts the parameters BEFORE the first one with
 * a default.  It is therefore an exact, cheap statement of "these five
 * arguments cannot be omitted", and it fails the moment somebody re-adds
 * `= 'something'` to `assFontName` — which is the specific regression, not
 * some proxy for it.  Asserting the emitted string instead would not catch it:
 * a re-added default only shows up when a caller omits the argument, and every
 * caller in `src/` passes it.
 */
const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 }

function makeEntry(): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 2, text: 'Hello',
    fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 3, fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
  }
  return { id: 'e1', isDeleted: false, isEdited: false, ...base, original: { ...base } }
}

describe('REQ-0340 §3 — assFontName has no default', () => {
  it('the first five parameters of generateAss are all required', () => {
    // entries, video, burnin, subtitleBackground, assFontName.
    // Drops to 3 the moment `assFontName = '...'` comes back.
    expect(generateAss.length).toBe(5)
  })

  it('the source declares no default for assFontName', () => {
    // The arity check above cannot distinguish "assFontName is required" from
    // "someone reordered the parameters".  Read the declaration too.
    const src = readFileSync(
      path.resolve(__dirname, '../../src/main/services/ass-generator.ts'),
      'utf8',
    )
    expect(src).toContain('assFontName: string,')
    expect(src).not.toMatch(/assFontName: string\s*=/)
  })

  it('emits exactly the family it was given, in both Style rows', () => {
    const ass = generateAss([makeEntry()], video, burnin, undefined, 'MOJIOKO Test Family')
    expect(ass).toContain('Style: Default,MOJIOKO Test Family,')
    expect(ass).toContain('Style: WithBox,MOJIOKO Test Family,')
  })

  it('every registry face has a namespaced assFontName — the reason no bare name is a valid default', () => {
    for (const meta of FONT_REGISTRY) {
      expect(meta.assFontName.startsWith('MOJIOKO ')).toBe(true)
    }
    // The specific string the removed default used to supply is not the
    // default face's real ASS name.  If this ever becomes false, the default
    // was harmless after all and this whole file can go.
    expect(getFontMeta(DEFAULT_FONT_ID).assFontName).not.toBe('Noto Sans JP SemiBold')
    expect(getFontMeta(DEFAULT_FONT_ID).assFontName).toBe('MOJIOKO Noto Sans JP SemiBold')
  })

  it('both production call sites pass a registry-derived family, not a literal', () => {
    // A literal family name in the burn path is the same bug wearing a
    // different hat: it stops tracking `FONT_REGISTRY` the first time a face
    // is renamed.  Both callers must go through `getFontMeta`.
    for (const rel of ['src/main/services/ffmpeg-burnin.ts', 'src/main/services/frame-exporter.ts']) {
      const src = readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
      expect(src).toMatch(/generateAss\(/)
      expect(src).toContain('fontMeta.assFontName')
    }
  })
})
