import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  lineSpacingFactor,
  LINE_SPACING_MIN_PERCENT,
  LINE_SPACING_MAX_PERCENT,
  LINE_SPACING_DEFAULT_PERCENT,
} from '../../src/shared/line-spacing'

/**
 * REQ-0324 §4-2 — pin the libassScale cancellation that
 * `estimateOverlayHeightPx` silently depends on.
 * REQ-0332 §4 — GENERALISED to line spacing (the REQ is explicit that this
 * must be widened, not weakened).
 *
 * ## The invariant
 *
 *   CSS font-size   = entry.fontSizePx × libassScale × scale
 *   CSS line-height = (1 / libassScale) × lineSpacingFactor(spacing)
 *   ⇒ rendered line box = entry.fontSizePx × scale × lineSpacingFactor(spacing)
 *
 * `estimateOverlayHeightPx` returns `lineCount × <that line box>` and feeds
 * `computeFixedStackOffsets`, which positions stacked cues in the preview
 * AND — since REQ-0332 — in the burn-in whenever a cue is split.  It is
 * correct ONLY because libassScale cancels between those two lines.  Change
 * either one alone and every stack offset silently shifts — RES-0322 §1-4
 * measured the damage at a uniform 30.94 % (fs=150 / 3 lines / 3rd row:
 * 183.20px → 126.52px).
 *
 * Line spacing is a NEW way to break it: it multiplies the line box, so it
 * has to appear on the line-height side and in the height estimator and
 * NOWHERE ELSE.  Put it on the font-size side instead and the glyphs would
 * grow rather than the gap; put it in only one of the two consumers and the
 * preview and the burn-in disagree — which is the REQ-0320 §1 failure shape
 * this REQ was told to avoid.
 *
 * ## Why this test exists rather than relying on the existing gate
 *
 * RES-0322 §1-5 declined to add a test, arguing `verify:outline-ring`
 * plus the overlay suite would catch a one-sided change.  **That was
 * wrong, and REQ-0324 §4-2 is right to correct it.**  The ring gate
 * compares the canvas ring against the DOM glyphs — and BOTH are derived
 * from the same rendered DOM.  Change `line-height` and the glyphs move,
 * the ring measurement moves with them, and the gate still reports
 * 0.000px.  It is structurally blind to this invariant.  Nothing else
 * covered it either, so a one-sided edit would have shipped.
 *
 * ## Why this asserts source text rather than numbers
 *
 * The REQ is explicit: do not write new numbers.  A test asserting
 * "line box = 8.000px at fs=40" would be a third place the relationship
 * is encoded, and a third thing to update.  Instead this reads the two
 * expressions out of the component and checks that they are reciprocal in
 * `libassScale` — the RELATIONSHIP, not the values.  Retune
 * `FALLBACK_LIBASS_SCALE` or the font metrics and this test does not
 * care; break the reciprocity and it fails.  REQ-0332 keeps that property:
 * the spacing factor is taken from the shared `lineSpacingFactor`, never
 * written out as `1 + s/100` here, so re-scaling the control's units would
 * not need this file edited either.
 */

const OVERLAY = join(
  process.cwd(), 'src/renderer/components/subtitle-overlay/subtitle-overlay.tsx',
)

function overlaySource(): string {
  return readFileSync(OVERLAY, 'utf8')
}

/** The single line assigning the CSS font-size used for the cue text. */
function fontSizeExpr(src: string): string {
  const m = src.match(/^\s*const fontSizePx\s*=\s*(.+)$/m)
  if (!m) throw new Error('could not find the `const fontSizePx = ...` assignment')
  return m[1].trim()
}

/** The single line assigning the CSS line-height for the cue text. */
function lineHeightExpr(src: string): string {
  const m = src.match(/^\s*const lineHeight\s*=\s*(.+)$/m)
  if (!m) throw new Error('could not find the `const lineHeight = ...` assignment')
  return m[1].trim()
}

/**
 * Evaluate an expression lifted out of the component.  Everything the two
 * expressions may legally reference is supplied here; a new free variable
 * makes this throw, which is the point — the expressions must stay
 * expressible in these terms alone.
 */
