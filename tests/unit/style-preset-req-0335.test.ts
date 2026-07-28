import { describe, it, expect } from 'vitest'
import {
  STYLE_PRESET_FIELDS,
  PRESET_STORED_KEYS,
  PRESET_OFFSET_TARGETS,
  STYLE_PRESET_MAX,
  STYLE_PRESET_NAME_MAX_LEN,
  STYLE_PRESET_VERSION,
  makeSystemStyleDefaults,
  validatePresetName,
  type StylePreset,
} from '../../src/shared/style-preset'
import {
  buildStylePreset,
  buildStylePresetStyle,
  resolveStylePresetPatch,
} from '../../src/renderer/lib/style-preset-apply'
import { BURNIN_DEFAULTS, makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'
import { areWordsValidForText } from '../../src/shared/words-validity'
import { resolveEmphasisRanges } from '../../src/shared/emphasis'
import { getAnchorAssPosition } from '../../src/renderer/lib/preview-coords'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0335 §3 — user-saved style presets.
 *
 * The compile-time half (a new `SubtitleEntry` field must be classified, and
 * a field classified `store` must be given a system initial value) is proved
 * by the two `tsc` probes recorded in RES-0335.  These tests pin the runtime
 * half: that the classification is not a paper exercise, that applying a
 * preset reproduces the source row's look, that it leaves `words` and
 * `emphasisSpans` alone, and that an old preset's missing fields fall back to
 * the SYSTEM initial values rather than to anything the user configured.
 */

const HD = { videoWidthPx: 1920, videoHeightPx: 1080 }
const NO_VIDEO = { videoWidthPx: undefined, videoHeightPx: undefined }

/** A maximally-populated source row — every stored field at a non-neutral value. */
function makeRichEntry(): SubtitleEntry {
  const base = {
    startSec: 1,
    endSec: 3,
    text: 'Hello brave World',
    fontSizePx: 120,
    textColorHex: '#EEDD00',
    outlineColorHex: '#101020',
    outlineThicknessPx: 5,
    fadeDurationSec: 0.2,
    fontId: 'noto-sans-jp' as const,
    horizontalPosition: 'right' as const,
    verticalPosition: 'top' as const,
    verticalMarginPx: 77,
    subtitleBackground: { enabled: true, color: 'white' as const, opacityPercent: 65 },
    posX: 1500,
    posY: 200,
    lineSpacingPercent: -25,
    casing: 'uppercase' as const,
    shadowDepth: 9,
    shadowColor: '#223344',
    shadowAlpha: 65,
    textAlpha: 85,
    outlineAlpha: 75,
    rotation: 12,
    karaokeEnabled: true,
    karaokeHighlightColor: '#FF8800',
    karaokeStyle: 'sweep' as const,
    animationType: 'pop' as const,
    animationInEnabled: true,
    animationOutEnabled: false,
    animationDurationSec: 0.4,
    animationDirection: 'up' as const,
    animationDistancePx: 60,
    animationStartScalePercent: 40,
    // REQ-0337 §2-4 moved the blur range to 20–40 px, so this fixture's old
    // 6 px is now out of range and `resolveAnimation` clamps it (§2-5).
    // The value is arbitrary here — the test is about round-tripping — so
    // it moves into the range rather than the clamp being weakened.
    animationBlurPx: 26,
    words: [
      { startSec: 1.0, endSec: 1.4, text: 'Hello' },
      { startSec: 1.4, endSec: 2.2, text: ' brave' },
      { startSec: 2.2, endSec: 3.0, text: ' World' },
    ],
    keywordEmphasisEnabled: true,
    emphasisColorHex: '#FF0066',
    emphasisScalePercent: 145,
    emphasisSpans: [{ start: 6, end: 11, text: 'brave' }],
  }
  return { id: 'a', ...base, isDeleted: false, isEdited: false, original: { ...base } }
}

/** A neutral target row with its own karaoke word data and emphasis. */
function makePlainTargetEntry(): SubtitleEntry {
  const layout = makeEntryLayoutDefaults()
  const base = {
    startSec: 10,
    endSec: 12,
    text: 'Totally different sentence',
    fontSizePx: BURNIN_DEFAULTS.fontSizePx,
    textColorHex: BURNIN_DEFAULTS.textColorHex,
    outlineColorHex: BURNIN_DEFAULTS.outlineColorHex,
    outlineThicknessPx: BURNIN_DEFAULTS.outlineThicknessPx,
    fadeDurationSec: 0,
    ...layout,
    words: [
      { startSec: 10.0, endSec: 10.6, text: 'Totally' },
      { startSec: 10.6, endSec: 11.3, text: ' different' },
      { startSec: 11.3, endSec: 12.0, text: ' sentence' },
    ],
    emphasisSpans: [{ start: 8, end: 17, text: 'different' }],
  }
  return { id: 'b', ...base, isDeleted: false, isEdited: false, original: { ...base } }
}

describe('REQ-0335 §3-3 — the classification is exhaustive and real', () => {
  it('classifies the fields the owner named as not-stored', () => {
    expect(STYLE_PRESET_FIELDS.words).toBe('per-cue')
    expect(STYLE_PRESET_FIELDS.emphasisSpans).toBe('per-cue')
    expect(STYLE_PRESET_FIELDS.text).toBe('per-cue')
    expect(STYLE_PRESET_FIELDS.startSec).toBe('per-cue')
    expect(STYLE_PRESET_FIELDS.endSec).toBe('per-cue')
    expect(STYLE_PRESET_FIELDS.id).toBe('not-style')
    // `original` must survive a preset apply or "Reset row" would start
    // restoring the preset instead of the transcribed look.
    expect(STYLE_PRESET_FIELDS.original).toBe('not-style')
  })

  it('stores every field the owner listed, karaokeStyle included', () => {
    for (const key of [
      'fontId', 'fontSizePx', 'textColorHex', 'outlineColorHex', 'outlineThicknessPx',
      'shadowDepth', 'shadowColor', 'shadowAlpha', 'textAlpha', 'outlineAlpha',
      'subtitleBackground', 'casing', 'rotation',
      'horizontalPosition', 'verticalPosition', 'verticalMarginPx', 'lineSpacingPercent',
      'karaokeEnabled', 'karaokeHighlightColor', 'karaokeStyle',
      'emphasisColorHex', 'emphasisScalePercent', 'keywordEmphasisEnabled',
      'animationType', 'animationInEnabled', 'animationOutEnabled',
      'animationDurationSec', 'animationStartScalePercent', 'animationBlurPx',
    ] as const) {
      expect(STYLE_PRESET_FIELDS[key], key).toBe('store')
    }
    // The offset is stored, just under a different (resolution-independent) key.
    expect(STYLE_PRESET_FIELDS.posX).toBe('store-as-offset')
    expect(STYLE_PRESET_FIELDS.posY).toBe('store-as-offset')
  })

  it('gives every stored key a system initial value', () => {
    const system = makeSystemStyleDefaults() as Record<string, unknown>
    for (const key of PRESET_STORED_KEYS) {
      expect(key in system, `${key} needs a system default`).toBe(true)
    }
    expect(Object.keys(system).sort()).toEqual([...PRESET_STORED_KEYS].sort())
  })

  it('actually writes every stored key into a built preset', () => {
    const style = buildStylePresetStyle(makeRichEntry(), HD) as Record<string, unknown>
    for (const key of PRESET_STORED_KEYS) {
      expect(key in style, `${key} classified 'store' but never written`).toBe(true)
    }
    for (const key of ['words', 'emphasisSpans', 'text', 'startSec', 'endSec', 'id', 'original']) {
      expect(key in style, `${key} is per-cue and must not be stored`).toBe(false)
    }
    expect(style[PRESET_OFFSET_TARGETS.posX]).toBeTypeOf('number')
  })

  it('hands out a fresh subtitleBackground object per call', () => {
    expect(makeSystemStyleDefaults().subtitleBackground).not.toBe(
      makeSystemStyleDefaults().subtitleBackground,
    )
  })
})

describe('REQ-0335 §3-4 — missing fields fall back to SYSTEM initial values', () => {
  it('uses BURNIN_DEFAULTS / makeEntryLayoutDefaults for required fields', () => {
    const layout = makeEntryLayoutDefaults()
    const empty: StylePreset = {
      id: 'p', name: 'old', version: 1, createdAtMs: 0, style: {},
    }
    const patch = resolveStylePresetPatch(empty, HD)
    expect(patch.fontSizePx).toBe(BURNIN_DEFAULTS.fontSizePx)
    expect(patch.textColorHex).toBe(BURNIN_DEFAULTS.textColorHex)
    expect(patch.outlineColorHex).toBe(BURNIN_DEFAULTS.outlineColorHex)
    expect(patch.outlineThicknessPx).toBe(BURNIN_DEFAULTS.outlineThicknessPx)
    expect(patch.horizontalPosition).toBe(layout.horizontalPosition)
    expect(patch.verticalPosition).toBe(layout.verticalPosition)
    expect(patch.verticalMarginPx).toBe(layout.verticalMarginPx)
    expect(patch.subtitleBackground).toEqual(layout.subtitleBackground)
  })

  it('uses undefined — the renderer neutral — for every optional field', () => {
    const empty: StylePreset = {
      id: 'p', name: 'old', version: 1, createdAtMs: 0, style: {},
    }
    const patch = resolveStylePresetPatch(empty, HD) as Record<string, unknown>
    for (const key of [
      'shadowDepth', 'shadowColor', 'shadowAlpha', 'textAlpha', 'outlineAlpha',
      'casing', 'rotation', 'lineSpacingPercent', 'karaokeEnabled',
      'karaokeHighlightColor', 'karaokeStyle', 'keywordEmphasisEnabled',
      'emphasisColorHex', 'emphasisScalePercent', 'animationType', 'fontId',
    ]) {
      expect(patch[key], `${key} must reset to the system neutral`).toBeUndefined()
    }
    // A field the preset DOES carry is not reset.
    const partial: StylePreset = {
      id: 'p', name: 'old', version: 1, createdAtMs: 0, style: { rotation: 33 },
    }
    expect(resolveStylePresetPatch(partial, HD).rotation).toBe(33)
  })

  it('never reads a partially applied patch — every stored key is present', () => {
    const empty: StylePreset = {
      id: 'p', name: 'old', version: 1, createdAtMs: 0, style: {},
    }
    const patch = resolveStylePresetPatch(empty, HD) as Record<string, unknown>
    for (const key of PRESET_STORED_KEYS) {
      expect(key in patch, `${key} missing from the patch`).toBe(true)
    }
  })
})

describe('REQ-0335 §3-5 / §3-7 — applying reproduces the source look', () => {
  it('makes a different row identical in every stored field', () => {
    const source = makeRichEntry()
    const preset = buildStylePreset(source, 'Neon', HD)
    expect(preset.version).toBe(STYLE_PRESET_VERSION)

    const target = makePlainTargetEntry()
    const applied = { ...target, ...resolveStylePresetPatch(preset, HD) } as unknown as Record<
      string,
      unknown
    >
    const src = source as unknown as Record<string, unknown>
    for (const key of PRESET_STORED_KEYS) {
      expect(applied[key], `${key} did not survive save → apply`).toEqual(src[key])
    }
    // The offset round-trips through the anchor, so the absolute `\pos`
    // comes back identical under the same geometry.
    expect(applied.posX).toBeCloseTo(source.posX!, 6)
    expect(applied.posY).toBeCloseTo(source.posY!, 6)
  })

  it('re-anchors the offset under a different frame size', () => {
    const source = makeRichEntry()
    const preset = buildStylePreset(source, 'Neon', HD)
    const anchorHd = getAnchorAssPosition('right', 'top', 77, 1920, 1080)
    const portrait = { videoWidthPx: 1080, videoHeightPx: 1920 }
    const anchorPortrait = getAnchorAssPosition('right', 'top', 77, 1080, 1920)
    const patch = resolveStylePresetPatch(preset, portrait)
    expect(patch.posX).toBeCloseTo(anchorPortrait.x + (source.posX! - anchorHd.x), 6)
    expect(patch.posY).toBeCloseTo(anchorPortrait.y + (source.posY! - anchorHd.y), 6)
  })

  it('leaves the row unpinned, not NaN, when no video is loaded', () => {
    const preset = buildStylePreset(makeRichEntry(), 'Neon', NO_VIDEO)
    const patch = resolveStylePresetPatch(preset, NO_VIDEO) as Record<string, unknown>
    expect(patch.posX).toBeUndefined()
    expect(patch.posY).toBeUndefined()
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'number') expect(Number.isFinite(v), k).toBe(true)
    }
  })

  it('does NOT damage words — a karaoke row keeps valid per-word timings', () => {
    const target = makePlainTargetEntry()
    expect(areWordsValidForText(target.words, target.text)).toBe(true)

    const preset = buildStylePreset(makeRichEntry(), 'Neon', HD)
    const patch = resolveStylePresetPatch(preset, HD)
    expect('words' in patch).toBe(false)

    const applied = { ...target, ...patch }
    expect(applied.words).toEqual(target.words)
    // The whole point: still valid, so karaoke uses these timings rather
    // than falling back to an even split across the cue's duration.
    expect(areWordsValidForText(applied.words, applied.text)).toBe(true)
  })

  it('does NOT damage emphasisSpans — the target keeps its own selection', () => {
    const target = makePlainTargetEntry()
    const preset = buildStylePreset(makeRichEntry(), 'Neon', HD)
    const patch = resolveStylePresetPatch(preset, HD)
    expect('emphasisSpans' in patch).toBe(false)

    const applied = { ...target, ...patch }
    expect(applied.emphasisSpans).toEqual(target.emphasisSpans)
    // The source's span (chars 6–11 of "Hello brave World") must NOT have
    // landed on the target's completely different text.
    const ranges = resolveEmphasisRanges(applied)
    expect(ranges).toEqual([[8, 17]])
  })

  it('does not share the background object between two rows given one preset', () => {
    const preset = buildStylePreset(makeRichEntry(), 'Neon', HD)
    const a = resolveStylePresetPatch(preset, HD)
    const b = resolveStylePresetPatch(preset, HD)
    expect(a.subtitleBackground).toEqual(b.subtitleBackground)
    expect(a.subtitleBackground).not.toBe(b.subtitleBackground)
    expect(a.subtitleBackground).not.toBe(preset.style.subtitleBackground)
  })

  it('stores the RESOLVED animation, so a legacy fade-only cue is reproducible', () => {
    const legacy = makePlainTargetEntry()
    legacy.fadeDurationSec = 0.3
    const style = buildStylePreset(legacy, 'Legacy', HD).style
    expect(style.animationType).toBe('fade')
    expect(style.animationDurationSec).toBeCloseTo(0.3, 6)
    // …and the legacy field itself never travels.
    expect('fadeDurationSec' in style).toBe(false)
  })
})

