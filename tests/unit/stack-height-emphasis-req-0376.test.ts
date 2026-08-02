import { describe, it, expect } from 'vitest'
import { estimateCueHeightAssPx } from '../../src/shared/line-spacing'
import { cueMaxRenderedFontAssPx } from '../../src/shared/emphasis'

/**
 * REQ-0376 §A — the cue-between stack height must account for keyword emphasis,
 * because libass `fix_collisions` reserves space for the ACTUAL rendered
 * bitmap.  Measured directly (hand-authored ASS burned + rgb24 frame extract,
 * see scripts/verify-stack-emphasis): a base `\fs160` cue with a `\fs240`
 * emphasised run pushed the cue above it exactly 80 px (= 240 − 160) higher
 * than the same cue with no emphasis — i.e. libass's reserved height is
 * `maxRenderedFont + 2·outline`, not `baseFont + 2·outline`.
 *
 * Before the fix, `estimateCueHeightAssPx` used the base font, so the preview
 * (and the self-positioned burn path) under-stacked overlapping emphasised
 * cues and disagreed with the ordinary burn (real libass).  These pins keep
 * the estimate tied to that measurement.
 */
const BASE = 160
const OUTLINE = 4

// A single-line cue geometry helper (line-spacing default = 0 %).
const geom = (fontSizePx: number) => ({
  text: 'AA BIG CC',
  fontSizePx: BASE,
  outlineThicknessPx: OUTLINE,
  // maxFontPx carries the emphasis-aware size; entry.fontSizePx stays base.
  _maxFont: fontSizePx,
})

// A cue-shaped object for cueMaxRenderedFontAssPx.
const cue = (over: Record<string, unknown> = {}) => ({
  text: 'AA BIG CC',
  fontSizePx: BASE,
  keywordEmphasisEnabled: true,
  emphasisScalePercent: 150, // 160 → 240
  emphasisKeywords: ['BIG'],
  ...over,
})

describe('cueMaxRenderedFontAssPx (REQ-0376 §A)', () => {
  it('returns the enlarged font when emphasis is on, tier-allowed, and a range resolves', () => {
    expect(cueMaxRenderedFontAssPx(cue(), true)).toBe(240)
  })
  it('returns the base font when emphasis is disabled on the cue', () => {
    expect(cueMaxRenderedFontAssPx(cue({ keywordEmphasisEnabled: false }), true)).toBe(BASE)
  })
  it('returns the base font in the free tier even if the cue enables emphasis', () => {
    expect(cueMaxRenderedFontAssPx(cue(), false)).toBe(BASE)
  })
  it('returns the base font when no keyword actually matches (no ranges)', () => {
    expect(cueMaxRenderedFontAssPx(cue({ emphasisKeywords: ['ZZZ'] }), true)).toBe(BASE)
  })
  it('never lowers the height for a shrunk emphasis span (< 100 %)', () => {
    expect(cueMaxRenderedFontAssPx(cue({ emphasisScalePercent: 50 }), true)).toBe(BASE)
  })
  it('rounds the scaled size exactly like the ASS emit path', () => {
    // 160 * 130% = 208
    expect(cueMaxRenderedFontAssPx(cue({ emphasisScalePercent: 130 }), true)).toBe(208)
  })
})

describe('estimateCueHeightAssPx emphasis-awareness (REQ-0376 §A)', () => {
  it('matches the measured libass reservation: maxFont + 2·outline', () => {
    // emphasised: 240 + 2*4 = 248 (the measured collision height)
    expect(estimateCueHeightAssPx(geom(240), 240)).toBe(248)
    // nominal: 160 + 2*4 = 168
    expect(estimateCueHeightAssPx(geom(160))).toBe(168)
  })

  it('the fixed vs nominal delta equals the measured +80 px libass push', () => {
    const fixed = estimateCueHeightAssPx(geom(240), 240)
    const nominal = estimateCueHeightAssPx(geom(160))
    expect(fixed - nominal).toBe(80) // == 240 − 160, matching the burn measurement
  })

  it('is byte-identical (reduces to the original) with no maxFontPx / no emphasis', () => {
    // Omitting maxFontPx must equal passing the base font — the non-emphasis path.
    const g = { text: 'one\\Ntwo', fontSizePx: 100, outlineThicknessPx: 3 }
    expect(estimateCueHeightAssPx(g)).toBe(estimateCueHeightAssPx(g, 100))
    // two lines, 0% spacing: (2-1)*100 + 100 + 2*3 = 206
    expect(estimateCueHeightAssPx(g)).toBe(206)
  })
})
