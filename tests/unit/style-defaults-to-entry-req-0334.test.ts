import { describe, it, expect } from 'vitest'
import {
  styleFieldsFromDefaults,
  TRANSCRIPTION_DEFAULTS_TO_ENTRY,
  RESOLVE_TARGETS,
} from '../../src/renderer/lib/style-defaults-to-entry'
import { getAnchorAssPosition } from '../../src/renderer/lib/preview-coords'
import { BURNIN_DEFAULTS } from '../../src/shared/burnin-defaults'
import type { TranscriptionDefaults } from '../../src/shared/types'

/** The five fields that are REQUIRED on `TranscriptionDefaults`. */
function defaults(patch: Partial<TranscriptionDefaults> = {}): TranscriptionDefaults {
  return {
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    whisperModel: 'large-v3',
    ...patch,
  }
}

const NO_VIDEO = { videoWidthPx: undefined, videoHeightPx: undefined }
const HD = { videoWidthPx: 1920, videoHeightPx: 1080 }

describe('REQ-0334 §2 — TranscriptionDefaults → cue style fields', () => {
  it('★ every `copy` key in the map actually lands on the produced object', () => {
    // The guarantee the map buys is only real if the loop honours it.  A
    // refactor that filters or renames keys inside `styleFieldsFromDefaults`
    // would otherwise leave the classification true-on-paper and false in
    // fact — which is exactly the `fade-opacity.ts` "mirrors" failure.
    const produced = styleFieldsFromDefaults(defaults(), NO_VIDEO)
    for (const [key, rule] of Object.entries(TRANSCRIPTION_DEFAULTS_TO_ENTRY)) {
      if (rule !== 'copy') continue
      expect(produced, `'${key}' is classified 'copy' but never reaches the cue`)
        .toHaveProperty(key)
    }
  })

  it('★ every `resolve` key lands on the cue under its declared target name', () => {
    const produced = styleFieldsFromDefaults(defaults(), NO_VIDEO)
    for (const target of Object.values(RESOLVE_TARGETS)) {
      expect(produced, `'${target}' is a declared resolve target but is absent`)
        .toHaveProperty(target)
    }
  })

  it('carries the v1.3.6 style fields the Step 1 preview used to drop', () => {
    const d = defaults({
      shadowDepth: 12,
      shadowColor: '#112233',
      shadowAlpha: 80,
      casing: 'uppercase',
      rotation: 15,
      lineSpacingPercent: 25,
      textAlpha: 60,
      outlineAlpha: 40,
    })
    expect(styleFieldsFromDefaults(d, NO_VIDEO)).toMatchObject({
      shadowDepth: 12,
      shadowColor: '#112233',
      shadowAlpha: 80,
      casing: 'uppercase',
      rotation: 15,
      lineSpacingPercent: 25,
      textAlpha: 60,
      outlineAlpha: 40,
    })
  })

  it('an untouched setting stays `undefined` on the cue', () => {
    // Neutral-by-absence is what keeps pre-REQ-0295 projects byte-identical:
    // every renderer reads these as `field ?? <neutral>`.
    const produced = styleFieldsFromDefaults(defaults(), NO_VIDEO)
    expect(produced.shadowDepth).toBeUndefined()
    expect(produced.casing).toBeUndefined()
    expect(produced.rotation).toBeUndefined()
    expect(produced.lineSpacingPercent).toBeUndefined()
  })

  it('layout falls back to BURNIN_DEFAULTS, and the user value wins when set', () => {
    expect(styleFieldsFromDefaults(defaults(), NO_VIDEO)).toMatchObject({
      horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
      verticalPosition: BURNIN_DEFAULTS.verticalPosition,
      verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx,
    })
    const d = defaults({
      horizontalPosition: 'left',
      verticalPosition: 'top',
      verticalMarginPx: 77,
    })
    expect(styleFieldsFromDefaults(d, NO_VIDEO)).toMatchObject({
      horizontalPosition: 'left',
      verticalPosition: 'top',
      verticalMarginPx: 77,
    })
  })

  it('★ zero offset leaves the cue unpinned — no `\\pos` at burn-in', () => {
    const produced = styleFieldsFromDefaults(defaults({ posOffsetX: 0, posOffsetY: 0 }), HD)
    expect(produced.posX).toBeUndefined()
    expect(produced.posY).toBeUndefined()
  })

  it('a non-zero offset resolves to anchor + offset', () => {
    const d = defaults({ posOffsetX: 10, posOffsetY: -20 })
    const anchor = getAnchorAssPosition(
      BURNIN_DEFAULTS.horizontalPosition,
      BURNIN_DEFAULTS.verticalPosition,
      BURNIN_DEFAULTS.verticalMarginPx,
      HD.videoWidthPx,
      HD.videoHeightPx,
    )
    expect(styleFieldsFromDefaults(d, HD)).toMatchObject({
      posX: anchor.x + 10,
      posY: anchor.y - 20,
    })
  })

  it('an offset with no video loaded cannot be resolved and is dropped', () => {
    // Step 1's preview runs before a video is picked.  Without dimensions
    // there is no anchor to add to, so the cue stays alignment-positioned
    // rather than being pinned at a guessed coordinate.
    const produced = styleFieldsFromDefaults(defaults({ posOffsetX: 10 }), NO_VIDEO)
    expect(produced.posX).toBeUndefined()
    expect(produced.posY).toBeUndefined()
  })

  it('does not seed the animation fields — `animationFieldsForNewCue` owns those', () => {
    const produced = styleFieldsFromDefaults(
      defaults({ animationType: 'pop', animationDurationSec: 0.4 }),
      NO_VIDEO,
    ) as Record<string, unknown>
    for (const [key, rule] of Object.entries(TRANSCRIPTION_DEFAULTS_TO_ENTRY)) {
      if (rule !== 'animation' && rule !== 'not-style') continue
      expect(produced, `'${key}' is not this module's to seed`).not.toHaveProperty(key)
    }
  })
})
