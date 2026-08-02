import { describe, it, expect } from 'vitest'
import { computeCuePlacement, alignmentNumpad } from '../../src/shared/cue-placement'
import { cueLineAnchors, lineHeightsAssPx, type CueLineAnchorInput } from '../../src/shared/line-spacing'

/**
 * REQ-0389 (positioning-redesign Phase 1a) — `computeCuePlacement` is the single
 * positioning authority.  Its Phase 1a exit criterion (spec §10-6.1) is that it
 * reproduces the validated anchor math **by value**: since it wraps
 * `cueLineAnchors`, `lines[i].{anchorX, anchorY}` must equal
 * `cueLineAnchors(sameInput)[i].{x, y}` for every input.  These tests pin that
 * equivalence across a matrix, plus the neutral-space fields it adds (`an`, the
 * detection box, `layer`).
 */

const H = ['left', 'center', 'right'] as const
const V = ['top', 'center', 'bottom'] as const

/** Build a CueLineAnchorInput with `n` uniform lines of `fs`(+spacing) height. */
function anchorInput(
  n: number,
  fs: number,
  percent: number,
  h: (typeof H)[number],
  v: (typeof V)[number],
  over: Partial<CueLineAnchorInput> = {},
): CueLineAnchorInput {
  return {
    lineHeightsPx: lineHeightsAssPx(Array.from({ length: n }, () => fs), percent),
    horizontalPosition: h,
    verticalPosition: v,
    verticalMarginPx: 40,
    centerOffsetPx: 0,
    playResX: 1920,
    playResY: 1080,
    marginLrPx: 10,
    ...over,
  }
}

describe('REQ-0389 — alignmentNumpad matches the libass numpad convention', () => {
  it('maps every (h, v) pair to the documented 1–9 value', () => {
    expect(alignmentNumpad('left', 'bottom')).toBe(1)
    expect(alignmentNumpad('center', 'bottom')).toBe(2)
    expect(alignmentNumpad('right', 'bottom')).toBe(3)
    expect(alignmentNumpad('left', 'center')).toBe(4)
    expect(alignmentNumpad('center', 'center')).toBe(5)
    expect(alignmentNumpad('right', 'center')).toBe(6)
    expect(alignmentNumpad('left', 'top')).toBe(7)
    expect(alignmentNumpad('center', 'top')).toBe(8)
    expect(alignmentNumpad('right', 'top')).toBe(9)
  })
})

describe('REQ-0389 — computeCuePlacement reproduces cueLineAnchors by value', () => {
  it('lines equal cueLineAnchors across an alignment × line-count × spacing matrix', () => {
    for (const h of H) {
      for (const v of V) {
        for (const n of [1, 2, 3]) {
          for (const percent of [-50, 0, 100]) {
            for (const fs of [73, 100, 150]) {
              const input = anchorInput(n, fs, percent, h, v)
              const anchors = cueLineAnchors(input)
              const placement = computeCuePlacement({ ...input, outlineThicknessPx: 3 })
              expect(placement.lines).toHaveLength(anchors.length)
              placement.lines.forEach((line, i) => {
                expect(line.anchorX).toBe(anchors[i].x)
                expect(line.anchorY).toBe(anchors[i].y)
                expect(line.an).toBe(alignmentNumpad(h, v))
              })
            }
          }
        }
      }
    }
  })

  it('honours a pinned position exactly as cueLineAnchors does', () => {
    const input = anchorInput(2, 100, 0, 'center', 'bottom', { posX: 500, posY: 800 })
    const anchors = cueLineAnchors(input)
    const placement = computeCuePlacement({ ...input, outlineThicknessPx: 6 })
    placement.lines.forEach((line, i) => {
      expect(line.anchorX).toBe(anchors[i].x)
      expect(line.anchorY).toBe(anchors[i].y)
    })
    // A pinned cue's box collapses horizontally onto the pin (no width measured).
    expect(placement.box.left).toBe(500)
    expect(placement.box.right).toBe(500)
  })
})

describe('REQ-0389 — single-line reductions (the base case of the derivation)', () => {
  it('bottom: the line anchor sits at playResY − marginV', () => {
    const p = computeCuePlacement({ ...anchorInput(1, 100, 0, 'center', 'bottom'), outlineThicknessPx: 3 })
    expect(p.lines).toHaveLength(1)
    expect(p.lines[0].anchorY).toBe(1080 - 40)
    expect(p.lines[0].anchorX).toBe(1920 / 2)
    expect(p.lines[0].an).toBe(2)
  })

  it('top: the line anchor sits at marginV', () => {
    const p = computeCuePlacement({ ...anchorInput(1, 100, 0, 'left', 'top'), outlineThicknessPx: 3 })
    expect(p.lines[0].anchorY).toBe(40)
    expect(p.lines[0].anchorX).toBe(10)
    expect(p.lines[0].an).toBe(7)
  })

  it('center: the line anchor sits at playResY / 2', () => {
    const p = computeCuePlacement({ ...anchorInput(1, 100, 0, 'right', 'center'), outlineThicknessPx: 3 })
    expect(p.lines[0].anchorY).toBe(1080 / 2)
    expect(p.lines[0].anchorX).toBe(1920 - 10)
    expect(p.lines[0].an).toBe(6)
  })
})

describe('REQ-0389 — detection box vertical extent', () => {
  it('bottom cue: box spans one line height above the anchor, padded by outline', () => {
    const outline = 3
    const p = computeCuePlacement({ ...anchorInput(1, 100, 0, 'center', 'bottom'), outlineThicknessPx: outline })
    // an2 anchors the bottom edge; the line box is [y − h, y], padded ± outline.
    expect(p.box.bottom).toBe(1080 - 40 + outline)
    expect(p.box.top).toBe(1080 - 40 - 100 - outline)
    // Horizontal band = usable content width (no text measurement).
    expect(p.box.left).toBe(10)
    expect(p.box.right).toBe(1920 - 10)
  })

  it('two-line cue box grows by the extra line height', () => {
    const one = computeCuePlacement({ ...anchorInput(1, 100, 0, 'center', 'bottom'), outlineThicknessPx: 0 })
    const two = computeCuePlacement({ ...anchorInput(2, 100, 0, 'center', 'bottom'), outlineThicknessPx: 0 })
    expect(two.box.bottom - two.box.top).toBeCloseTo(one.box.bottom - one.box.top + 100, 6)
  })
})

describe('REQ-0389 — layer passthrough (z-order, spec decision E)', () => {
  it('defaults to 0 and carries an explicit layer through', () => {
    expect(computeCuePlacement({ ...anchorInput(1, 100, 0, 'center', 'bottom'), outlineThicknessPx: 3 }).layer).toBe(0)
    expect(
      computeCuePlacement({ ...anchorInput(1, 100, 0, 'center', 'bottom'), outlineThicknessPx: 3, layer: 4 }).layer,
    ).toBe(4)
  })
})
