import { describe, it, expect } from 'vitest'
import {
  getAlignmentNumpad,
  getAnchorAssPosition,
  pinnedAnchorTransform,
} from '../../src/renderer/lib/preview-coords'

/**
 * REQ-0140 — center alignment for the `verticalPosition` field.
 * These tests pin the numpad mapping, anchor Y computation, and pinned
 * transform for center rows.  Existing top / bottom cases are
 * regression-covered by not being touched (see the ass-generator
 * alignment table which enumerates all 9 numpad cells).
 */

describe('REQ-0140 — getAlignmentNumpad center row → \\an4/5/6', () => {
  it('center × left → 4', () => {
    expect(getAlignmentNumpad('left', 'center')).toBe(4)
  })
  it('center × center → 5', () => {
    expect(getAlignmentNumpad('center', 'center')).toBe(5)
  })
  it('center × right → 6', () => {
    expect(getAlignmentNumpad('right', 'center')).toBe(6)
  })
  it('top / bottom rows unchanged (regression guard)', () => {
    expect(getAlignmentNumpad('left', 'top')).toBe(7)
    expect(getAlignmentNumpad('center', 'top')).toBe(8)
    expect(getAlignmentNumpad('right', 'top')).toBe(9)
    expect(getAlignmentNumpad('left', 'bottom')).toBe(1)
    expect(getAlignmentNumpad('center', 'bottom')).toBe(2)
    expect(getAlignmentNumpad('right', 'bottom')).toBe(3)
  })
})

describe('REQ-0140 — getAnchorAssPosition center row → y at videoHeight/2', () => {
  const W = 1920
  const H = 1080

  it('center row anchors at videoHeight / 2 (marginV ignored)', () => {
    // Regardless of marginV, y = 540 for a 1080p frame.
    expect(getAnchorAssPosition('center', 'center', 0, W, H).y).toBe(540)
    expect(getAnchorAssPosition('center', 'center', 40, W, H).y).toBe(540)
    expect(getAnchorAssPosition('center', 'center', 300, W, H).y).toBe(540)
  })

  it('top / bottom rows still use marginV (regression guard)', () => {
    expect(getAnchorAssPosition('center', 'top', 40, W, H).y).toBe(40)
    expect(getAnchorAssPosition('center', 'bottom', 40, W, H).y).toBe(1040)
  })

  it('horizontal x still uses the ASS_MARGIN_LR / videoWidth split for center-row', () => {
    const left = getAnchorAssPosition('left', 'center', 0, W, H)
    const center = getAnchorAssPosition('center', 'center', 0, W, H)
    const right = getAnchorAssPosition('right', 'center', 0, W, H)
    // Left/right ASS_MARGIN_LR_PX is 40 (constants.ts); center is W/2.
    expect(center.x).toBe(960)
    expect(left.x).toBeGreaterThanOrEqual(0)
    expect(left.x).toBeLessThan(center.x)
    expect(right.x).toBeGreaterThan(center.x)
  })
})

describe('REQ-0140 — pinnedAnchorTransform center row → translate(-*, -50%)', () => {
  it('center-center → translate(-50%, -50%)', () => {
    expect(pinnedAnchorTransform('center', 'center')).toBe('translate(-50%, -50%)')
  })
  it('left-center → translate(0, -50%)', () => {
    expect(pinnedAnchorTransform('left', 'center')).toBe('translate(0, -50%)')
  })
  it('right-center → translate(-100%, -50%)', () => {
    expect(pinnedAnchorTransform('right', 'center')).toBe('translate(-100%, -50%)')
  })

  it('top / bottom rows still get 0 / -100% respectively (regression guard)', () => {
    expect(pinnedAnchorTransform('center', 'top')).toBe('translate(-50%, 0)')
    expect(pinnedAnchorTransform('center', 'bottom')).toBe('translate(-50%, -100%)')
  })
})
