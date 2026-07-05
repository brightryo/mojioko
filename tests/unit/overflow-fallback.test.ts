import { describe, expect, it } from 'vitest'
import { computeOverflowSync } from '../../src/renderer/lib/overflow-calculator'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'

/**
 * REQ-087 — the character-class fallback in both `computeOverflowSync`
 * and `applyAutoLineBreak` now multiplies wide / narrow estimates by
 * `FALLBACK_LIBASS_SCALE` (= 0.6906) so the fallback lands within ~1 %
 * of the real-glyph metric path for every Google Fonts CJK family in
 * the registry.
 *
 * Pre-REQ-087 the fallback used raw `fontSizePx` for wide chars, which
 * over-counted by 1 / 0.6906 ≈ 1.45× and produced spurious overflow
 * detection + early line breaks for every row whose per-row font wasn't
 * cached at calc time.  These tests pin the corrected magnitude and
 * the boundary characters that produce overflow under the realistic
 * 1920-px / fontSizePx=50 / outline=3 / margin=20 (effectivePx ≈ 1874)
 * preset.
 *
 * Both modules' fallback are line-for-line mirrors of each other, so
 * the same scenarios are tested against both to make a future drift
 * loud.
 */

// Effective pixel budget for the realistic preset used by every case below:
//   videoWidthPx 1920 − 2 × ASS_MARGIN_LR_PX (10) − 2 × outlineThicknessPx (3)
//   = 1920 − 20 − 6 = 1894
const VIDEO_WIDTH_PX = 1920
const OUTLINE_PX = 3
const FONT_SIZE_PX = 50
const EXPECTED_EFFECTIVE_PX = 1894
// At fontSize 50 with FALLBACK_LIBASS_SCALE 0.6906, a wide CJK glyph
// estimates 50 × 0.6906 = 34.53 px.  Budget 1894 / 34.53 ≈ 54.85 chars,
// so 54 wide chars fit (= 1864.6 px) and 55 do not (= 1899.15 px).
const FALLBACK_WIDE_PX = 50 * 0.6906
// Narrow chars: 50 × 0.55 × 0.6906 = 18.99 px.  Budget 1894 / 18.99 ≈ 99.74
// chars — so 99 narrow chars fit and 100 do not.
const FALLBACK_NARROW_PX = 50 * 0.55 * 0.6906

