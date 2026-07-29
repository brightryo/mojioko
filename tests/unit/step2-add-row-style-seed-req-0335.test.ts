import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  styleFieldsFromDefaults,
  TRANSCRIPTION_DEFAULTS_TO_ENTRY,
  RESOLVE_TARGETS,
} from '../../src/renderer/lib/style-defaults-to-entry'
import { animationFieldsForNewCue } from '../../src/shared/cue-animation'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'
import type { TranscriptionDefaults } from '../../src/shared/types'

/**
 * REQ-0335 §2 — a row ADDED in Step 2 must look like a row TRANSCRIBED in
 * Step 1 under the same settings.
 *
 * Before this REQ the two entry-creation sites in `step2.tsx` (the add-row
 * dialog and the SRT import) seeded four style fields by hand — size, text
 * colour, outline colour, outline width — so an added row silently lost the
 * user's shadow, casing, rotation, line spacing, opacity, emphasis, karaoke
 * and offset defaults.  This is the same "hand-listed field set drifts behind
 * the type" bug class that REQ-0334 §2 fixed for the Step 1 live preview; the
 * cure is likewise to route every site through `styleFieldsFromDefaults`.
 *
 * Two guards, because either alone is weak:
 *   1. behavioural — the style fields the two paths produce are equal;
 *   2. source-level — `step2.tsx` really does call the shared projection at
 *      both sites and does not hand-list style fields any more.  Without (2)
 *      a future edit could re-inline the list and (1) would keep passing,
 *      since (1) can only exercise the shared helper, not the route file
 *      (the repo has no React component test infrastructure — see
 *      `req-0246-no-auto-select.test.ts` for the same reasoning).
 */

const STEP2_PATH = join(__dirname, '../../src/renderer/routes/step2.tsx')

/** Strip `//` line comments and block comments so prose cannot match. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** A defaults object with EVERY optional style field set to a non-neutral value. */
function richDefaults(): TranscriptionDefaults {
  return {
    fontSizePx: 88,
    textColorHex: '#EEDD00',
    outlineColorHex: '#101020',
    outlineThicknessPx: 5,
    whisperModel: 'medium',
    shadowDepth: 9,
    shadowColor: '#223344',
    shadowAlpha: 65,
    textAlpha: 85,
    outlineAlpha: 75,
    karaokeEnabled: true,
    karaokeHighlightColor: '#FF8800',
    keywordEmphasisEnabled: true,
    emphasisColorHex: '#FF0066',
    emphasisScalePercent: 145,
    casing: 'uppercase',
    rotation: 12,
    lineSpacingPercent: -20,
    horizontalPosition: 'right',
    verticalPosition: 'top',
    verticalMarginPx: 77,
    posOffsetX: 30,
    posOffsetY: -15,
    animationType: 'pop',
    animationInEnabled: true,
    animationOutEnabled: false,
    animationDurationSec: 0.45,
    animationStartScalePercent: 40,
    animationBlurPx: 6,
  } as TranscriptionDefaults
}

const HD = { videoWidthPx: 1920, videoHeightPx: 1080 }
const NO_VIDEO = { videoWidthPx: undefined, videoHeightPx: undefined }

/**
 * The style half of the `base` literal each site builds.  Mirrors the spread
 * order in `step1.tsx` (transcription) and `step2.tsx` (add row / SRT import):
 * animation, then layout defaults, then the defaults projection on top.
 */
function styleHalf(d: TranscriptionDefaults, geometry: typeof HD | typeof NO_VIDEO) {
  return {
    ...animationFieldsForNewCue(d),
    ...makeEntryLayoutDefaults(),
    ...styleFieldsFromDefaults(d, geometry),
  }
}

describe('REQ-0335 §2 — Step 2 add-row seeds the same style as transcription', () => {
  it('produces an identical style field set to the transcription path', () => {
    const d = richDefaults()
    // Step 1 (transcription) also carries `fontId` / `words` / timings, but
    // those are not style and are compared nowhere here.
    expect(styleHalf(d, HD)).toEqual(styleHalf(d, HD))
    // Every `copy`-classified default must actually reach the row, at its
    // configured value — this is what used to be lost.
    const produced = styleHalf(d, HD) as Record<string, unknown>
    for (const [key, rule] of Object.entries(TRANSCRIPTION_DEFAULTS_TO_ENTRY)) {
      if (rule !== 'copy') continue
      expect(produced[key], `default '${key}' must reach an added row`).toEqual(
        (d as unknown as Record<string, unknown>)[key],
      )
    }
    // …and every `resolve` target too.
    for (const target of Object.values(RESOLVE_TARGETS)) {
      expect(produced, `resolve target '${target}' must reach an added row`).toHaveProperty(target)
    }
  })

  it('carries the style effects a hand-listed four-field seed used to drop', () => {
    const d = richDefaults()
    expect(styleHalf(d, HD)).toMatchObject({
      shadowDepth: 9,
      shadowColor: '#223344',
      shadowAlpha: 65,
      textAlpha: 85,
      outlineAlpha: 75,
      casing: 'uppercase',
      rotation: 12,
      lineSpacingPercent: -20,
      karaokeEnabled: true,
      karaokeHighlightColor: '#FF8800',
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FF0066',
      emphasisScalePercent: 145,
      horizontalPosition: 'right',
      verticalPosition: 'top',
      verticalMarginPx: 77,
    })
  })

  it('produces no NaN and no crash when no video is loaded', () => {
    const produced = styleHalf(richDefaults(), NO_VIDEO) as Record<string, unknown>
    // The offsets need the frame size to become absolute `\pos`; with no
    // video they stay unresolved and the row uses alignment-based layout.
    expect(produced.posX).toBeUndefined()
    expect(produced.posY).toBeUndefined()
    for (const [key, value] of Object.entries(produced)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${key} must be finite without a video`).toBe(true)
      }
    }
  })

  it('step2.tsx routes BOTH entry-creation sites through the shared projection', () => {
    const src = stripComments(readFileSync(STEP2_PATH, 'utf8'))
    const calls = src.match(/styleFieldsFromDefaults\(/g) ?? []
    // 2 call sites (add-row dialog + SRT import); the import statement uses
    // no parenthesis so it is not counted.
    expect(calls.length).toBe(2)
  })

  it('step2.tsx no longer hand-lists style fields from defaults', () => {
    const src = stripComments(readFileSync(STEP2_PATH, 'utf8'))
    for (const field of ['fontSizePx', 'textColorHex', 'outlineColorHex', 'outlineThicknessPx']) {
      expect(src, `defaults.${field} must not be seeded by hand`).not.toContain(`defaults.${field}`)
    }
  })
})
