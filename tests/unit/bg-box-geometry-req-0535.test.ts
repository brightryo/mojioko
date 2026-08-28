/**
 * REQ-0535 — the cue background geometry.
 *
 * The property under test is the one the owner stated: the background must read
 * as ONE uniform layer.  Here that reduces to "no two rectangles overlap, and
 * consecutive ones leave no gap", because a translucent layer painted twice is
 * exactly what produced the reported stripe.
 */
import { describe, it, expect } from 'vitest'
import {
  lineBgRect,
  sealVerticalSeams,
  cueBgRects,
  bgRectsToAssDrawing,
  type BgLine,
  type BgRect,
} from '../../src/shared/bg-box-geometry'

const line = (anchorY: number, textWidthPx = 100, fontSizePx = 60): BgLine =>
  ({ anchorX: 960, anchorY, textWidthPx, fontSizePx })

describe('REQ-0535 — lineBgRect matches the measured libass box', () => {
  // Burned at \fs72 \bord8, all nine \an values: the box is the TEXT box grown
  // by bord on every side, and its height is exactly fontSize + 2*bord.
  it('centre-anchored: the box is centred on the anchor', () => {
    const r = lineBgRect({ anchorX: 960, anchorY: 540, textWidthPx: 126.51, fontSizePx: 72 }, 'center', 'center', 8)
    expect((r.x0 + r.x1) / 2).toBeCloseTo(960, 6)
    expect((r.y0 + r.y1) / 2).toBeCloseTo(540, 6)
    expect(r.y1 - r.y0).toBeCloseTo(72 + 16, 6)
    expect(r.x1 - r.x0).toBeCloseTo(126.51 + 16, 6)
  })

  it('bottom-anchored: the box bottom sits bord BELOW the anchor', () => {
    const r = lineBgRect({ anchorX: 960, anchorY: 540, textWidthPx: 126.51, fontSizePx: 72 }, 'center', 'bottom', 8)
    expect(r.y1).toBeCloseTo(540 + 8, 6)
    expect(r.y0).toBeCloseTo(540 - 72 - 8, 6)
  })

  it('top-left anchored: the box starts bord ABOVE and LEFT of the anchor', () => {
    const r = lineBgRect({ anchorX: 200, anchorY: 100, textWidthPx: 126.51, fontSizePx: 72 }, 'left', 'top', 8)
    expect(r.x0).toBeCloseTo(200 - 8, 6)
    expect(r.y0).toBeCloseTo(100 - 8, 6)
  })

  it('right-anchored: the box right edge sits bord past the anchor', () => {
    const r = lineBgRect({ anchorX: 1800, anchorY: 100, textWidthPx: 126.51, fontSizePx: 72 }, 'right', 'top', 8)
    expect(r.x1).toBeCloseTo(1800 + 8, 6)
  })
})

describe('REQ-0535 — sealVerticalSeams removes overlaps AND gaps', () => {
  /** The property the whole REQ is about. */
  const expectSealed = (rects: readonly BgRect[]) => {
    for (let i = 0; i + 1 < rects.length; i++) {
      expect(rects[i + 1].y0).toBe(rects[i].y1)
    }
  }

  it('OVERLAPPING boxes are cut at the midpoint (this is the reported bug)', () => {
    // Default spacing: boxes overlap by exactly 2*bord.
    const rects = cueBgRects([line(500), line(560)], 'center', 'center', 8)
    expect(rects).toHaveLength(2)
    expectSealed(rects)
    // The seam lands between the two anchors, not at either box's own edge.
    expect(rects[0].y1).toBe(530)
  })

  it('GAPPED boxes are closed at the midpoint (positive line spacing)', () => {
    // Anchors far apart: the natural boxes leave a gap.
    const rects = cueBgRects([line(400), line(520)], 'center', 'center', 8)
    expectSealed(rects)
    expect(rects[0].y1).toBe(460)
  })

  it('three lines seal both seams', () => {
    const rects = cueBgRects([line(400), line(460), line(520)], 'center', 'center', 8)
    expect(rects).toHaveLength(3)
    expectSealed(rects)
  })

  it('the sealed region covers exactly the original outer extent', () => {
    const raw = [line(400), line(460), line(520)].map((l) => lineBgRect(l, 'center', 'center', 8))
    const sealed = sealVerticalSeams(raw)
    expect(sealed[0].y0).toBe(raw[0].y0)
    expect(sealed[sealed.length - 1].y1).toBe(raw[raw.length - 1].y1)
  })

  it('a single line is untouched — there is no seam to seal', () => {
    const raw = [lineBgRect(line(500), 'center', 'center', 8)]
    expect(sealVerticalSeams(raw)).toEqual(raw)
  })

  it('each line keeps its OWN width (the owner chose this over one rectangle)', () => {
    const rects = cueBgRects([line(500, 400), line(560, 80)], 'center', 'center', 8)
    expect(rects[0].x1 - rects[0].x0).toBeCloseTo(400 + 16, 6)
    expect(rects[1].x1 - rects[1].x0).toBeCloseTo(80 + 16, 6)
  })

  it('the shared seam is an integer, so the two edges cannot antialias apart', () => {
    // Fractional anchors: without the shared rounding these would meet at .5
    // and each antialias against it, leaving a hairline.
    const rects = cueBgRects([line(500.3, 100, 61.7), line(559.9, 100, 61.7)], 'center', 'center', 3)
    expect(Number.isInteger(rects[0].y1)).toBe(true)
    expect(rects[1].y0).toBe(rects[0].y1)
  })

  it('lines out of display order are left alone rather than reordered', () => {
    const a: BgRect = { x0: 0, y0: 100, x1: 10, y1: 200 }
    const b: BgRect = { x0: 0, y0: 0, x1: 10, y1: 50 }
    expect(sealVerticalSeams([a, b])).toEqual([a, b])
  })
})

