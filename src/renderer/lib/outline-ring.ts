/**
 * REQ-0313 — canvas outline ring for the subtitle preview.
 *
 * ## Why this exists
 *
 * libass `\bord N` grows the border OUTWARD only: it renders the border into
 * its own bitmap and subtracts the glyph bitmap from it.  CSS
 * `-webkit-text-stroke` is CENTRED (N outside, N inside).  The preview used to
 * bridge that with `strokeWidth = 2N` + `paint-order: stroke fill`, which only
 * looks right while an OPAQUE FILL happens to paint over the stroke's inner
 * half.  That implicit dependency broke twice:
 *
 *   REQ-0310 (opacity)  — a transparent fill stopped masking, so the ring read
 *                         2N and at bord >= 12 the glyph interior closed up
 *                         entirely (hollow text rendered solid).
 *   REQ-0311 (`\kf`)    — the sweep paints the fill via `background-clip: text`,
 *                         and backgrounds paint BELOW the stroke, so the fill
 *                         could not mask at all (black stroke swallowed the
 *                         glyph).
 *
 * Canvas has the compositing operator CSS lacks.  Stroking at 2N and then
 * punching the glyph out with `destination-out` leaves exactly the outward N —
 * the same shape libass produces — and it no longer depends on the fill in any
 * way.  The DOM text carries NO stroke at all after this change, so no future
 * fill technique can break the outline again.
 *
 * ## Not reimplementing text layout
 *
 * The ring must sit exactly on the glyphs.  Rather than recompute line breaks,
 * advances, alignment and per-run font sizes (a second implementation that
 * would inevitably drift from the DOM's), every run is MEASURED FROM THE LIVE
 * DOM: `Range.getClientRects()` per text node gives sub-pixel positions, and
 * `getComputedStyle` gives the font actually used.  The canvas only replays
 * what the DOM already laid out.
 *
 * Consequences that fall out for free:
 *   - emphasis font-size changes, because each run carries its own computed font
 *   - tofu substitution (REQ-0297), because the DOM text node IS the substituted text
 *   - preview scale, because the computed font size is already scaled
 *
 * Line breaks are NOT free, and assuming they were caused REQ-0315 §1: the
 * plain path encodes them as real newlines inside ONE text node (`white-space:
 * pre`), so a Range over it spans several line boxes and its bounding rect is
 * their union.  `measureRuns` therefore emits one run per line fragment.
 *
 * The one thing the DOM does NOT hand over is `text-transform`: the text node
 * still holds the original casing while the rendering is uppercased, so the
 * transform is re-applied here or the ring would trace the wrong glyphs.
 */

/** Vertical/horizontal reach of a run's inline box, local px. */
export interface RunExtent {
  top: number
  bottom: number
  width: number
}

/** A single measured run of text, in the overlay's local (untransformed) px. */
export interface MeasuredRun {
  text: string
  /** CSS `font` shorthand, taken from the run's computed style. */
  font: string
  /** Left edge of the run's inline box. */
  x: number
  /** Alphabetic baseline. */
  baselineY: number
}

export interface RingBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Canvas placement: the union of the runs' ink, grown by whatever the ring and
 * the shadow can add.  Returned in the same local space as the runs.
 *
 * `padPx` must cover the ring's outward reach; `shadowOffsetPx` extends the box
 * down-right only, matching libass's fixed bottom-right shadow direction.
 * Returns null when there is nothing to draw.
 */
