/**
 * REQ-0339 §1 — WHICH layer the entrance/exit blur is applied to.
 *
 * ## The measurement that produced this module
 *
 * The preview looked far blurrier than the export at outline 20 / blur 30.
 * The suspicion was the `\blur N` → `blur(Npx)` conversion factor
 * (`ASS_BLUR_TO_CSS_SIGMA`).  It is not that: the factor is right.
 *
 * Burning `\blur N` over a solid 600 px block at PlayRes = frame size and
 * measuring the edge σ (10–90 rise ÷ 2.5631, cross-checked against the
 * line-spread function's second moment) gives, on the burn side:
 *
 *   `\bord 0`  — σ/N = 0.85 at every N from 3.5 to 40.  The glyph itself is
 *                blurred, exactly as the conversion assumes.
 *   `\bord >0` — the FILL IS NOT BLURRED AT ALL.  Its edge stays a hard
 *                one-pixel step (σ ≈ 0.3–0.6 px) at `\blur` 0, 5.3, 9.7, 20,
 *                30 and 40 alike, while the outline halo around it blurs at
 *                the same σ/N = 0.834·N the `\bord 0` case shows.  Two
 *                independent harnesses (glyph stimulus and a `\p1` rectangle)
 *                agree, and the halo's alpha at the glyph boundary matches
 *                Φ(bord/σ) to within 0.3 % — i.e. libass blurs the OUTLINE
 *                bitmap and then composites the SHARP glyph over it.
 *
 * The preview did the opposite: `filter: blur()` sat on the outer span, which
 * contains the ring canvas AND the text, so Chromium blurred the composite and
 * the text went soft.  Measured on the same stimulus, preview σ was 0.806·N on
 * BOTH channels regardless of outline width — so at outline 20 / blur 30 the
 * export's text edge was σ ≈ 0.3 px while the preview's was σ ≈ 24 px.  That
 * two-orders-of-magnitude gap on the glyph edge, not a percentage error in the
 * factor, is what the owner was seeing.
 *
 * ## What this does
 *
 * With an outline ring present, the blur goes on the ring + shadow canvases
 * and the text keeps its edges — the libass layering.  With no ring there is
 * no outline bitmap, libass blurs the glyph itself, and a filter on the outer
 * span is already the right thing.
 *
 * ## Known residual (measured, not hand-waved)
 *
 * Our ring canvas is painted PUNCHED (stroke, then `destination-out` the
 * glyph) and is then blurred; libass blurs the UNPUNCHED outline bitmap and
 * punches afterwards.  Blurring an annulus is not blurring a disc: at
 * `\bord 20` / `\blur 30` libass's halo reaches alpha ≈ 0.79 where it meets
 * the glyph, whereas a blurred annulus peaks near 0.31.  So the preview's halo
 * is still fainter than the burn's — but it is a difference in the halo's
 * opacity, not in the sharpness of the type, and it is bounded by the outline
 * width.  Closing it needs the blur to move INSIDE `paintOutlineLayers` (paint
 * the outline with `ctx.filter`, then punch), which means repainting the ring
 * every animation frame; that is a bigger change than this REQ carries.
 */

/**
 * Apply `cssBlurPx` to the layer libass would have blurred.
 *
 * @param outer      the cue's outer positioned span (contains both canvases
 *                   and the text wrapper)
 * @param cssBlurPx  blur radius in CSS px, already scaled and converted;
 *                   0 (or less) removes the filter
 */
export function applyCueBlurToLayer(outer: HTMLElement, cssBlurPx: number): void {
  // DOM order is shadow canvas, then ring canvas (subtitle-overlay.tsx) — the
  // libass paint order, shadow below outline below fill.
  const canvases = outer.querySelectorAll('canvas')
  const shadow = canvases[0] as HTMLCanvasElement | undefined
  const ring = canvases[1] as HTMLCanvasElement | undefined
  // Two ways to know the cue has an outline bitmap, and BOTH are needed:
  //
  //   `data-cue-outlined` — written by `subtitle-overlay` during render, from
  //     the same expression it feeds `paintOutlineLayers`.  This is the one
  //     that answers at MOUNT time: `video-preview-panel`'s callback ref fires
  //     during the commit phase, which is BEFORE the layout effect has sized
  //     the ring canvas, so a width test alone reports "no outline" on exactly
  //     the frame REQ-0339 §2 is about and blurs the text for that frame.
  //   `ring.width > 0` — the painted truth, and the only signal available to
  //     `verify:ring-paint`, which builds the cue DOM by hand.
  //
  // A cue whose ring is suppressed (background box) has neither, and falls to
  // the outer-span branch — which is what a duplicated entry-side predicate
  // would have got wrong.  REQ-0340 §1 measured that this is also the RIGHT
  // answer, not merely the incidental one: under `BorderStyle=3` libass blurs
  // the box AND the type together, unlike `BorderStyle=1`.  Type-edge σ, burn
  // → preview, at `\blur` 0/10/20/30: 0.58→0.62, 6.56→6.42, 17.79→17.48,
  // 24.58→24.74, with a `BorderStyle=1` control in the same harness reading
  // 0.58→0.62 (sharp) at `\blur20`.  So the outer-span branch matches the burn
  // for background-box cues and must NOT be "fixed" to use the canvas path.
  const outlined = outer.hasAttribute('data-cue-outlined') || (ring !== undefined && ring.width > 0)
  const filter = cssBlurPx > 0 ? `blur(${cssBlurPx}px)` : ''
  const set = (el: HTMLElement | undefined, value: string) => {
    if (el && el.style.filter !== value) el.style.filter = value
  }
  if (outlined) {
    set(outer, '')
    set(ring, filter)
    set(shadow, filter)
  } else {
    set(ring, '')
    set(shadow, '')
    set(outer, filter)
  }
}
