import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * REQ-0333 §2 — pin the mechanism that makes the preview's background box
 * PER DISPLAY LINE, so it keeps agreeing with the burn at every line spacing.
 *
 * ---------------------------------------------------------------------------
 * ★ CORRECTION (REQ-0535).  The conclusion below — "the two sides agree, so the
 * preview is right" — was true and insufficient.  They agreed because BOTH were
 * wrong in the same way.
 *
 * Per-line boxes overlap by `boxHeight − pitch` = `2 × bord` at the default 0 %
 * spacing, and BOTH sides composited each line's box separately, so a
 * translucent background was blended TWICE in the overlap and read as a darker
 * stripe.  Measured on a grey-128 source at 60 % black: a single layer lands on
 * 51 (`128 × 0.4`), the overlap on 19 in the burn and 21 in the preview
 * (`128 × 0.4²` = 20.5).  The band-count / pitch / gap profile used below
 * cannot see this: it measures WHERE the bands are, never how many times a
 * pixel was painted.
 *
 * The owner reported it as "the output video has stripes between the lines" and
 * believed the preview was clean — it is not, it is merely displayed smaller,
 * so a 6 px seam at the default outline becomes 2–3 px and hides in the
 * antialiasing.
 *
 * What survives: the per-line GEOMETRY, still asserted here.  What changed:
 * neither side paints the background per fragment any more.  The preview paints
 * the sealed rectangles opaque onto a canvas and applies the alpha once as the
 * element's opacity (`renderer/lib/bg-layer.ts`); the burn emits one `\p1`
 * drawing per cue (`shared/bg-box-geometry.ts`).  Real-pixel proof, both sides,
 * is `npm run verify:bg-box-parity`.
 * ---------------------------------------------------------------------------
 *
 * ## What REQ-0333 §2 expected, and what was actually measured
 *
 * RES-0332 §9-1 reported that splitting a cue into per-line events makes
 * libass draw one opaque box PER LINE — which gaps at positive line spacing —
 * while "the preview draws one continuous CSS box".  The second half of that
 * is **not what the preview does**, and the measurement is below.  No preview
 * change was needed; what was missing was anything pinning the behaviour.
 *
 * ## The measurement (REQ-0333 §2, background box ON)
 *
 * 2-line cue, `\fs100`, `\bord3`, MarginV 40, 1920×1080, top-anchored,
 * `MOJIOKO Noto Sans JP SemiBold` on both sides.  Burn: real `generateAss`
 * output through the bundled ffmpeg, frame written as LOSSLESS PNG and
 * profiled by row coverage mass `Σ max(R,G,B)/255`.  Preview: the same CSS
 * declarations in a real Electron window, `capturePage()`, same profile.
 *
 *   spacing   burn rows (height)              preview rows (height)
 *   −50 %     37–192 (156), merged            38–191 (154), merged
 *     0 %     37–242 (206), continuous        38–241 (204), continuous
 *   +100 %    37–142 (106) + 237–342 (106)    38–141 (104) + 238–341 (104)
 *
 * Same band COUNT, same pitch (200 px), same gap at +100 %, same overlap at
 * −50 %, and identical continuity at 0 %.  The constant 1-px inset per edge
 * was the box-PADDING difference (CSS `padding: 2px 6px` vs libass `\bord3`
 * under `BorderStyle=3`); it is spacing-INDEPENDENT — the same at 0 % — so it
 * was a separate defect.  **REQ-0340 §1 fixed it**: the padding is now
 * `outlineThicknessPx * scale`, and the burn's bands and the preview's are
 * identical integer ranges at outline 0/4/9/20 × spacing −50/0/+100 %.  The
 * padding itself is pinned by `overlay-bg-box-padding-req-0340.test.ts`; what
 * remains this file's job is the PER-LINE mechanism, which that fix did not
 * touch.
 *
 * ## Why the preview already gaps
 *
 * The text wrapper is `display: inline` with `box-decoration-break: clone`.
 * A CSS inline box paints its background over its CONTENT AREA, whose height
 * comes from the font's ascent + descent — NOT from `line-height` — and
 * `clone` gives every line fragment its own full background + padding.  So
 * each display line gets a box of a fixed, font-derived height while the
 * fragments' spacing is driven by `line-height`.  Raise the spacing and the
 * fragments separate; lower it and they overlap.  That is exactly libass's
 * per-line `BorderStyle=3` behaviour, for a completely different reason.
 *
 * ## Why this test asserts source text
 *
 * Same reasoning as `overlay-lineheight-cancellation-req-0324.test.ts`: the
 * property is a RELATIONSHIP between CSS declarations, and jsdom does not
 * implement inline fragment backgrounds, so a rendering assertion here would
 * be measuring a stub. Two declarations carry the whole behaviour:
 *
 *   `display: 'inline'`            — an inline box, so the background height
 *                                    is the font content area and NOT the
 *                                    line box.  `inline-block` or `block`
 *                                    would make one box per wrapper, i.e. one
 *                                    continuous box across all lines, and the
 *                                    preview would stop matching the burn at
 *                                    non-zero spacing.
 *   `box-decoration-break: 'clone'` — each line fragment repeats the padding
 *                                    and the radius.  Under the `slice`
 *                                    default the padding appears only at the
 *                                    very start and end of the whole run.
 *
 * If a future change needs to move away from these, it must first show a
 * measurement like the one above for the replacement.
 */