export function computeRingBox(
  runs: readonly MeasuredRun[],
  runExtents: readonly { top: number; bottom: number; width: number }[],
  padPx: number,
  shadowOffsetPx = 0,
): RingBox | null {
  if (runs.length === 0 || runs.length !== runExtents.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i]
    const e = runExtents[i]
    minX = Math.min(minX, r.x)
    maxX = Math.max(maxX, r.x + e.width)
    minY = Math.min(minY, e.top)
    maxY = Math.max(maxY, e.bottom)
  }
  if (!isFinite(minX) || !isFinite(minY)) return null
  const left = Math.floor(minX - padPx)
  const top = Math.floor(minY - padPx)
  const right = Math.ceil(maxX + padPx + shadowOffsetPx)
  const bottom = Math.ceil(maxY + padPx + shadowOffsetPx)
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Mirrors CSS `text-transform` so the canvas traces the glyphs actually shown. */
export function applyTextTransform(text: string, textTransform: string): string {
  if (textTransform === 'uppercase') return text.toUpperCase()
  if (textTransform === 'lowercase') return text.toLowerCase()
  return text
}

/**
 * Sizes a canvas for `box` at the given device pixel ratio and returns a context
 * already scaled to CSS pixels, so all drawing can use the local coordinates
 * measured from the DOM.  Returns null if the canvas has no area or no 2D context.
 */
