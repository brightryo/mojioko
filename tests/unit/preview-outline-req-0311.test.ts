/**
 * REQ-0311 §3 — outline geometry contract for the preview.
 *
 * Pins the two properties the empirical probe established (see
 * `src/renderer/lib/preview-outline.ts` for the measured figures):
 *
 *   1. At fill alpha 100 % the result is byte-for-byte the pre-REQ-0311
 *      behaviour, because that path was measured EXACT against libass and a
 *      regression there would break every existing cue.
 *   2. Below 100 % the visible inward bleed is capped, so hollow text can never
 *      render solid the way it did at bord 12 / 20.
 */
import { describe, it, expect } from 'vitest'
import {
  computePreviewOutline,
  MIN_VISIBLE_OUTLINE_PX,
  MAX_INWARD_BLEED_EM,
} from '../../src/renderer/lib/preview-outline'
import { OUTLINE_THICKNESS_MAX_PX } from '../../src/shared/constants'

/** The shipping formula, kept verbatim as the oracle for the opaque path. */
function legacy(outlineThicknessPx: number, scale: number) {
  const raw = outlineThicknessPx * scale
  const outlinePx = raw > 0 ? Math.max(raw, MIN_VISIBLE_OUTLINE_PX) : 0
  return { outlinePx, strokeWidthPx: outlinePx * 2 }
}

const SCALES = [1, 0.5, 0.25, 0.17]
const FONT_CSS_PX = 207 // fontSizePx 300 x libassScale 0.6906 at scale 1

describe('computePreviewOutline — opaque fill is untouched (REQ-0310 parity preserved)', () => {
  for (const scale of SCALES) {
    for (let bord = 0; bord <= OUTLINE_THICKNESS_MAX_PX; bord++) {
      it(`bord ${bord} @ scale ${scale} matches the legacy formula`, () => {
        const expected = legacy(bord, scale)
        for (const alpha of [100, undefined]) {
          const got = computePreviewOutline({
            outlineThicknessPx: bord,
            scale,
            fontSizeCssPx: FONT_CSS_PX * scale,
            textAlphaPercent: alpha,
          })
          expect(got.outlinePx).toBeCloseTo(expected.outlinePx, 10)
          expect(got.strokeWidthPx).toBeCloseTo(expected.strokeWidthPx, 10)
          expect(got.clamped).toBe(false)
        }
      })
    }
  }
})

describe('computePreviewOutline — the stroke is always exactly 2x the visible band', () => {
  it('holds across the whole domain, so paint-order still leaves outlinePx outward', () => {
    for (const scale of SCALES) {
      for (let bord = 0; bord <= OUTLINE_THICKNESS_MAX_PX; bord++) {
        for (const alpha of [0, 25, 50, 75, 100]) {
          const r = computePreviewOutline({
            outlineThicknessPx: bord,
            scale,
            fontSizeCssPx: FONT_CSS_PX * scale,
            textAlphaPercent: alpha,
          })
          expect(r.strokeWidthPx).toBeCloseTo(r.outlinePx * 2, 10)
        }
      }
    }
  })
})

describe('computePreviewOutline — inward bleed is capped once the fill stops masking', () => {
  const budget = FONT_CSS_PX * MAX_INWARD_BLEED_EM

  it('hollow text keeps its interior open at the widths that used to fill it solid', () => {
    // bord 12 and 20 measured hole = 0px (solid) before this clamp.
    for (const bord of [12, 20]) {
      const r = computePreviewOutline({
        outlineThicknessPx: bord,
        scale: 1,
        fontSizeCssPx: FONT_CSS_PX,
        textAlphaPercent: 0,
      })
      expect(r.clamped).toBe(true)
      expect(r.outlinePx).toBeLessThan(bord)
      // Two inward halves must not meet across a ~0.1em stem.
      expect(r.outlinePx * 2).toBeLessThan(FONT_CSS_PX * 0.1)
    }
  })

  it('leaves thin outlines alone — they never closed the interior', () => {
    for (const bord of [1, 2, 5]) {
      const r = computePreviewOutline({
        outlineThicknessPx: bord,
        scale: 1,
        fontSizeCssPx: FONT_CSS_PX,
        textAlphaPercent: 0,
      })
      expect(r.clamped).toBe(false)
      expect(r.outlinePx).toBeCloseTo(bord, 10)
    }
  })

  it('is monotonic in alpha — dragging the opacity slider never jumps', () => {
    let prev = -Infinity
    for (let alpha = 0; alpha <= 100; alpha += 5) {
      const r = computePreviewOutline({
        outlineThicknessPx: 20,
        scale: 1,
        fontSizeCssPx: FONT_CSS_PX,
        textAlphaPercent: alpha,
      })
      expect(r.outlinePx).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = r.outlinePx
    }
    // and lands exactly on the unclamped value at the top of the range
    expect(prev).toBeCloseTo(20, 10)
  })

  it('never clamps below the visibility floor', () => {
    const r = computePreviewOutline({
      outlineThicknessPx: OUTLINE_THICKNESS_MAX_PX,
      scale: 0.05,
      fontSizeCssPx: 4, // absurdly small preview -> tiny budget
      textAlphaPercent: 0,
    })
    expect(r.outlinePx).toBeGreaterThanOrEqual(MIN_VISIBLE_OUTLINE_PX)
  })

  it('caps the visible inward bleed at the budget wherever it engages', () => {
    for (const alpha of [0, 20, 40, 60, 80]) {
      const r = computePreviewOutline({
        outlineThicknessPx: 20,
        scale: 1,
        fontSizeCssPx: FONT_CSS_PX,
        textAlphaPercent: alpha,
      })
      if (!r.clamped) continue
      const unmasked = 1 - alpha / 100
      expect(r.outlinePx * unmasked).toBeLessThanOrEqual(budget + 1e-9)
    }
  })

  it('bord 0 stays fully off', () => {
    const r = computePreviewOutline({
      outlineThicknessPx: 0, scale: 1, fontSizeCssPx: FONT_CSS_PX, textAlphaPercent: 0,
    })
    expect(r).toEqual({ outlinePx: 0, strokeWidthPx: 0, clamped: false })
  })
})
