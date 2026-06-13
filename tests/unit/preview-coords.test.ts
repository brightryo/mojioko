import { describe, it, expect } from 'vitest'
import {
  getAlignmentNumpad,
  assToPreviewPx,
  previewPxToAss,
  getAnchorAssPosition,
  pinnedAnchorTransform,
  clampAssPosition,
} from '../../src/renderer/lib/preview-coords'

/**
 * REQ-20260613-016 Phase 6 — pure coordinate-conversion contract.  These
 * tests pin both the math and the libass alignment semantics so the
 * preview-side drag and the ass-generator side stay in agreement.
 */

describe('getAlignmentNumpad — REQ-20260613-016 補遺 mapping', () => {
  const cases: Array<{
    h: 'left' | 'center' | 'right'
    v: 'top' | 'bottom'
    expected: number
  }> = [
    { h: 'left', v: 'top', expected: 7 },
    { h: 'center', v: 'top', expected: 8 },
    { h: 'right', v: 'top', expected: 9 },
    { h: 'left', v: 'bottom', expected: 1 },
    { h: 'center', v: 'bottom', expected: 2 },
    { h: 'right', v: 'bottom', expected: 3 },
  ]
  for (const { h, v, expected } of cases) {
    it(`${h} × ${v} → ${expected}`, () => {
      expect(getAlignmentNumpad(h, v)).toBe(expected)
    })
  }
})

describe('assToPreviewPx / previewPxToAss — round-trip linearity', () => {
  it('round-trips ASS coords through preview at scale 0.25', () => {
    const ass = 480
    const preview = assToPreviewPx(ass, 0.25)
    expect(preview).toBe(120)
    expect(previewPxToAss(preview, 0.25)).toBe(480)
  })

  it('round-trips for arbitrary float coords', () => {
    const ass = 1337.5
    const scale = 0.1875
    const preview = assToPreviewPx(ass, scale)
    expect(previewPxToAss(preview, scale)).toBeCloseTo(ass, 10)
  })

  it('scale 1 is identity', () => {
    expect(assToPreviewPx(123, 1)).toBe(123)
    expect(previewPxToAss(456, 1)).toBe(456)
  })
})

describe('getAnchorAssPosition — alignment-based anchor', () => {
  const W = 1920
  const H = 1080

  it('bottom-center (the legacy default) sits at video center / bottom-marginV', () => {
    const p = getAnchorAssPosition('center', 'bottom', 40, W, H)
    expect(p.x).toBe(W / 2)
    expect(p.y).toBe(H - 40)
  })

  it('top-left sits at LR margin / top-marginV', () => {
    const p = getAnchorAssPosition('left', 'top', 30, W, H)
    expect(p.x).toBe(10) // ASS_MARGIN_LR_PX
    expect(p.y).toBe(30)
  })

  it('top-right sits at (W - LR margin) / top-marginV', () => {
    const p = getAnchorAssPosition('right', 'top', 50, W, H)
    expect(p.x).toBe(W - 10)
    expect(p.y).toBe(50)
  })

  it('bottom-right sits at (W - LR margin) / (H - marginV)', () => {
    const p = getAnchorAssPosition('right', 'bottom', 60, W, H)
    expect(p.x).toBe(W - 10)
    expect(p.y).toBe(H - 60)
  })

  it('bottom-left sits at LR margin / (H - marginV)', () => {
    const p = getAnchorAssPosition('left', 'bottom', 40, W, H)
    expect(p.x).toBe(10)
    expect(p.y).toBe(H - 40)
  })

  it('top-center sits at video center / marginV', () => {
    const p = getAnchorAssPosition('center', 'top', 25, W, H)
    expect(p.x).toBe(W / 2)
    expect(p.y).toBe(25)
  })
})

describe('pinnedAnchorTransform — CSS translate for each alignment', () => {
  it('top-left → no translation (top-left of box is the anchor)', () => {
    expect(pinnedAnchorTransform('left', 'top')).toBe('translate(0, 0)')
  })

  it('top-center → translate-x -50%', () => {
    expect(pinnedAnchorTransform('center', 'top')).toBe('translate(-50%, 0)')
  })

  it('top-right → translate-x -100%', () => {
    expect(pinnedAnchorTransform('right', 'top')).toBe('translate(-100%, 0)')
  })

  it('bottom-left → translate-y -100%', () => {
    expect(pinnedAnchorTransform('left', 'bottom')).toBe('translate(0, -100%)')
  })

  it('bottom-center → translate(-50%, -100%)', () => {
    expect(pinnedAnchorTransform('center', 'bottom')).toBe('translate(-50%, -100%)')
  })

  it('bottom-right → translate(-100%, -100%)', () => {
    expect(pinnedAnchorTransform('right', 'bottom')).toBe('translate(-100%, -100%)')
  })
})

describe('clampAssPosition — frame-bound clamping', () => {
  const W = 1920
  const H = 1080

  it('inside-frame coords pass through unchanged', () => {
    const p = clampAssPosition(960, 540, W, H)
    expect(p.x).toBe(960)
    expect(p.y).toBe(540)
  })

  it('negative coords clamp to 0', () => {
    const p = clampAssPosition(-50, -100, W, H)
    expect(p.x).toBe(0)
    expect(p.y).toBe(0)
  })

  it('overshooting coords clamp to the right / bottom edge', () => {
    const p = clampAssPosition(W + 100, H + 200, W, H)
    expect(p.x).toBe(W)
    expect(p.y).toBe(H)
  })
})