describe('REQ-0535 — the ASS drawing lands where the rectangles are', () => {
  /**
   * Reproduce what libass does with a drawing, using the rule measured in
   * `bg-box-geometry.ts`: the coordinates are placed relative to `\pos`, then
   * the whole shape is shifted by −(bbox size × alignment fraction).
   */
  const render = (body: string, posX: number, posY: number, hFrac: number, vFrac: number) => {
    const n = body.match(/-?\d+/g)!.map(Number)
    const xs: number[] = [], ys: number[] = []
    for (let i = 0; i < n.length; i += 2) { xs.push(n[i]); ys.push(n[i + 1]) }
    const w = Math.max(...xs) - Math.min(...xs)
    const h = Math.max(...ys) - Math.min(...ys)
    return {
      x0: posX + Math.min(...xs) - w * hFrac,
      y0: posY + Math.min(...ys) - h * vFrac,
      x1: posX + Math.max(...xs) - w * hFrac,
      y1: posY + Math.max(...ys) - h * vFrac,
    }
  }

  it('centre-anchored: the shape lands exactly on the rectangles', () => {
    const rects: BgRect[] = [{ x0: 900, y0: 400, x1: 1020, y1: 480 }]
    const body = bgRectsToAssDrawing(rects, 960, 440, 'center', 'center')
    expect(render(body, 960, 440, 0.5, 0.5)).toEqual({ x0: 900, y0: 400, x1: 1020, y1: 480 })
  })

  it('bottom-anchored: same, with the alignment libass applies for \\an2', () => {
    const rects: BgRect[] = [{ x0: 900, y0: 400, x1: 1020, y1: 480 }]
    const body = bgRectsToAssDrawing(rects, 960, 488, 'center', 'bottom')
    expect(render(body, 960, 488, 0.5, 1)).toEqual({ x0: 900, y0: 400, x1: 1020, y1: 480 })
  })

  it('top-left anchored: no alignment shift at all', () => {
    const rects: BgRect[] = [{ x0: 900, y0: 400, x1: 1020, y1: 480 }]
    const body = bgRectsToAssDrawing(rects, 908, 408, 'left', 'top')
    expect(render(body, 908, 408, 0, 0)).toEqual({ x0: 900, y0: 400, x1: 1020, y1: 480 })
  })

  it('★ the seam survives emission — one anchor means one number per edge', () => {
    // Fractional anchors: emitting each rectangle against its OWN line anchor
    // rounded the shared edge two different ways and reopened a 1 px seam.
    const rects = cueBgRects([line(500.4), line(560.4)], 'center', 'center', 3)
    const body = bgRectsToAssDrawing(rects, 500.4, 530.4, 'center', 'center')
    const n = body.match(/-?\d+/g)!.map(Number)
    // Contour 1: m x0 y0 l x1 y0 l x1 y1 l x0 y1  -> y1 at index 5
    // Contour 2 starts at index 8; its y0 is at index 9.
    expect(n[9]).toBe(n[5])
  })

  it('every emitted coordinate is an integer (\\p1 takes no fractions)', () => {
    const rects = cueBgRects([line(500.4, 101.7), line(560.9, 88.3)], 'center', 'bottom', 5)
    const body = bgRectsToAssDrawing(rects, 500.4, 560.9, 'center', 'bottom')
    for (const tok of body.match(/-?\d+(\.\d+)?/g)!) {
      expect(Number.isInteger(Number(tok))).toBe(true)
    }
  })
})
