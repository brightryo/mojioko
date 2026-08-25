/**
 * REQ-0535 — the cue background as ONE region, shared by the ASS writer and the
 * preview.
 *
 * ## The defect this replaces
 *
 * The background used to be libass's `BorderStyle=3` opaque box on the burn
 * side and a `box-decoration-break: clone` CSS background on the preview side.
 * Both draw ONE BOX PER DISPLAY LINE, and both composite each of those boxes
 * separately — so wherever two lines' boxes overlap, a translucent background
 * is blended twice and the overlap reads as a darker stripe.  Measured on a
 * grey-128 source at 60 % black: a single layer lands on 51 (`128 × 0.4`), the
 * overlap on 19 in the burn and 21 in the preview (`128 × 0.4²` = 20.5).  The
 * two sides agreed with each other and were both wrong, which is why
 * preview/burn parity checks never caught it (REQ-0333 asserted exactly that
 * agreement).
 *
 * The boxes overlap by `boxHeight − pitch` = `2 × bord − fontSize × (spacing%/100)`,
 * so at the DEFAULT 0 % spacing every multi-line cue still overlaps by
 * `2 × bord`.  Nothing about the owner's settings was unusual.
 *
 * ## What this module produces
 *
 * A list of rectangles that a caller paints as ONE shape (a single ASS `\p`
 * drawing / a single canvas path), so the alpha applies exactly once no matter
 * how the rectangles overlap.  Each display line keeps its OWN width — the
 * owner chose the per-line silhouette over a single bounding rectangle — and
 * vertical gaps are bridged so the region is continuous at positive spacing
 * too.
 *
 * ## The box geometry is measured, not assumed
 *
 * `\pos` anchors the TEXT box; libass then grows the drawn box by `bord` on all
 * four sides.  Burned all nine `\an` values at `\fs72 \bord8` and read the box
 * out of the raw frame — every one matched that rule exactly:
 *
 *     an7/8/9 (top)    box top    = pos.y − bord
 *     an4/5/6 (middle) box centre = pos.y
 *     an1/2/3 (bottom) box bottom = pos.y + bord
 *     an1/4/7 (left)   box left   = pos.x − bord      … and so on horizontally
 *
 * Box HEIGHT measured exactly `fontSize + 2 × bord` in all nine, and in a
 * separate sweep over 9 text/size/bord combinations.  Box WIDTH is
 * `measureLineWidthPx + 2 × bord` to within ~1 px per 3 glyphs (worst observed
 * +3.3 px on a 330 px box — libass rounds each glyph's advance to integers and
 * this predictor does not).  That residual is a background edge, not a text
 * position, and the parity gate pins it.
 */

/** A rectangle in ASS pixels.  `y` grows downward; `x1`/`y1` are exclusive. */
export interface BgRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** One display line, as the caller has already resolved it. */
export interface BgLine {
  /** The line's `\pos` anchor, ASS px — what `cueLineAnchors` returns. */
  anchorX: number
  anchorY: number
  /** Rendered width of this line's text, ASS px (`measureLineWidthPx`). */
  textWidthPx: number
  /**
   * This line's own rendered font size, ASS px.  Emphasis emits enlarged `\fs`
   * runs, so a line is not always the cue's base size — callers pass
   * `maxFontSizeInLineBodyAssPx`, the same authority the line pitch uses
   * (REQ-0350).
   */
  fontSizePx: number
}

export type HorizontalPosition = 'left' | 'center' | 'right'
export type VerticalPosition = 'top' | 'center' | 'bottom'

/**
 * The box libass draws (or the preview must paint) for ONE display line.
 *
 * The anchor addresses the text box; the drawn box is that inflated by
 * `outlinePx` on every side — see the module docblock for the measurements.
 */
export function lineBgRect(
  line: BgLine,
  horizontal: HorizontalPosition,
  vertical: VerticalPosition,
  outlinePx: number,
): BgRect {
  const w = line.textWidthPx
  const h = line.fontSizePx
  const textX0 = horizontal === 'left' ? line.anchorX
    : horizontal === 'right' ? line.anchorX - w
      : line.anchorX - w / 2
  const textY0 = vertical === 'top' ? line.anchorY
    : vertical === 'bottom' ? line.anchorY - h
      : line.anchorY - h / 2
  return {
    x0: textX0 - outlinePx,
    y0: textY0 - outlinePx,
    x1: textX0 + w + outlinePx,
    y1: textY0 + h + outlinePx,
  }
}

/**
 * Make consecutive lines' rectangles MEET EXACTLY — never overlapping, never
 * gapping — by moving their shared edge to the midpoint between them.
 *
 * ## Why disjoint rather than a union
 *
 * The obvious fix is to union the per-line boxes into one shape and paint that
 * once.  It does remove the stripe, but it forces the whole cue's background
 * into a SINGLE event, and a single event has a single transform origin.  The
 * text does not: a split cue is one event PER LINE, each scaling about its own
 * `\an` anchor (and each carrying its own `\fad` / `\blur` / `\t`).  A one-shape
 * background would therefore drift away from its own text during any scale
 * animation.
 *
 * Disjoint rectangles keep the background per line — same event count, same
 * anchors, same animation tags as the text it backs — and disjoint regions
 * cannot double-composite no matter how they are blended.  The stripe is gone
 * because the overlap is gone, not because the blending changed.
 *
 * ## What this changes visually
 *
 * Where boxes used to overlap, the silhouette in that band was the UNION (the
 * wider line's width) painted twice.  Now the band is split at its midpoint:
 * the upper half keeps the upper line's width, the lower half the lower line's.
 * For equally wide lines — the ordinary case — this is pixel-identical to the
 * union.  For ragged lines it differs only inside a band `2 × bord` tall.
 *
 * Where boxes used to GAP (positive line spacing), the gap is now filled, each
 * line owning its own half.  That is the owner's §2 choice ("隙間もないこと").
 *
 * ## The shared edge is an integer
 *
 * Two rectangles that meet at a fractional y would each antialias against it and
 * leave a visible hairline. `\p1` takes integer coordinates anyway, so the
 * midpoint is rounded ONCE here and both neighbours are given the same value —
 * that is what makes the join seamless rather than merely small.
 *
 * `rects` must be in display order (top to bottom), which is what
 * `cueLineAnchors` returns.  A pair that is not in that order is left alone
 * rather than silently reordered: lines out of order are an upstream bug, and
 * sealing them would paint over the evidence.
 */
