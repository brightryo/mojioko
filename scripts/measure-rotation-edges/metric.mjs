/**
 * REQ-0536 §1-2 — the jaggedness metric.
 *
 * "Looks jaggy" has to become a number before any candidate fix can be
 * compared, so this defines ONE metric and everything else in the harness
 * reports it.
 *
 * ## What is measured
 *
 * A straight edge, rendered at an angle, should be antialiased: each scanline's
 * ink coverage crosses 50 % at a position that varies SMOOTHLY and lands
 * exactly on the ideal line.  A staircase is the opposite — the crossing snaps
 * to whole pixels and the edge advances in jumps.
 *
 * So for each scanline we find the sub-pixel position where coverage crosses
 * 50 %, fit a straight line through those positions by least squares, and
 * report:
 *
 *   residualRms  — RMS distance of the crossings from the fitted line, in px.
 *                  A correctly antialiased edge sits well under 0.1 px.  An
 *                  edge quantised to whole pixels cannot do better than the
 *                  RMS of a uniform distribution over one pixel, 1/sqrt(12) =
 *                  0.289 px.  That 0.289 is the number to compare against: it
 *                  is what "no antialiasing at all" measures.
 *   transitionPx — mean distance between the 10 % and 90 % coverage crossings,
 *                  i.e. how wide the soft edge is.  0 means a hard binary edge.
 *   levels       — how many distinct intermediate (non 0, non max) values the
 *                  edge band actually uses.  A hard edge uses none.
 *
 * `residualRms` is the headline number; `transitionPx` and `levels` say WHY it
 * is what it is (a hard edge and a soft-but-misplaced edge are different bugs).
 *
 * ## Why a fitted line rather than the nominal angle
 *
 * Fitting removes any disagreement about where the edge "should" be — position
 * and angle both come out of the data. What is left is only the part that no
 * straight edge can explain, which is exactly the staircase.
 */

/** Luma of a pixel in an RGB24 buffer. */
export function lumaAt(buf, w, x, y) {
  const i = (y * w + x) * 3
  return (buf[i] + buf[i + 1] + buf[i + 2]) / 3
}

/**
 * Sub-pixel x where the scanline crosses `frac` of the way from `lo` to `hi`,
 * scanning left→right in [x0, x1].  Linear interpolation between the two
 * samples that straddle the level.  Returns null when the row never crosses.
 */
function crossingX(buf, w, y, x0, x1, lo, hi, frac) {
  const level = lo + (hi - lo) * frac
  let prev = lumaAt(buf, w, x0, y)
  for (let x = x0 + 1; x <= x1; x++) {
    const cur = lumaAt(buf, w, x, y)
    if ((prev < level && cur >= level) || (prev > level && cur <= level)) {
      if (cur === prev) return x
      return x - 1 + (level - prev) / (cur - prev)
    }
    prev = cur
  }
  return null
}

/** Least-squares fit x = a*y + b over the sampled crossings. */
function fitLine(points) {
  const n = points.length
  let sy = 0, sx = 0, syy = 0, sxy = 0
  for (const { y, x } of points) { sy += y; sx += x; syy += y * y; sxy += x * y }
  const den = n * syy - sy * sy
  if (den === 0) return null
  const a = (n * sxy - sy * sx) / den
  const b = (sx - a * sy) / n
  return { a, b }
}

/**
 * Measure one edge.
 *
 * `band` is the rectangle to look in: rows `y0..y1`, and within each row the
 * scan runs `x0..x1`.  It must contain exactly ONE dark→light transition per
 * row — i.e. one edge, no glyph interior boundaries.  `lo`/`hi` are the two
 * plateau levels (background and full ink).
 */
export function measureEdge(buf, w, band, lo, hi) {
  const mid = [], p10 = [], p90 = []
  for (let y = band.y0; y <= band.y1; y++) {
    const c50 = crossingX(buf, w, y, band.x0, band.x1, lo, hi, 0.5)
    if (c50 === null) continue
    mid.push({ y, x: c50 })
    const a = crossingX(buf, w, y, band.x0, band.x1, lo, hi, 0.1)
    const b = crossingX(buf, w, y, band.x0, band.x1, lo, hi, 0.9)
    if (a !== null && b !== null) { p10.push(a); p90.push(b) }
  }
  if (mid.length < 8) return null

  const fit = fitLine(mid)
  if (!fit) return null
  let ss = 0
  for (const { y, x } of mid) {
    const d = x - (fit.a * y + fit.b)
    ss += d * d
  }
  // Perpendicular distance: the residual above is horizontal, so project it.
  const residualRms = Math.sqrt(ss / mid.length) / Math.sqrt(1 + fit.a * fit.a)

  let transition = 0
  for (let i = 0; i < p10.length; i++) transition += Math.abs(p90[i] - p10[i])
  transition = p10.length ? transition / p10.length / Math.sqrt(1 + fit.a * fit.a) : 0

  // Distinct intermediate levels actually used along the edge.
  const seen = new Set()
  for (let y = band.y0; y <= band.y1; y++) {
    for (let x = band.x0; x <= band.x1; x++) {
      const v = Math.round(lumaAt(buf, w, x, y))
      if (v > lo + 2 && v < hi - 2) seen.add(v)
    }
  }

  return {
    residualRms,
    transitionPx: transition,
    levels: seen.size,
    rows: mid.length,
    angleDeg: (Math.atan(fit.a) * 180) / Math.PI,
  }
}