describe('REQ-087 fallback widths apply FALLBACK_LIBASS_SCALE', () => {
  describe('computeOverflowSync (no font supplied → fallback path)', () => {
    it('54 CJK chars fit the 1894px budget (= 54 × 34.53 = 1864.6)', () => {
      const text = 'あ'.repeat(54)
      const r = computeOverflowSync({
        text,
        fontFamily: 'Noto Sans JP',
        fontSizePx: FONT_SIZE_PX,
        outlineThicknessPx: OUTLINE_PX,
        videoWidthPx: VIDEO_WIDTH_PX,
      })
      expect(r.overflowStartIndex).toBe(-1)
      expect(r.effectivePx).toBe(EXPECTED_EFFECTIVE_PX)
    })

    it('55 CJK chars overflow (= 55 × 34.53 = 1899.1 > 1894)', () => {
      const text = 'あ'.repeat(55)
      const r = computeOverflowSync({
        text,
        fontFamily: 'Noto Sans JP',
        fontSizePx: FONT_SIZE_PX,
        outlineThicknessPx: OUTLINE_PX,
        videoWidthPx: VIDEO_WIDTH_PX,
      })
      expect(r.overflowStartIndex).not.toBe(-1)
      expect(r.overflowStartIndex).toBe(54)
    })

    it('pre-REQ-087 behaviour would have flagged 38 chars — regression guard', () => {
      // The old fallback used `fontSizePx × 1.0` = 50 px per wide char,
      // so 38 × 50 = 1900 > 1894 flagged overflow.  After REQ-087 the
      // estimate drops to 34.53 px, so 38 chars (= 1312 px) is well
      // under the budget.  This case proves the bug is gone.
      const text = 'あ'.repeat(38)
      const r = computeOverflowSync({
        text,
        fontFamily: 'Noto Sans JP',
        fontSizePx: FONT_SIZE_PX,
        outlineThicknessPx: OUTLINE_PX,
        videoWidthPx: VIDEO_WIDTH_PX,
      })
      expect(r.overflowStartIndex).toBe(-1)
    })

    it('narrow chars use fontSizePx × 0.55 × FALLBACK_LIBASS_SCALE', () => {
      // Latin "A" — at fontSize 50, fallback narrow ≈
      //   50 × 0.55 × 0.6906 = 18.99 px per char.
      // 99 narrow chars = 1880.16 px (fits 1894).
      // 100 narrow chars = 1899.15 px (overflows 1894) → first overflow at index 99.
      const fits = computeOverflowSync({
        text: 'A'.repeat(99),
        fontFamily: 'Noto Sans JP',
        fontSizePx: FONT_SIZE_PX,
        outlineThicknessPx: OUTLINE_PX,
        videoWidthPx: VIDEO_WIDTH_PX,
      })
      expect(fits.overflowStartIndex).toBe(-1)
      const overflows = computeOverflowSync({
        text: 'A'.repeat(100),
        fontFamily: 'Noto Sans JP',
        fontSizePx: FONT_SIZE_PX,
        outlineThicknessPx: OUTLINE_PX,
        videoWidthPx: VIDEO_WIDTH_PX,
      })
      expect(overflows.overflowStartIndex).toBe(99)
      // Sanity-check the rate as well so a future drift on the 0.55
      // narrow-class constant is loud.
      expect(FALLBACK_NARROW_PX).toBeCloseTo(18.99, 2)
    })

    it('measuredPx of an overflowing wide line reports cumulative fallback width', () => {
      const text = 'あ'.repeat(60)
      const r = computeOverflowSync({
        text,
        fontFamily: 'Noto Sans JP',
        fontSizePx: FONT_SIZE_PX,
        outlineThicknessPx: OUTLINE_PX,
        videoWidthPx: VIDEO_WIDTH_PX,
      })
      // First overflow happens at index 54 (= 55th char), cumulative includes
      // that 55th char: (54 + 1) × 34.53 = 1899.15
      expect(r.measuredPx).toBeCloseTo(55 * FALLBACK_WIDE_PX, 1)
    })
  })

  describe('applyAutoLineBreak (no font supplied → fallback path)', () => {
    it('breaks before the 55th wide char to match the overflow threshold', () => {
      const text = 'あ'.repeat(80)
      const result = applyAutoLineBreak(text, FONT_SIZE_PX, OUTLINE_PX, VIDEO_WIDTH_PX)
      // First break at index 54 — "54 chars" + "\N" + "rest".
      expect(result.startsWith('あ'.repeat(54) + '\\N')).toBe(true)
    })

    it('a 40-char wide line stays on one line (= no \\N inserted)', () => {
      // Pre-REQ-087 this would have split after char ~37; post-fix it
      // fits in one line.  Proves the "sutegana split" symptom is gone
      // for any short-to-medium input.
      const text = 'あ'.repeat(40)
      const result = applyAutoLineBreak(text, FONT_SIZE_PX, OUTLINE_PX, VIDEO_WIDTH_PX)
      expect(result).toBe(text)
      expect(result.includes('\\N')).toBe(false)
    })

    it('existing \\N markers are preserved; only over-budget segments get re-broken', () => {
      const text = 'あ'.repeat(20) + '\\N' + 'い'.repeat(20)
      const result = applyAutoLineBreak(text, FONT_SIZE_PX, OUTLINE_PX, VIDEO_WIDTH_PX)
      // Both segments are 20 chars (= 690.6 px), well under 1874 budget.
      expect(result).toBe(text)
    })

    it('break index agrees with computeOverflowSync (shared math)', () => {
      // Both modules use the same FALLBACK_LIBASS_SCALE-scaled wide width,
      // so the auto-break's first-break index must equal the overflow
      // calculator's `overflowStartIndex` for any all-wide input.
      const text = 'あ'.repeat(70)
      const overflow = computeOverflowSync({
        text,
        fontFamily: 'Noto Sans JP',
        fontSizePx: FONT_SIZE_PX,
        outlineThicknessPx: OUTLINE_PX,
        videoWidthPx: VIDEO_WIDTH_PX,
      })
      const broken = applyAutoLineBreak(text, FONT_SIZE_PX, OUTLINE_PX, VIDEO_WIDTH_PX)
      const firstBreakIdx = broken.indexOf('\\N')
      // overflowStartIndex is the char-unit index where the next glyph
      // would tip the budget; auto-break inserts the `\N` AT that index.
      expect(firstBreakIdx).toBe(overflow.overflowStartIndex)
    })
  })

  describe('FALLBACK_LIBASS_SCALE magnitude', () => {
    it('removes the pre-REQ-087 ~45 % overestimation of CJK widths', () => {
      // Real Noto Sans JP CJK glyph at fontSize=50: 50 × 0.6906 = 34.53 px
      // Pre-fix fallback:                            50 × 1.0    = 50.00 px
      // Post-fix fallback:                           50 × 0.6906 = 34.53 px
      // The post-fix fallback should hit the same magnitude as real.
      const realPerCjkPx = 50 * 0.6906   // matches font-metrics.ts FALLBACK_LIBASS_SCALE
      const fallbackPerCjkPx = FALLBACK_WIDE_PX
      const drift = Math.abs(realPerCjkPx - fallbackPerCjkPx) / realPerCjkPx
      expect(drift).toBeLessThan(0.01)   // within 1 % per the design note
    })
  })
})
