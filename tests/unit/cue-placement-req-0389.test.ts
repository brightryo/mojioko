import { describe, it, expect } from 'vitest'
import {
  computeCuePlacement,
  alignmentNumpad,
  bringToFrontLayer,
  sendToBackLayer,
  MIN_LAYER,
  MAX_LAYER,
} from '../../src/shared/cue-placement'
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

describe('REQ-0397 §1 — z-order front/back arithmetic clamps at MIN_LAYER (0)', () => {
  it('MIN_LAYER is 0', () => {
    expect(MIN_LAYER).toBe(0)
  })

  it('bring to front = max + 1', () => {
    expect(bringToFrontLayer([0, 0, 0])).toBe(1)
    expect(bringToFrontLayer([0, 2, 1])).toBe(3)
    expect(bringToFrontLayer([5])).toBe(6)
  })

  it('send to back never goes negative — floors at 0', () => {
    // All-layer-0 project: send-to-back resolves to 0 (a no-op the caller drops).
    expect(sendToBackLayer([0, 0, 0])).toBe(0)
    // A single layer-0 cue: still 0, not -1.
    expect(sendToBackLayer([0])).toBe(0)
    // Mixed with a 0 present: one-below-min would be -1 → floored to 0.
    expect(sendToBackLayer([0, 2, 3])).toBe(0)
  })

  it('send to back = min - 1 when that stays ≥ 0', () => {
    // Backmost cue sits at layer 2 → sending another behind it lands on layer 1.
    expect(sendToBackLayer([2, 3])).toBe(1)
    expect(sendToBackLayer([1, 4, 7])).toBe(0)
  })

  it('a legacy negative layer does not drag new send-to-back below 0', () => {
    // Even if an old project carries a -1, the clamp keeps new writes ≥ 0.
    expect(sendToBackLayer([-1, 0, 1])).toBe(0)
  })
})

describe('REQ-0398 §2 — z-order caps at MAX_LAYER (50)', () => {
  it('MAX_LAYER is 50', () => {
    expect(MAX_LAYER).toBe(50)
  })

  it('bring to front never exceeds MAX_LAYER', () => {
    // At the cap: front resolves to 50, not 51 (the caller no-ops on equality).
    expect(bringToFrontLayer([50])).toBe(MAX_LAYER)
    expect(bringToFrontLayer([48, 50, 49])).toBe(MAX_LAYER)
    // A legacy over-cap layer still clamps a NEW front down to 50.
    expect(bringToFrontLayer([9999])).toBe(MAX_LAYER)
  })

  it('bring to front is still max + 1 below the cap', () => {
    expect(bringToFrontLayer([0])).toBe(1)
    expect(bringToFrontLayer([10, 3])).toBe(11)
    expect(bringToFrontLayer([48])).toBe(49)
    expect(bringToFrontLayer([49])).toBe(MAX_LAYER)
  })
})