/** The RMS an edge quantised to whole pixels cannot beat: 1/sqrt(12). */
export const QUANTISED_RMS = 1 / Math.sqrt(12)

/**
 * Follow ONE edge, instead of taking the leftmost ink on every row.
 *
 * ★ Why this exists. Taking "the first crossing in the row" only finds a single
 * edge while the shape is upright. Rotate the text and the leftmost ink walks
 * from one stroke to the next, so the collected points come from several
 * different edges and the straight-line fit becomes meaningless — measured
 * residuals of 8–16 px, which is not a rough edge, it is not an edge at all.
 * A metric that cannot tell "this edge is rough" from "these are three
 * different edges" answers the wrong question, quietly.
 *
 * So: find the crossing once on a seed row, then walk outward, each row
 * searching only NEAR the previous row's crossing. The moment the edge stops
 * being continuous the walk stops, and a run too short to fit is rejected
 * rather than padded out with whatever else was nearby.
 */
export function followEdge(buf, w, h, box, opts = {}) {
  const lo = opts.lo ?? 0
  const hi = opts.hi ?? 255
  const window = opts.window ?? 6
  const maxRows = opts.maxRows ?? 160

  const seedY = Math.round((box.y0 + box.y1) / 2)
  const seed = crossingX(buf, w, seedY, Math.max(0, box.x0 - 6), Math.min(w - 1, box.x1), lo, hi, 0.5)
  if (seed === null) return null

  const pts = [{ y: seedY, x: seed }]
  const walk = (dir) => {
    let prev = seed
    for (let k = 1; k <= maxRows / 2; k++) {
      const y = seedY + dir * k
      if (y < box.y0 || y > box.y1 || y < 0 || y >= h) break
      const x0 = Math.max(0, Math.floor(prev - window))
      const x1 = Math.min(w - 1, Math.ceil(prev + window))
      const c = crossingX(buf, w, y, x0, x1, lo, hi, 0.5)
      if (c === null) break
      // A jump larger than the window means we hopped to a different feature.
      if (Math.abs(c - prev) > window) break
      pts.push({ y, x: c })
      prev = c
    }
  }
  walk(-1)
  walk(+1)
  if (pts.length < 40) return null

  pts.sort((a, b) => a.y - b.y)

  // ★ Measure the STRAIGHTEST run, not the whole followed path.
  //
  // A glyph edge is only straight for part of its length: 'I' rotated by 15°
  // gives a stem and then a corner, and following through the corner fits a
  // line to two different edges and calls the mismatch roughness (measured 3–12
  // px, which is the corner's geometry, not any staircase). Sliding a fixed
  // window along and keeping the best fit isolates a genuinely straight segment
  // — which is the only place "is this edge cleanly antialiased?" is even a
  // well-posed question.
  const WIN = Math.min(opts.win ?? 60, pts.length)
  let best = null
  for (let i = 0; i + WIN <= pts.length; i++) {
    const seg = pts.slice(i, i + WIN)
    const f = fitLine(seg)
    if (!f) continue
    let s = 0
    for (const { y, x } of seg) { const d = x - (f.a * y + f.b); s += d * d }
    const rms = Math.sqrt(s / seg.length) / Math.sqrt(1 + f.a * f.a)
    if (!best || rms < best.rms) best = { rms, fit: f, seg }
  }
  if (!best) return null
  const fit = best.fit
  const norm = Math.sqrt(1 + fit.a * fit.a)
  const residualRms = best.rms
  const used = best.seg

  // Transition width, measured on the same rows and around the same edge.
  let tSum = 0, tN = 0
  for (const { y, x } of used) {
    const x0 = Math.max(0, Math.floor(x - window))
    const x1 = Math.min(w - 1, Math.ceil(x + window))
    const a = crossingX(buf, w, y, x0, x1, lo, hi, 0.1)
    const b = crossingX(buf, w, y, x0, x1, lo, hi, 0.9)
    if (a !== null && b !== null) { tSum += Math.abs(b - a); tN++ }
  }

  const seen = new Set()
  for (const { y, x } of used) {
    for (let dx = -2; dx <= 2; dx++) {
      const v = Math.round(lumaAt(buf, w, Math.max(0, Math.min(w - 1, Math.round(x) + dx)), y))
      if (v > lo + 2 && v < hi - 2) seen.add(v)
    }
  }

  return {
    residualRms,
    transitionPx: tN ? tSum / tN / norm : 0,
    levels: seen.size,
    rows: used.length,
    followed: pts.length,
    // Fitted angle of the measured segment.  If this is far from the cue's
    // nominal rotation, the walk found some other edge and the row is suspect.
    angleDeg: (Math.atan(fit.a) * 180) / Math.PI,
    /** Middle of the segment actually measured, so a crop can target it. */
    atY: used[Math.floor(used.length / 2)].y,
    atX: used[Math.floor(used.length / 2)].x,
  }
}