function evalExpr(
  expr: string,
  scope: {
    entry?: { fontSizePx: number }
    libassScale?: number
    scale?: number
    lineSpacingPercent?: number
  },
): number {
  const names = ['entry', 'libassScale', 'scale', 'lineSpacingPercent', 'lineSpacingFactor']
  const values = [
    scope.entry, scope.libassScale, scope.scale, scope.lineSpacingPercent, lineSpacingFactor,
  ]
  return Function(...names, `return ${expr.replace(/\s+/g, ' ')}`)(...values) as number
}

const LIBASS_SCALES = [0.55, 0.6906, 0.75, 0.9]
const SPACINGS = [
  LINE_SPACING_MIN_PERCENT,
  -25,
  LINE_SPACING_DEFAULT_PERCENT,
  50,
  LINE_SPACING_MAX_PERCENT,
]

/** The rendered CSS line box, computed the way the component computes it. */
function lineBox(
  src: string,
  entryFontSizePx: number,
  libassScale: number,
  scale: number,
  lineSpacingPercent: number,
): number {
  const fs = evalExpr(fontSizeExpr(src), {
    entry: { fontSizePx: entryFontSizePx }, libassScale, scale, lineSpacingPercent,
  })
  const lh = evalExpr(lineHeightExpr(src), { libassScale, lineSpacingPercent })
  return fs * lh
}

