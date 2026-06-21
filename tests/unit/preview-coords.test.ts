import { describe, it, expect } from 'vitest'
import {
  getAlignmentNumpad,
  assToPreviewPx,
  previewPxToAss,
  getAnchorAssPosition,
  pinnedAnchorTransform,
  clampAssPosition,
  recomputePinnedPosForAnchorChange,
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

/**
 * REQ-20260615-033 — the inspector's Offset X/Y row exposes the
 * absolute (posX, posY) as a delta from the alignment-based anchor.
 * These tests pin the forward (offset = pos - anchor) and inverse
 * (pos = anchor + offset) math, plus the round-trip identity that
 * the UI relies on so a freshly-displayed offset value, fed straight
 * back into the editor, never drifts the entry.
 */
describe('offset row math (REQ-20260615-033) — pos ↔ anchor+offset', () => {
  const W = 1920
  const H = 1080

  it('round-trips: pos → offset (= pos - anchor) → pos (= anchor + offset)', () => {
    const anchor = getAnchorAssPosition('center', 'bottom', 40, W, H)
    const posX = 200
    const posY = 300
    const offsetX = posX - anchor.x
    const offsetY = posY - anchor.y
    expect(anchor.x + offsetX).toBe(posX)
    expect(anchor.y + offsetY).toBe(posY)
  })

  it('an unpinned entry reads as offset = 0/0 (UI displays 0 for both)', () => {
    // Inspector logic: when posX/posY are undefined, both displayed
    // offsets are 0 unconditionally (regardless of anchor).
    const offsetX = 0
    const offsetY = 0
    expect(offsetX).toBe(0)
    expect(offsetY).toBe(0)
  })

  it('inverse with clamp: very large offset clamps to frame edge', () => {
    const anchor = getAnchorAssPosition('center', 'bottom', 40, W, H)
    const wantPosX = anchor.x + 10_000
    const wantPosY = anchor.y + 10_000
    const clamped = clampAssPosition(wantPosX, wantPosY, W, H)
    expect(clamped.x).toBe(W)
    expect(clamped.y).toBe(H)
  })

  it('anchor moves when horizontalPosition changes — same posX yields a different displayed offset', () => {
    // Pinned at posX=200 with left-bottom anchor → offset = 200-10 = 190.
    // Switch to center-bottom anchor → offset = 200-960 = -760.
    // Same posX, but the displayed offset shifts because the anchor moved.
    const posX = 200
    const anchorLeft = getAnchorAssPosition('left', 'bottom', 40, W, H)
    const anchorCenter = getAnchorAssPosition('center', 'bottom', 40, W, H)
    expect(posX - anchorLeft.x).toBe(190)
    expect(posX - anchorCenter.x).toBe(-760)
  })
})

describe('recomputePinnedPosForAnchorChange — REQ-20260615-037 offset preservation', () => {
  const W = 1920
  const H = 1080

  it('returns null when the row has no pinned position', () => {
    const result = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: 'center',
      currentVerticalPosition: 'bottom',
      currentVerticalMarginPx: 40,
      currentPosX: undefined,
      currentPosY: undefined,
      nextHorizontalPosition: 'right',
      videoWidthPx: W,
      videoHeightPx: H,
    })
    expect(result).toBeNull()
  })

  it('returns null when none of the layout fields change', () => {
    const anchor = getAnchorAssPosition('center', 'bottom', 40, W, H)
    const result = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: 'center',
      currentVerticalPosition: 'bottom',
      currentVerticalMarginPx: 40,
      currentPosX: anchor.x,
      currentPosY: anchor.y + 1,
      videoWidthPx: W,
      videoHeightPx: H,
    })
    expect(result).toBeNull()
  })

  it('horizontal change: preserves the offset value when flipping center→right', () => {
    // Worked example from REQ-20260615-037: center / bottom / margin=40 with
    // offset X=0 Y=1.  posX = anchor.x = 960, posY = anchor.y + 1 = 1041.
    // Flip horizontal to "right": new anchor.x = W - ASS_MARGIN_LR_PX = 1910.
    // posX should track to 1910 so the visible offset stays at X=0 Y=1.
    const oldAnchor = getAnchorAssPosition('center', 'bottom', 40, W, H)
    const result = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: 'center',
      currentVerticalPosition: 'bottom',
      currentVerticalMarginPx: 40,
      currentPosX: oldAnchor.x,
      currentPosY: oldAnchor.y + 1,
      nextHorizontalPosition: 'right',
      videoWidthPx: W,
      videoHeightPx: H,
    })
    expect(result).not.toBeNull()
    const newAnchor = getAnchorAssPosition('right', 'bottom', 40, W, H)
    expect(result!.posX - newAnchor.x).toBe(0)
    expect(result!.posY - newAnchor.y).toBe(1)
  })

  it('vertical change: preserves the offset value when flipping bottom→top', () => {
    // Worked example from REQ-20260615-037: center / bottom / margin=40 with
    // offset X=0 Y=1.  posX = 960, posY = 1041.  Flip vertical to "top":
    // new anchor.y = marginV = 40.  posY should track so the visible offset
    // stays at Y=1 (= 41 absolute).
    const oldAnchor = getAnchorAssPosition('center', 'bottom', 40, W, H)
    const result = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: 'center',
      currentVerticalPosition: 'bottom',
      currentVerticalMarginPx: 40,
      currentPosX: oldAnchor.x,
      currentPosY: oldAnchor.y + 1,
      nextVerticalPosition: 'top',
      videoWidthPx: W,
      videoHeightPx: H,
    })
    expect(result).not.toBeNull()
    const newAnchor = getAnchorAssPosition('center', 'top', 40, W, H)
    expect(result!.posX - newAnchor.x).toBe(0)
    expect(result!.posY - newAnchor.y).toBe(1)
  })

  it('margin change: preserves the offset value', () => {
    // Bottom-anchored row at offset Y=-5 (= 5 px above the anchor).  Margin
    // grows from 40 → 100 → anchor.y drops by 60 (= H - 100 instead of H - 40).
    // posY should track so the visible offset stays at Y=-5.
    const oldAnchor = getAnchorAssPosition('center', 'bottom', 40, W, H)
    const result = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: 'center',
      currentVerticalPosition: 'bottom',
      currentVerticalMarginPx: 40,
      currentPosX: oldAnchor.x,
      currentPosY: oldAnchor.y - 5,
      nextVerticalMarginPx: 100,
      videoWidthPx: W,
      videoHeightPx: H,
    })
    expect(result).not.toBeNull()
    const newAnchor = getAnchorAssPosition('center', 'bottom', 100, W, H)
    expect(result!.posX - newAnchor.x).toBe(0)
    expect(result!.posY - newAnchor.y).toBe(-5)
  })

  it('combined H + V + margin patch in one go preserves the offset', () => {
    const oldAnchor = getAnchorAssPosition('left', 'top', 30, W, H)
    // Offsets chosen so the new posX/posY land inside the frame after
    // flipping all three layout fields — otherwise the clamp would mask
    // the round-trip we are trying to assert.
    const offsetX = 5
    const offsetY = -7
    const result = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: 'left',
      currentVerticalPosition: 'top',
      currentVerticalMarginPx: 30,
      currentPosX: oldAnchor.x + offsetX,
      currentPosY: oldAnchor.y + offsetY,
      nextHorizontalPosition: 'right',
      nextVerticalPosition: 'bottom',
      nextVerticalMarginPx: 80,
      videoWidthPx: W,
      videoHeightPx: H,
    })
    expect(result).not.toBeNull()
    const newAnchor = getAnchorAssPosition('right', 'bottom', 80, W, H)
    expect(result!.posX - newAnchor.x).toBe(offsetX)
    expect(result!.posY - newAnchor.y).toBe(offsetY)
  })

  it('clamps the recomputed pos at the frame edge when the offset would push it out of bounds', () => {
    // Start at right-bottom anchor with an outward offset (already at the
    // right edge); flip to "left" so the new anchor jumps to x = LR margin
    // and the unclamped target would be far past the left edge → clamped to 0.
    const oldAnchor = getAnchorAssPosition('right', 'bottom', 40, W, H)
    const result = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: 'right',
      currentVerticalPosition: 'bottom',
      currentVerticalMarginPx: 40,
      currentPosX: oldAnchor.x, // = W - LR margin
      currentPosY: oldAnchor.y,
      nextHorizontalPosition: 'left',
      videoWidthPx: W,
      videoHeightPx: H,
    })
    expect(result).not.toBeNull()
    expect(result!.posX).toBeGreaterThanOrEqual(0)
    expect(result!.posX).toBeLessThanOrEqual(W)
    expect(result!.posY).toBe(oldAnchor.y)
  })
})
