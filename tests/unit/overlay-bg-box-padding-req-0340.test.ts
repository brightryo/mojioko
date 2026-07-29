import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0340 §1 — the preview's background box is padded by `\bord`.
 *
 * ## The defect
 *
 * Under `BorderStyle=3` libass draws the opaque box as the glyph outline grown
 * by `\bord`, and `\bord` is `entry.outlineThicknessPx` — the 0–20 slider.  The
 * preview used a constant `padding: 2px 6px`.  So the two agreed only where the
 * constants happened to cross, and diverged linearly everywhere else.
 *
 * Measured with the real `generateAss` through the bundled ffmpeg (FFV1/gbrp,
 * rgb24) against the real `SubtitleOverlay` client-rendered in Electron and
 * captured with `capturePage()`; box edge minus glyph ink edge, top edge,
 * PlayRes = frame, `MOJIOKO Noto Sans JP SemiBold` on both sides:
 *
 *     outline    |   0      4      9     20
 *     burn       |  none  33.08  38.08  49.08     = bord + 29.08
 *     preview    | 31.00  31.00  31.00  31.00     = constant
 *     error      |    --   2.08   7.08  18.08
 *
 * The left edge behaves the same against its own constant (`bord + 6.4` vs a
 * flat 12.44).  After the fix every edge tracks to within 0.09 px — the
 * antialiasing bias of reading a soft edge at its 0.5 crossing — and the burn's
 * per-line bands and the preview's are IDENTICAL integer ranges at outline
 * 0/4/9/20 × line spacing −50/0/+100 %.
 *
 * ## Zero outline draws no box
 *
 * At `\bord0` the grown outline collapses onto the glyph and disappears
 * underneath it: the burn contains **zero** white pixels where the preview had
 * 28,034.  The preview now matches.  (That the background box therefore
 * vanishes from an export whenever the user has the outline at 0 is a product
 * question — recorded in RES-0340, not decided here.)
 *
 * ## Why these assertions read the rendered style attribute
 *
 * `overlay-bg-per-line-box-req-0333.test.ts` asserts SOURCE text because its
 * subject is a relationship between declarations that jsdom does not implement.
 * This one is different: the padding VALUE is computed from props, so rendering
 * the component and reading what it emitted tests the computation rather than
 * its spelling. Server rendering is enough — the value is on the inline style.
 */

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 2, text: 'HEIT',
    fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 3, fadeDurationSec: 0,
    horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: true, color: 'white' as const, opacityPercent: 100 },
  }
  return {
    id: 'e1', ...base, isDeleted: false, isEdited: false, original: { ...base }, ...patch,
  } as SubtitleEntry
}

/** The inline `padding` on the element that carries the background colour. */
function wrapperStyle(entry: SubtitleEntry, videoWidthPx = 1000, containerWidthPx = 1000): string {
  const html = renderToStaticMarkup(
    React.createElement(SubtitleOverlay, { entry, videoWidthPx, containerWidthPx }),
  )
  const m = html.match(/data-subtitle-text-wrapper[^>]*style="([^"]*)"/)
    ?? html.match(/style="([^"]*)"[^>]*data-subtitle-text-wrapper/)
  expect(m, `no text wrapper in:\n${html}`).not.toBeNull()
  return m![1]
}

function paddingPx(style: string): number | null {
  const m = style.match(/(?:^|;)\s*padding:\s*([0-9.]+)px/)
  return m === null ? null : Number(m[1])
}

describe('REQ-0340 §1 — background box padding follows the outline width', () => {
  for (const outlineThicknessPx of [1, 3, 4, 9, 20]) {
    it(`outline ${outlineThicknessPx} → padding ${outlineThicknessPx}px on all four edges`, () => {
      const style = wrapperStyle(makeEntry({ outlineThicknessPx }))
      expect(paddingPx(style)).toBe(outlineThicknessPx)
      // One value = all four edges equal.  libass grows the box by `\bord` in
      // both axes; the old `2px 6px` is exactly the shape this forbids.
      expect(style).toMatch(new RegExp(`padding:\\s*${outlineThicknessPx}px\\s*(;|$)`))
    })
  }

  it('padding scales with the preview, like every other ASS-space length', () => {
    // `outlinePx = entry.outlineThicknessPx * scale`.  A half-size preview must
    // draw a half-size box, or the box stops matching at any zoom but 1.
    const style = wrapperStyle(makeEntry({ outlineThicknessPx: 10 }), 1000, 500)
    expect(paddingPx(style)).toBe(5)
  })

  it('★ outline 0 draws NO box — libass draws none either', () => {
    const style = wrapperStyle(makeEntry({ outlineThicknessPx: 0 }))
    expect(paddingPx(style)).toBeNull()
    expect(style).not.toMatch(/background/i)
  })

  it('the box is still coloured and still per-line at every non-zero width', () => {
    for (const outlineThicknessPx of [1, 20]) {
      const style = wrapperStyle(makeEntry({ outlineThicknessPx }))
      expect(style).toMatch(/background-color:\s*rgba\(255, ?255, ?255/)
      expect(style).toMatch(/box-decoration-break:\s*clone/)
    }
  })

  it('no border radius — libass’ opaque box has square corners', () => {
    const style = wrapperStyle(makeEntry({ outlineThicknessPx: 9 }))
    expect(style).not.toMatch(/border-radius/)
  })

  it('background OFF is untouched: no padding, no background, at any outline', () => {
    // Pinned because the fix touches the ternary that chooses between the two
    // shapes.  Measured separately as pixel-identical on both sides.
    for (const outlineThicknessPx of [0, 3, 20]) {
      const style = wrapperStyle(makeEntry({
        outlineThicknessPx,
        subtitleBackground: { enabled: false, color: 'white', opacityPercent: 100 },
      }))
      expect(paddingPx(style)).toBeNull()
      expect(style).not.toMatch(/background/i)
    }
  })
})
