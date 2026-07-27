import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * REQ-0324 §4-2 — pin the libassScale cancellation that
 * `estimateOverlayHeightPx` silently depends on.
 *
 * ## The invariant
 *
 *   CSS font-size   = entry.fontSizePx × libassScale × scale   (line 287)
 *   CSS line-height = 1 / libassScale                          (line 468)
 *   ⇒ rendered line box = entry.fontSizePx × scale
 *
 * `estimateOverlayHeightPx` returns `lineCount × fontSizePx × scale` and
 * feeds `computeFixedStackOffsets`, which positions stacked cues in the
 * preview.  It is correct ONLY because libassScale cancels between those
 * two lines.  Change either one alone and every stack offset silently
 * shifts — RES-0322 §1-4 measured the damage at a uniform 30.94 %
 * (fs=150 / 3 lines / 3rd row: 183.20px → 126.52px).
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
 * care; break the reciprocity and it fails.
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
    // `libassScale > 0 ? 1 / libassScale : <fallback>`
    const expr = lineHeightExpr(overlaySource())
    expect(expr).toContain('libassScale')
    expect(expr).toMatch(/1\s*\/\s*libassScale/)
  })

  it('★ the product is therefore independent of libassScale', () => {
    // Evaluate the two expressions symbolically at several libassScale
    // values and assert the LINE BOX does not move.  No literal expected
    // height is written here — the check is that the value is invariant
    // in libassScale, which is exactly the property being protected.
    const src = overlaySource()
    const fs = fontSizeExpr(src)
    const lh = lineHeightExpr(src)

    const evalFontSize = (entryFontSizePx: number, libassScale: number, scale: number) =>
      Function('entry', 'libassScale', 'scale',
        `return ${fs.replace(/\s+/g, ' ')}`,
      )({ fontSizePx: entryFontSizePx }, libassScale, scale)

    const evalLineHeight = (libassScale: number) =>
      Function('libassScale', `return ${lh.replace(/\s+/g, ' ')}`)(libassScale)

    for (const entryFontSizePx of [40, 100, 150]) {
      for (const scale of [0.2, 0.4167, 1]) {
        const boxes = [0.55, 0.6906, 0.75, 0.9].map(
          (ls) => evalFontSize(entryFontSizePx, ls, scale) * evalLineHeight(ls),
        )
        // every libassScale must give the SAME line box
        for (const b of boxes) expect(b).toBeCloseTo(boxes[0], 9)
        // and that shared value is what estimateOverlayHeightPx assumes
        expect(boxes[0]).toBeCloseTo(entryFontSizePx * scale, 9)
      }
    }
  })

  it('a one-sided change would fail — demonstrated on a mutated copy', () => {
    // Guards against the test passing vacuously.  Drop libassScale from
    // the font-size side only (the exact one-sided edit this protects
    // against) and the product must start depending on libassScale.
    const src = overlaySource()
    const mutatedFs = fontSizeExpr(src).replace(/\*\s*libassScale/, '')
    const lh = lineHeightExpr(src)
    const box = (ls: number) =>
      Function('entry', 'libassScale', 'scale', `return ${mutatedFs.replace(/\s+/g, ' ')}`)(
        { fontSizePx: 100 }, ls, 1,
      ) * Function('libassScale', `return ${lh.replace(/\s+/g, ' ')}`)(ls)
    expect(box(0.6906)).not.toBeCloseTo(box(0.9), 6)
  })
})
