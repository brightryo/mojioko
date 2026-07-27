/**
 * REQ-0313 — outline ring geometry.
 *
 * The pixel-accurate half of this feature (does the ring sit on the glyphs, is
 * it as thick as libass) can only be answered in a real browser against a real
 * burn-in, and was measured that way — see RES-0313.  What is pinned here is
 * the pure geometry the drawing depends on, where a regression would silently
 * clip the ring or misplace the canvas.
 */
import { describe, it, expect } from 'vitest'
import {
  computeRingBox,
  applyTextTransform,
  type MeasuredRun,
  type RunExtent,
} from '../../src/renderer/lib/outline-ring'
import { OUTLINE_THICKNESS_MAX_PX } from '../../src/shared/constants'

const run = (x: number, baselineY: number): MeasuredRun => ({
  text: 'x',
  font: '600 20px sans-serif',
  x,
  baselineY,
})
const ext = (top: number, bottom: number, width: number): RunExtent => ({ top, bottom, width })

describe('computeRingBox', () => {
  it('covers the ring on every side', () => {
    const box = computeRingBox([run(100, 50)], [ext(30, 60, 40)], 8)!
    expect(box).not.toBeNull()
    // The ink spans x 100..140, y 30..60; the ring adds 8 in each direction.
    expect(box.left).toBeLessThanOrEqual(100 - 8)
    expect(box.top).toBeLessThanOrEqual(30 - 8)
    expect(box.left + box.width).toBeGreaterThanOrEqual(140 + 8)
    expect(box.top + box.height).toBeGreaterThanOrEqual(60 + 8)
  })

  it('extends down-right for the shadow, matching libass shadow direction', () => {
    const noShadow = computeRingBox([run(100, 50)], [ext(30, 60, 40)], 4, 0)!
    const withShadow = computeRingBox([run(100, 50)], [ext(30, 60, 40)], 4, 10)!
    expect(withShadow.left).toBe(noShadow.left)
    expect(withShadow.top).toBe(noShadow.top)
    expect(withShadow.left + withShadow.width).toBeGreaterThanOrEqual(
      noShadow.left + noShadow.width + 10,
    )
    expect(withShadow.top + withShadow.height).toBeGreaterThanOrEqual(
      noShadow.top + noShadow.height + 10,
    )
  })

  /**
   * REQ-0314 §2 — the shadow must not be gated on the outline width.  Before
   * REQ-0313 the shadow was a CSS `text-shadow`, independent of `ord`, and
   * libass keeps `\shad` and `ord` independent too.  Measured: at bord 0 the
   * preview draws 4576 shadow px and libass 4751, so both still render.
   */
  it('still reserves room for the shadow when the outline is 0', () => {
    const box = computeRingBox([run(100, 50)], [ext(30, 60, 40)], 0, 12)!
    expect(box).not.toBeNull()
    expect(box.left + box.width).toBeGreaterThanOrEqual(140 + 12)
    expect(box.top + box.height).toBeGreaterThanOrEqual(60 + 12)
    // and it is genuinely bigger than the no-shadow, no-outline case
    const bare = computeRingBox([run(100, 50)], [ext(30, 60, 40)], 0, 0)!
    expect(box.width).toBeGreaterThan(bare.width)
    expect(box.height).toBeGreaterThan(bare.height)
  })

  it('spans every run — multi-line and mixed emphasis sizes', () => {
    // Two lines; the second run is an emphasised (larger) run on line 1.
    const runs = [run(10, 40), run(60, 40), run(10, 120)]
    const extents = [ext(20, 45, 40), ext(5, 50, 55), ext(100, 125, 80)]
    const box = computeRingBox(runs, extents, 6)!
    expect(box.left).toBeLessThanOrEqual(10 - 6)
    expect(box.top).toBeLessThanOrEqual(5 - 6)
    expect(box.left + box.width).toBeGreaterThanOrEqual(115 + 6)
    expect(box.top + box.height).toBeGreaterThanOrEqual(125 + 6)
  })

  it('grows monotonically with the outline width across the whole range', () => {
    let prevW = -1
    let prevH = -1
    for (let bord = 0; bord <= OUTLINE_THICKNESS_MAX_PX; bord++) {
      const box = computeRingBox([run(100, 50)], [ext(30, 60, 40)], bord)!
      expect(box.width).toBeGreaterThanOrEqual(prevW)
      expect(box.height).toBeGreaterThanOrEqual(prevH)
      prevW = box.width
      prevH = box.height
    }
  })

  it('returns null when there is nothing to draw', () => {
    expect(computeRingBox([], [], 8)).toBeNull()
    // Defensive: mismatched arrays would otherwise index past the end.
    expect(computeRingBox([run(0, 0)], [], 8)).toBeNull()
  })

  it('never produces a negative size', () => {
    const box = computeRingBox([run(0, 0)], [ext(0, 0, 0)], 0)!
    expect(box.width).toBeGreaterThanOrEqual(0)
    expect(box.height).toBeGreaterThanOrEqual(0)
  })
})

describe('applyTextTransform — the one thing the DOM does not hand over', () => {
  // The text node keeps its original casing while the rendering is uppercased,
  // so the ring would trace the wrong glyph advances without this.
  it('uppercases to match `text-transform: uppercase` (REQ-0277 §1)', () => {
    expect(applyTextTransform('hello', 'uppercase')).toBe('HELLO')
  })

  it('leaves text alone for none/normal', () => {
    expect(applyTextTransform('hello', 'none')).toBe('hello')
    expect(applyTextTransform('hello', '')).toBe('hello')
  })

  it('passes CJK through unchanged — it has no case', () => {
    expect(applyTextTransform('こんにちは', 'uppercase')).toBe('こんにちは')
  })

  it('handles lowercase', () => {
    expect(applyTextTransform('HELLO', 'lowercase')).toBe('hello')
  })
})
