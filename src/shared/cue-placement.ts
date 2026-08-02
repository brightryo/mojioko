/**
 * REQ-0389 (positioning-redesign Phase 1a) — `computeCuePlacement`.
 *
 * The single positioning authority spec'd in
 * `dev-docs/specs/positioning-redesign.md`: given a cue's *intent* it returns a
 * **neutral-space** placement (video/ASS px + `\an` numpad + a detection box +
 * a z-order layer).  The ASS writer turns each line's `{anchorX, anchorY}` into
 * `\pos(...)` via `formatAssCoord`; the preview turns it into CSS px via
 * `× scale`.  **This function emits neither `\pos` strings nor CSS** — only
 * neutral numbers (spec decision F, §4).
 *
 * ## Relationship to `cueLineAnchors`
 *
 * The per-line anchor arithmetic is NOT re-derived here — it is `cueLineAnchors`
 * (`line-spacing.ts`), which REQ-0332 validated byte-for-byte against libass.
 * `computeCuePlacement` *wraps* it and adds the two things the neutral contract
 * needs that a bare anchor list does not carry: the `\an` numpad each line is
 * anchored by, and the collision box for overlap detection (spec §8 / decision
 * D).  Wrapping — rather than reimplementing — is what makes the Phase 1a exit
 * criterion "the pure function reproduces existing placement *by value*"
 * (spec §10-6.1) true by construction: the anchors ARE `cueLineAnchors`'.
 *
 * ## Shadow status (Phase 1a)
 *
 * Per REQ-0389 §1 this function is NOT connected to the production render path.
 * It is exercised only by `verify:pos-parity` (through `generateAss`'s
 * default-off `forceSelfPositionAll` seam) and by its own unit tests.  Phase 1b
 * is where the runtime switches to it.
 */

import { cueLineAnchors, type CueLineAnchorInput } from './line-spacing'

/**
 * The libass numpad alignment (1–9) an alignment pair maps to.
 *
 *   top    : left=7 center=8 right=9
 *   center : left=4 center=5 right=6   (REQ-0140)
 *   bottom : left=1 center=2 right=3
 *
 * A THIRD copy of the mapping already living in `ass-generator.ts:getAlignment`
 * and `preview-coords.ts:getAlignmentNumpad`.  It is inlined here (not imported)
 * so the shared module pulls in neither the main-process nor the renderer file;
 * the redesign's Phase 1b/2 work consolidates the three onto this one once the
 * runtime is wired to `computeCuePlacement` (until then the shared copy must not
 * change the runtime, so it cannot own the mapping yet).
 */
export function alignmentNumpad(
  horizontalPosition: 'left' | 'center' | 'right',
  verticalPosition: 'top' | 'center' | 'bottom',
): number {
  if (verticalPosition === 'bottom') {
    return horizontalPosition === 'left' ? 1 : horizontalPosition === 'center' ? 2 : 3
  }
  if (verticalPosition === 'center') {
    return horizontalPosition === 'left' ? 4 : horizontalPosition === 'center' ? 5 : 6
  }
  return horizontalPosition === 'left' ? 7 : horizontalPosition === 'center' ? 8 : 9
}

/**
 * Neutral-space input to the single positioning authority.
 *
 * It is `CueLineAnchorInput` (the validated anchor math) plus the two fields the
 * neutral contract adds: `outlineThicknessPx` (so the detection box can include
 * the same `fix_collisions` padding `estimateCueHeightAssPx` reserves) and an
 * optional `layer` (z-order, meaningful from Phase 2 — carried through as 0
 * today).
 */
export interface CuePlacementInput extends CueLineAnchorInput {
  /** Outline half-width in ASS px; pads the detection box top & bottom. */
  outlineThicknessPx: number
  /** z-order layer (spec decision E).  Phase 1a always 0. */
  layer?: number
}

/** One display line's neutral placement. */
export interface CuePlacementLine {
  /** Anchor x in ASS/video px, UNROUNDED (ASS side applies `formatAssCoord`). */
  anchorX: number
  /** Anchor y in ASS/video px, UNROUNDED. */
  anchorY: number
  /** libass numpad (1–9) this line is anchored by — same for every line. */
  an: number
}

/**
 * A cue's vertical ink band, ASS px.  `left`/`right` are the *usable content*
 * bounds, not a measured text width — see the box docblock in
 * `computeCuePlacement`.
 */
export interface CuePlacementBox {
  top: number
  bottom: number
  left: number
  right: number
}

/** The neutral-space placement of a whole cue. */
export interface CuePlacement {
  lines: CuePlacementLine[]
  box: CuePlacementBox
  layer: number
}

/**
 * Resolve a cue's intent into its neutral-space placement.
 *
 * `lines[i].{anchorX, anchorY}` are exactly `cueLineAnchors(input)[i]` — same
 * values, so anything comparing the two (the Phase 1a value-inclusion test)
 * finds them identical.  `an` is the cue's single alignment, replicated per line
 * (a multi-line cue anchors every line by the same `\an`, which is what the ASS
 * self-position path already does).
 *
 * ### The detection box
 *
 * The VERTICAL extent is exact: each line spans its own height around the point
 * its `\an` names (top edge for 7/8/9, bottom for 1/2/3, middle for 4/5/6), and
 * the band is padded by `outlineThicknessPx` top and bottom — the same
 * `fix_collisions` padding `estimateCueHeightAssPx` reserves.  The HORIZONTAL
 * extent is the *usable content width* `[marginLrPx, playResX − marginLrPx]`
 * (or the pinned x): a conservative bound, because line-anchor math deliberately
 * measures no text (event-splitting.md §4).  Precise horizontal overlap needs
 * the overflow-calculator's glyph advances and is Phase 2 / decision D work; the
 * conservative band never yields a false NEGATIVE (only, possibly, a false
 * positive), which is the safe direction for a non-blocking "cues overlap"
 * warning.  Phase 1a's pixel gate does not read this box.
 */
export function computeCuePlacement(input: CuePlacementInput): CuePlacement {
  const anchors = cueLineAnchors(input)
  const an = alignmentNumpad(input.horizontalPosition, input.verticalPosition)

  const lines: CuePlacementLine[] = anchors.map((a) => ({
    anchorX: a.x,
    anchorY: a.y,
    an,
  }))

  // Vertical band: each line's box sits around the edge its `\an` names.
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (let i = 0; i < anchors.length; i++) {
    const h = input.lineHeightsPx[i] ?? 0
    const y = anchors[i].y
    let lineTop: number
    let lineBottom: number
    if (input.verticalPosition === 'top') {
      // `\an7/8/9` — anchor is the line's TOP edge.
      lineTop = y
      lineBottom = y + h
    } else if (input.verticalPosition === 'center') {
      // `\an4/5/6` — anchor is the line's MIDDLE.
      lineTop = y - h / 2
      lineBottom = y + h / 2
    } else {
      // `\an1/2/3` — anchor is the line's BOTTOM edge.
      lineTop = y - h
      lineBottom = y
    }
    if (lineTop < top) top = lineTop
    if (lineBottom > bottom) bottom = lineBottom
  }
  top -= input.outlineThicknessPx
  bottom += input.outlineThicknessPx

  const pinned = input.posX !== undefined && input.posY !== undefined
  const left = pinned ? (input.posX as number) : input.marginLrPx
  const right = pinned ? (input.posX as number) : input.playResX - input.marginLrPx

  return {
    lines,
    box: { top, bottom, left, right },
    layer: input.layer ?? 0,
  }
}