const OVERLAY = join(
  process.cwd(), 'src/renderer/components/subtitle-overlay/subtitle-overlay.tsx',
)

function overlaySource(): string {
  return readFileSync(OVERLAY, 'utf8')
}

/** The `textWrapperStyle` initialiser — the object literal(s) it assigns. */
function textWrapperStyleBlock(src: string): string {
  const start = src.indexOf('const textWrapperStyle')
  expect(start).toBeGreaterThan(-1)
  // The declaration is a ternary over two object literals; take up to the
  // next top-level `const` declaration at the same indentation.
  const rest = src.slice(start)
  const end = rest.search(/\n {2}const [A-Za-z]/)
  return end > 0 ? rest.slice(0, end) : rest
}

describe('REQ-0333 §2 — the preview background box is per display line', () => {
  it('★ the box-defining wrapper is an INLINE box', () => {
    // An inline box's background covers the font content area, so its height
    // does not follow `line-height`.  That is what lets the boxes separate at
    // positive spacing and overlap at negative spacing, matching libass.
    //
    // REQ-0535 — this element no longer PAINTS the background, it only defines
    // the geometry: its per-fragment client rects are what `paintBackgroundLayer`
    // reads.  So `display: inline` and the padding are still load-bearing (they
    // decide the rects), but `backgroundColor` is deliberately gone — see the
    // correction note at the head of this file.
    const block = textWrapperStyleBlock(overlaySource())
    expect(block).not.toContain('backgroundColor')
    expect(block).toMatch(/display:\s*'inline'/)
    expect(block).not.toMatch(/display:\s*'(inline-block|block|flex|inline-flex)'/)
  })

  it('★ every line fragment repeats the box decoration', () => {
    const block = textWrapperStyleBlock(overlaySource())
    expect(block).toMatch(/boxDecorationBreak:\s*'clone'/)
    expect(block).toMatch(/WebkitBoxDecorationBreak:\s*'clone'/)
  })

  it('the background box carries padding, which `clone` then repeats per line', () => {
    // Without padding on this element the `clone` above would have nothing to
    // repeat and the box would hug the glyphs, unlike libass's `\bord` inset.
    const block = textWrapperStyleBlock(overlaySource())
    expect(block).toMatch(/padding:/)
  })

  it('★ REQ-0535 — nothing in the overlay paints the background with CSS', () => {
    // The whole point of the canvas layer is that the alpha is applied ONCE, to
    // the canvas element.  Any `backgroundColor` carrying the cue's translucent
    // colour would paint per line fragment again and bring the stripe back.
    const src = overlaySource()
    expect(src.match(/backgroundColor:/g) ?? []).toHaveLength(0)
  })

  it('★ REQ-0535 — the background colour reaches the canvas OPAQUE', () => {
    // An `rgba(...)` here would put the alpha back on every rectangle, so the
    // overlaps would darken again even though the painting moved to a canvas.
    const src = overlaySource()
    expect(src).toMatch(/bgColorOpaque\s*=\s*bg\.color === 'white' \? 'rgb\(255, 255, 255\)' : 'rgb\(0, 0, 0\)'/)
    expect(src).not.toMatch(/rgba\(0, 0, 0, \$\{bgOpacity\}\)/)
  })
})