export function sealVerticalSeams(rects: readonly BgRect[]): BgRect[] {
  const out = rects.map((r) => ({ ...r }))
  for (let i = 0; i + 1 < out.length; i++) {
    // Out of display order — leave it visible rather than "fix" it.
    if (out[i + 1].y0 < out[i].y0) continue
    const seam = Math.round((out[i].y1 + out[i + 1].y0) / 2)
    out[i].y1 = seam
    out[i + 1].y0 = seam
  }
  return out
}

/**
 * The cue's background: one rectangle per display line, seams sealed so the
 * region is continuous and no two rectangles overlap.
 */
export function cueBgRects(
  lines: readonly BgLine[],
  horizontal: HorizontalPosition,
  vertical: VerticalPosition,
  outlinePx: number,
): BgRect[] {
  return sealVerticalSeams(lines.map((l) => lineBgRect(l, horizontal, vertical, outlinePx)))
}

/** How far along its own box each alignment sits: left/top 0 … right/bottom 1. */
const ALIGN_FRACTION = { left: 0, center: 0.5, right: 1, top: 0, bottom: 1 } as const

/**
 * One rectangle as an ASS `\p1` drawing body, positioned by `\pos(anchor)` with
 * the SAME `\an` the text line uses.
 *
 * ## The alignment shift, measured
 *
 * libass lays a drawing out in two steps: the coordinates are placed relative
 * to `\pos`, and THEN the whole shape is shifted by its own bounding box
 * according to `\an`.  Burned a 120×68 rectangle written as `-60,-34 … 60,34`:
 *
 *     \an7\pos(960,540)  ->  x=[900..1019] y=[506..573]   (no shift)
 *     \an5\pos(960,540)  ->  x=[840..959]  y=[472..539]   (shifted -60,-34)
 *
 * so `\an5` moved it by exactly (−w/2, −h/2) — the shape is NOT simply centred
 * on `\pos`, the centring is applied ON TOP of the relative coordinates.  This
 * function cancels that shift, so the rectangle lands exactly on `rect` while
 * the event keeps the text line's own alignment.
 *
 * Keeping the alignment matters beyond position: `\fscx`/`\fscy` scale about the
 * alignment point, so a background emitted with the same `\an` and `\pos` as its
 * text line scales about the same point and stays with it through a `scale` or
 * `pop` animation.
 *
 * Coordinates are whole pixels — `\p1` drawing units are integers.  `y0`/`y1`
 * arrive already rounded from `sealVerticalSeams` (a shared seam must round
 * once, not once per neighbour, or the two sides antialias apart); the
 * horizontal edges round outward so the background never ends a pixel short of
 * the text it backs.
 */
export function bgRectsToAssDrawing(
  rects: readonly BgRect[],
  anchorX: number,
  anchorY: number,
  horizontal: HorizontalPosition,
  vertical: VerticalPosition,
): string {
  // Integer coordinates, all relative to ONE anchor.  That is what makes the
  // internal seams exact: a shared edge is a single number used by both
  // neighbours, so it cannot round two ways.  Emitting one rectangle per event,
  // each relative to its own line anchor, does NOT have this property — the
  // anchors differ, often fractionally, and the seam reopened as a 1 px line
  // (measured: a `62` where a solid `51` was expected, i.e. a partly-covered
  // pixel).
  const ints = rects.map((r) => ({
    x0: Math.floor(r.x0 - anchorX),
    x1: Math.ceil(r.x1 - anchorX),
    y0: Math.round(r.y0 - anchorY),
    y1: Math.round(r.y1 - anchorY),
  }))
  // Cancel the bbox shift libass applies for this `\an`.  Because there is ONE
  // shape, any rounding here moves the whole background together — it can never
  // pull a seam apart.
  const bx0 = Math.min(...ints.map((r) => r.x0))
  const bx1 = Math.max(...ints.map((r) => r.x1))
  const by0 = Math.min(...ints.map((r) => r.y0))
  const by1 = Math.max(...ints.map((r) => r.y1))
  // Measured: `\an5` moved a 120×68 shape by exactly (−60, −34), i.e. by
  // −(size × fraction) — it does NOT depend on where the shape's own bbox
  // origin sits.  Adding that back puts the shape on `rect`.
  const dx = Math.round((bx1 - bx0) * ALIGN_FRACTION[horizontal])
  const dy = Math.round((by1 - by0) * ALIGN_FRACTION[vertical])
  return ints
    .map((r) => {
      const x0 = r.x0 + dx, x1 = r.x1 + dx, y0 = r.y0 + dy, y1 = r.y1 + dy
      return `m ${x0} ${y0} l ${x1} ${y0} l ${x1} ${y1} l ${x0} ${y1}`
    })
    .join(' ')
}
