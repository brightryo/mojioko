/**
 * REQ-0568 — the geometry the Microsoft Store listing assets are built to.
 *
 * This lives in its own module because TWO scripts have to agree on it:
 * `scripts/shots/index.mjs` sizes the app window from it, and
 * `scripts/store-assets/index.mjs` composites onto it. If they disagreed by a
 * pixel the caption band would either overlap the app or leave a seam, and the
 * only symptom would be a slightly wrong picture — the kind of defect that
 * survives review. One table, imported by both.
 *
 * ## Why the app is captured SHORTER than the deliverable
 *
 * The store screenshot must be EXACTLY 1920x1080. The caption band has to go
 * somewhere, and there are only three ways to make room for it:
 *
 *   1. paint it over the top of a 1920x1080 capture — covers the app's own
 *      header, which is part of what the screenshot is showing;
 *   2. scale a 1920x1080 capture down to fit under it — REQ-0568 §1-1
 *      explicitly rules this out ("do not fake it with scaling");
 *   3. capture the app at 1920x(1080 - band) and give the band its own strip.
 *
 * (3) is the only one that neither hides UI nor resamples a pixel, so the
 * window is sized to `appHeight` and the composite is a straight blit. The
 * `--no-caption` variant needs the full height instead, which is why there are
 * two capture targets rather than one.
 */

export const STORE = {
  width: 1920,
  height: 1080,
  /** Caption strip across the top. Tall enough for 40px type plus air. */
  bandHeight: 104,
}

/** Window content size per `--target`. `store` leaves room for the band. */
export const TARGETS = {
  site: { width: 1600, height: 900 },
  store: { width: STORE.width, height: STORE.height - STORE.bandHeight },
  'store-full': { width: STORE.width, height: STORE.height },
}
