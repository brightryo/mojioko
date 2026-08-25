/**
 * REQ-0535 — the preview's cue background, painted as ONE layer.
 *
 * ## What was wrong
 *
 * The background used to be `background-color` on the text wrapper with
 * `box-decoration-break: clone`, which paints one box per line FRAGMENT and
 * composites each separately.  Wherever two lines' boxes overlapped — which is
 * always, by `2 × bord`, even at the default 0 % line spacing — a translucent
 * background was blended twice and read as a darker stripe.  Measured on a
 * grey-128 source at 60 % black: single layer 51, overlap 21 (`128 × 0.4²` =
 * 20.5).  The burn had the identical defect, which is why every preview/burn
 * parity check agreed and none of them caught it.
 *
 * ## The fix, and why it mirrors the outline ring
 *
 * `paintOutlineLayers` already solved this exact problem for `\3a`: it paints
 * the rings OPAQUE onto a canvas and then applies the alpha as the CANVAS
 * ELEMENT's opacity, "so overlapping rings composite once".  The background now
 * does the same.  The rectangles are merged in the canvas before any alpha
 * exists, so no amount of overlap can darken anything.
 *
 * Geometry comes from the LIVE fragment rects (`getClientRects()` on the
 * wrapper, one per display line), not from a second text-layout implementation
 * — the same principle REQ-0313 established for the ring.  They are then run
 * through the SAME `sealVerticalSeams` the ASS writer uses, so the preview and
 * the burn agree on where a seam falls and on gaps being closed.
 */
import { sealVerticalSeams, type BgRect } from '../../shared/bg-box-geometry'
import { prepareCanvas, type RingBox } from './outline-ring'

export interface BackgroundLayerPaintOptions {
  /** The overlay's outer element — the local coordinate origin. */
  outer: HTMLElement
  bgCanvas: HTMLCanvasElement
  /** Opaque CSS colour; the alpha is applied to the canvas element, not here. */
  colorOpaque: string
  /** 0–1.  0 paints nothing. */
  opacity01: number
  dpr: number
  /**
   * Mirrors `paintOutlineLayers`: `getBoundingClientRect()` reports TRANSFORMED
   * viewport coordinates, so an entrance animation's `scale()` would otherwise
   * be baked into the measured rects AND applied again by the transform.
   */
  skipTransformNeutralisation?: boolean
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Paint the cue's background rectangles onto `bgCanvas`.  Returns the box used,
 * or null when there is nothing to paint.
 */
export function paintBackgroundLayer(opts: BackgroundLayerPaintOptions): RingBox | null {
  const { outer, bgCanvas } = opts
  const clear = () => {
    if (bgCanvas.width !== 0) bgCanvas.width = 0
    if (bgCanvas.height !== 0) bgCanvas.height = 0
  }
  if (opts.opacity01 <= 0) { clear(); return null }

  const wrapper = outer.querySelector<HTMLElement>('[data-subtitle-text-wrapper]')
  if (!wrapper) { clear(); return null }

  const prevTransform = outer.style.transform
  const neutralise = opts.skipTransformNeutralisation !== true
  if (neutralise) outer.style.transform = 'none'
  const originRect = outer.getBoundingClientRect()
  // One client rect per line fragment — exactly the boxes CSS would have
  // painted, so the silhouette is inherited rather than re-derived.
  const fragments: BgRect[] = [...wrapper.getClientRects()].map((r) => ({
    x0: r.left - originRect.left,
    y0: r.top - originRect.top,
    x1: r.right - originRect.left,
    y1: r.bottom - originRect.top,
  }))
  if (neutralise) outer.style.transform = prevTransform

  if (fragments.length === 0) { clear(); return null }

  const rects = sealVerticalSeams(fragments)
  const left = Math.floor(Math.min(...rects.map((r) => r.x0)))
  const top = Math.floor(Math.min(...rects.map((r) => r.y0)))
  const right = Math.ceil(Math.max(...rects.map((r) => r.x1)))
  const bottom = Math.ceil(Math.max(...rects.map((r) => r.y1)))
  const box: RingBox = { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }

  // `prepareCanvas` clears the canvas AND translates into the box's local space
  // (`-box.left, -box.top`), so the rectangles are drawn in outer-relative
  // coordinates verbatim.  Translating again here would push the fill straight
  // off the canvas — which is exactly what happened first time round: a
  // correctly sized, correctly positioned, completely empty canvas.
  const ctx = prepareCanvas(bgCanvas, box, opts.dpr)
  if (!ctx) { clear(); return null }
  ctx.fillStyle = opts.colorOpaque
  // Opaque fills, merged here.  The alpha is the ELEMENT's, below.
  for (const r of rects) ctx.fillRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0)
  bgCanvas.style.opacity = String(clamp01(opts.opacity01))
  return box
}