describe('REQ-0335 §3-6 — name rules and cap', () => {
  const one: StylePreset[] = [
    { id: 'p1', name: 'Neon', version: 1, createdAtMs: 0, style: {} },
  ]

  it('rejects empty and whitespace-only names', () => {
    expect(validatePresetName('', one)).toBe('empty')
    expect(validatePresetName('   ', one)).toBe('empty')
  })

  it('rejects duplicates case- and trim-insensitively', () => {
    expect(validatePresetName('Neon', one)).toBe('duplicate')
    expect(validatePresetName('  neon ', one)).toBe('duplicate')
    expect(validatePresetName('Neon 2', one)).toBeNull()
    // A rename may keep its own name.
    expect(validatePresetName('Neon', one, { ignoreId: 'p1' })).toBeNull()
  })

  it('rejects over-long names', () => {
    expect(validatePresetName('x'.repeat(STYLE_PRESET_NAME_MAX_LEN), one)).toBeNull()
    expect(validatePresetName('x'.repeat(STYLE_PRESET_NAME_MAX_LEN + 1), one)).toBe('too-long')
  })

  it('rejects a new preset once the cap is reached, but still allows renames', () => {
    const full: StylePreset[] = Array.from({ length: STYLE_PRESET_MAX }, (_, i) => ({
      id: `p${i}`, name: `n${i}`, version: 1, createdAtMs: i, style: {},
    }))
    expect(validatePresetName('fresh', full)).toBe('cap-reached')
    expect(validatePresetName('renamed', full, { ignoreId: 'p0' })).toBeNull()
  })
})
