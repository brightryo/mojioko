import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * REQ-0333 §2 — pin the mechanism that makes the preview's background box
 * PER DISPLAY LINE, so it keeps agreeing with the burn at every line spacing.
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
 * is the pre-existing box-padding difference (CSS `padding: 2px 6px` vs
 * libass `\bord3` under `BorderStyle=3`); it is spacing-INDEPENDENT — it is
 * the same at 0 % — so it is a separate defect, recorded in RES-0333, not
 * this one.
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
  it('★ the background-bearing wrapper is an INLINE box', () => {
    // An inline box's background covers the font content area, so its height
    // does not follow `line-height`.  That is what lets the boxes separate at
    // positive spacing and overlap at negative spacing, matching libass.
    const block = textWrapperStyleBlock(overlaySource())
    expect(block).toContain('backgroundColor')
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

  it('the wrapper is the ONLY place the cue background colour is applied', () => {
    // A second background-painting element (e.g. a block wrapper added for
    // layout) would reintroduce the continuous box this test exists to
    // prevent, without touching the declarations above.
    const src = overlaySource()
    const hits = src.match(/backgroundColor:/g) ?? []
    expect(hits.length).toBe(1)
  })
})