export function prepareCanvas(
  canvas: HTMLCanvasElement,
  box: RingBox,
  dpr: number,
): CanvasRenderingContext2D | null {
  const ratio = dpr > 0 ? dpr : 1
  const w = Math.max(0, Math.ceil(box.width * ratio))
  const h = Math.max(0, Math.ceil(box.height * ratio))
  if (w === 0 || h === 0) return null
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  canvas.style.left = `${box.left}px`
  canvas.style.top = `${box.top}px`
  canvas.style.width = `${box.width}px`
  canvas.style.height = `${box.height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  // Scale by the ACTUAL backing-store ratio, not the requested `dpr`.  The
  // backing store is a whole number of device pixels, so at a fractional dpr
  // `ceil` leaves it slightly larger than `box.width * dpr`; using `dpr` for
  // the transform then stretches the drawing by that remainder and slides the
  // ring off the glyphs by a fraction of a pixel (measured: 0.33px of
  // left/right asymmetry at dpr 1.5).  Deriving the scale from the sizes that
  // were actually applied keeps CSS px and canvas px exactly in step.
  ctx.setTransform(w / box.width, 0, 0, h / box.height, 0, 0)
  ctx.clearRect(0, 0, box.width, box.height)
  // Draw in the box's local space so run coordinates can be used verbatim.
  ctx.translate(-box.left, -box.top)
  return ctx
}

/**
 * Paints the outward-only ring.
 *
 * Order matters: EVERY run is stroked before ANY run is punched.  Interleaving
 * (stroke A, punch A, stroke B, punch B) lets B's stroke paint back into the
 * area A's punch just cleared, leaving ink inside glyph A wherever the two sit
 * within 2N of each other.
 *
 * The colour is always drawn fully opaque; `\3a` is applied by the caller as an
 * opacity on the canvas ELEMENT.  Baking alpha into `strokeStyle` instead would
 * double-composite everywhere two glyphs' rings overlap, producing dark seams
 * libass never shows.
 */
export function paintRing(
  ctx: CanvasRenderingContext2D,
  runs: readonly MeasuredRun[],
  outlinePx: number,
  colorOpaque: string,
): void {
  if (outlinePx <= 0) return
  ctx.save()
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.strokeStyle = colorOpaque
  // 2x, then punch: the visible remainder outside the glyph is exactly outlinePx.
  ctx.lineWidth = outlinePx * 2
  for (const r of runs) {
    ctx.font = r.font
    ctx.strokeText(r.text, r.x, r.baselineY)
  }
  ctx.globalCompositeOperation = 'destination-out'
  for (const r of runs) {
    ctx.font = r.font
    ctx.fillText(r.text, r.x, r.baselineY)
  }
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()
}

/**
 * Paints the drop shadow: the silhouette of fill+border, offset down-right.
 *
 * Kept on its own canvas beneath the ring so the previous paint order (shadow
 * under outline under fill — the libass order) survives the move off CSS
 * `text-shadow`, and so the shadow's own alpha stays independent of `\3a`.
 * NOT punched: libass shadows the composite silhouette, so a transparent fill
 * still reveals shadow through the glyph interior.
 */
export function paintShadow(
  ctx: CanvasRenderingContext2D,
  runs: readonly MeasuredRun[],
  outlinePx: number,
  offsetPx: number,
  colorOpaque: string,
): void {
  ctx.save()
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.fillStyle = colorOpaque
  ctx.strokeStyle = colorOpaque
  if (outlinePx > 0) ctx.lineWidth = outlinePx * 2
  for (const r of runs) {
    ctx.font = r.font
    if (outlinePx > 0) ctx.strokeText(r.text, r.x + offsetPx, r.baselineY + offsetPx)
    ctx.fillText(r.text, r.x + offsetPx, r.baselineY + offsetPx)
  }
  ctx.restore()
}

/**
 * Reads every text run inside `wrapper` straight out of the live DOM.
 *
 * `originLeft`/`originTop` are the viewport coordinates of the local origin
 * (the overlay's outer span). The caller MUST have neutralised any rotation on
 * that span first — `getClientRects()` reports viewport boxes, and under a
 * rotation those are axis-aligned bounding boxes whose corners no longer
 * correspond to the box's own corners.  With rotation removed the subtraction
 * below yields exact local coordinates, and CSS re-applies the rotation to the
 * canvas and the text together afterwards.
 *
 * `white-space: pre` on the overlay means text never auto-wraps — every line
 * break is an explicit `<br>` — so each text node occupies exactly one line box
 * and reports exactly one client rect.
 */
export function measureRuns(
  wrapper: HTMLElement,
  originLeft: number,
  originTop: number,
  measureCtx: CanvasRenderingContext2D,
): { runs: MeasuredRun[]; extents: RunExtent[] } {
  const runs: MeasuredRun[] = []
  const extents: RunExtent[] = []
  const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const raw = node.nodeValue
    if (raw === null || raw.length === 0) continue
    const parent = node.parentElement
    if (parent === null) continue
    const cs = getComputedStyle(parent)
    const text = applyTextTransform(raw, cs.textTransform)
    if (text.trim().length === 0) continue // whitespace-only: no ink to outline
    const font =
      cs.font && cs.font.length > 0
        ? cs.font
        : `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    measureCtx.font = font
    const m = measureCtx.measureText(text)
    const asc = m.fontBoundingBoxAscent
    const desc = m.fontBoundingBoxDescent
    const denom = asc + desc

    // REQ-0315 §1 — ONE RUN PER LINE BOX, not one per text node.
    //
    // The plain render path builds its line breaks as real newline characters
    // inside a SINGLE text node and lets `white-space: pre` break them
    // (`subtitle-overlay.tsx` turns the ASS `\N` sentinel into a newline).  A
    // `Range` over such a node therefore spans several line boxes, and
    // `getBoundingClientRect()` collapses them into a UNION box whose `left`
    // is the widest line's left and whose `height` covers every line.  Using
    // that box put the ring left of the narrower line and far below the first
    // line's baseline, while `strokeText` — which does not break lines — drew
    // the whole cue as one long line on top of a wrapped one: the reported
    // "doubled, offset down and left" outline (REQ-0315 §1).
    //
    // Splitting on the newline gives exactly the line fragments `pre` produces,
    // so each gets its own rect, its own x and its own baseline.  A node with
    // no newline takes the single-segment path and is byte-identical to before.
    const segments = text.split('\n')
    let offset = 0
    for (const segment of segments) {
      const start = offset
      offset += segment.length + 1 // plus the \n that terminated it
      if (segment.trim().length === 0) continue
      range.setStart(node, start)
      range.setEnd(node, start + segment.length)
      const rect = range.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) continue
      const baselineY =
        denom > 0 ? rect.top - originTop + (rect.height * asc) / denom : rect.bottom - originTop
      runs.push({ text: segment, font, x: rect.left - originLeft, baselineY })
      extents.push({
        top: rect.top - originTop,
        bottom: rect.bottom - originTop,
        width: rect.width,
      })
    }
  }
  return { runs, extents }
}