describe('REQ-0324 §4-2 — libassScale cancels between font-size and line-height', () => {
  it('both expressions still exist and are found exactly once', () => {
    const src = overlaySource()
    expect(src.match(/^\s*const fontSizePx\s*=/gm)).toHaveLength(1)
    expect(src.match(/^\s*const lineHeight\s*=/gm)).toHaveLength(1)
  })

  it('★ font-size MULTIPLIES by libassScale', () => {
    // `entry.fontSizePx * libassScale * scale`
    const expr = fontSizeExpr(overlaySource())
    expect(expr).toContain('libassScale')
    expect(expr).toMatch(/\*\s*libassScale/)
    // and it must not be a division — that would break the cancellation
    // in the same direction as line-height and double the error.
    expect(expr).not.toMatch(/\/\s*libassScale/)
  })

  it('★ line-height DIVIDES by libassScale (the reciprocal)', () => {
    // `(libassScale > 0 ? 1 / libassScale : <fallback>) * lineSpacingFactor(...)`
    const expr = lineHeightExpr(overlaySource())
    expect(expr).toContain('libassScale')
    expect(expr).toMatch(/1\s*\/\s*libassScale/)
  })

  it('★ the product is therefore independent of libassScale — at EVERY spacing', () => {
    // Evaluate the two expressions symbolically at several libassScale
    // values and assert the LINE BOX does not move.  No literal expected
    // height is written here — the check is that the value is invariant
    // in libassScale, which is exactly the property being protected.
    const src = overlaySource()
    for (const entryFontSizePx of [40, 100, 150]) {
      for (const scale of [0.2, 0.4167, 1]) {
        for (const spacing of SPACINGS) {
          const boxes = LIBASS_SCALES.map((ls) => lineBox(src, entryFontSizePx, ls, scale, spacing))
          for (const b of boxes) expect(b).toBeCloseTo(boxes[0], 9)
        }
      }
    }
  })

  it('★ REQ-0332 — spacing 0 % reproduces the pre-line-spacing line box exactly', () => {
    // The old assertion, unchanged: at the default the line box is
    // `fontSizePx × scale`, which is what `estimateOverlayHeightPx` assumed
    // before line spacing existed.
    const src = overlaySource()
    for (const entryFontSizePx of [40, 100, 150]) {
      for (const scale of [0.2, 0.4167, 1]) {
        for (const ls of LIBASS_SCALES) {
          expect(lineBox(src, entryFontSizePx, ls, scale, LINE_SPACING_DEFAULT_PERCENT))
            .toBeCloseTo(entryFontSizePx * scale, 9)
        }
      }
    }
  })

  it('★ REQ-0332 — line box = fontSizePx × scale × lineSpacingFactor(spacing)', () => {
    // The generalised form.  The expected value comes from the SHARED
    // factor function, not from a literal `1 + s/100`, so this stays a
    // statement about the component rather than a second copy of the unit.
    const src = overlaySource()
    for (const entryFontSizePx of [40, 100, 150]) {
      for (const scale of [0.2, 1]) {
        for (const spacing of SPACINGS) {
          for (const ls of LIBASS_SCALES) {
            expect(lineBox(src, entryFontSizePx, ls, scale, spacing))
              .toBeCloseTo(entryFontSizePx * scale * lineSpacingFactor(spacing), 9)
          }
        }
      }
    }
  })

  it('a one-sided libassScale change would fail — demonstrated on a mutated copy', () => {
    // Guards against the test passing vacuously.  Drop libassScale from
    // the font-size side only (the exact one-sided edit this protects
    // against) and the product must start depending on libassScale.
    const src = overlaySource()
    const mutatedFs = fontSizeExpr(src).replace(/\*\s*libassScale/, '')
    const lh = lineHeightExpr(src)
    const box = (ls: number) =>
      evalExpr(mutatedFs, { entry: { fontSizePx: 100 }, libassScale: ls, scale: 1, lineSpacingPercent: 0 })
      * evalExpr(lh, { libassScale: ls, lineSpacingPercent: 0 })
    expect(box(0.6906)).not.toBeCloseTo(box(0.9), 6)
  })

  it('★ REQ-0332 — dropping the spacing factor would fail, likewise', () => {
    // The new one-sided edit this test now also protects against: strip
    // `lineSpacingFactor(...)` off the line-height and the line box stops
    // responding to the control at all (preview goes silent while the
    // burn-in still moves — the REQ-0320 §1 shape).
    const src = overlaySource()
    const mutatedLh = lineHeightExpr(src).replace(/\s*\*\s*lineSpacingFactor\([^)]*\)/, '')
    expect(mutatedLh).not.toContain('lineSpacingFactor')
    const box = (spacing: number) =>
      evalExpr(fontSizeExpr(src), {
        entry: { fontSizePx: 100 }, libassScale: 0.6906, scale: 1, lineSpacingPercent: spacing,
      }) * evalExpr(mutatedLh, { libassScale: 0.6906, lineSpacingPercent: spacing })
    expect(box(LINE_SPACING_MAX_PERCENT)).toBeCloseTo(box(LINE_SPACING_DEFAULT_PERCENT), 9)
    // …whereas the real expression does respond.
    expect(lineBox(src, 100, 0.6906, 1, LINE_SPACING_MAX_PERCENT))
      .not.toBeCloseTo(lineBox(src, 100, 0.6906, 1, LINE_SPACING_DEFAULT_PERCENT), 6)
  })

  it('★ REQ-0332 — the height estimator agrees with the rendered line box', () => {
    // The estimator and the DOM are two consumers of one relationship.  This
    // asserts they still agree, which is what `computeFixedStackOffsets`
    // (now shared with the ASS writer) is entitled to assume.
    const src = overlaySource()
    for (const spacing of SPACINGS) {
      for (const scale of [0.2, 1]) {
        const entry = {
          text: 'a\\Nb\\Nc',
          fontSizePx: 100,
          outlineThicknessPx: 4,
          lineSpacingPercent: spacing,
        }
        const perLine = lineBox(src, entry.fontSizePx, 0.6906, scale, spacing)
        // The estimator reserves the INK extent, not the CSS box: the line
        // anchors are one `perLine` apart, and the topmost line still puts a
        // full natural line box (= the spacing-0 line box) above its own
        // anchor however tight the pitch is.  Plus the libass collision
        // padding (2 × outline).  All in CSS px.
        const naturalLine = lineBox(src, entry.fontSizePx, 0.6906, scale, LINE_SPACING_DEFAULT_PERCENT)
        const expected = 2 * perLine + naturalLine + 2 * entry.outlineThicknessPx * scale
        expect(estimateOverlayHeightPx(entry as never, 'noto-sans-jp', 1920, 1920 * scale))
          .toBeCloseTo(expected, 9)
      }
    }
  })
})

// Imported last so the source-reading tests above stay independent of the
// component's module graph (it pulls in React and the font cache).
import { estimateOverlayHeightPx } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
