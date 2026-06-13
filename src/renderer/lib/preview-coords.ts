import { ASS_MARGIN_LR_PX } from '../../shared/constants'

/**
 * REQ-20260613-016 Phase 6 — pure coordinate-conversion helpers for the
 * preview drag / pinning machinery (機能B).  Kept dependency-free so the
 * unit tests can exercise the math without mounting React.
 *
 * Coordinate spaces:
 *   - **ASS space** = video pixel space.  Origin at top-left; x grows
 *     right, y grows down.  PlayResX/Y in the generated ASS match
 *     `video.widthPx` / `video.heightPx`, so ASS coords ARE pixel coords
 *     of the source frame.
 *   - **Preview space** = the rendered HTML container's pixel space.
 *     Same orientation as ASS space, but scaled by
 *     `containerWidthPx / videoWidthPx`.  Linear conversion both ways.
 */

/**
 * Map (horizontal × vertical) to the libass numpad alignment value (1–9).
 * Re-implemented here (not imported from ass-generator) so the renderer
 * can compute it without dragging in main-process types.
 */
export function getAlignmentNumpad(
  h: 'left' | 'center' | 'right',
  v: 'top' | 'bottom',
): number {
  if (v === 'bottom') {
    return h === 'left' ? 1 : h === 'center' ? 2 : 3
  }
  return h === 'left' ? 7 : h === 'center' ? 8 : 9
}

/** ASS → preview pixel.  Single source of truth — multiply by scale. */
export function assToPreviewPx(assCoord: number, scale: number): number {
  return assCoord * scale
}

/** Preview pixel → ASS coordinate.  Single source of truth — divide by scale. */
export function previewPxToAss(previewPx: number, scale: number): number {
  return previewPx / scale
}

/**
 * Compute the ASS-space position of the **anchor point** an alignment-based
 * row would sit at if it had no explicit `\pos`.  Used when a user starts
 * dragging a previously-unpinned row: we seed posX/posY with the visible
 * anchor so the drag doesn't "jump" to an unrelated coordinate at
 * pointer-down.
 *
 * The anchor follows libass's numpad convention:
 *   - 7/8/9 (top): y = marginV (distance from top)
 *   - 1/2/3 (bottom): y = videoHeight - marginV (distance from bottom)
 *   - left (1, 7): x = ASS_MARGIN_LR_PX
 *   - center (2, 5, 8): x = videoWidth / 2
 *   - right (3, 9): x = videoWidth - ASS_MARGIN_LR_PX
 *
 * Pure math; safe to call per pointer-down.
 */
export function getAnchorAssPosition(
  horizontalPosition: 'left' | 'center' | 'right',
  verticalPosition: 'top' | 'bottom',
  verticalMarginPx: number,
  videoWidthPx: number,
  videoHeightPx: number,
): { x: number; y: number } {
  let x: number
  if (horizontalPosition === 'left') x = ASS_MARGIN_LR_PX
  else if (horizontalPosition === 'right') x = videoWidthPx - ASS_MARGIN_LR_PX
  else x = videoWidthPx / 2
  const y =
    verticalPosition === 'top'
      ? verticalMarginPx
      : videoHeightPx - verticalMarginPx
  return { x, y }
}

/**
 * Compute the CSS transform string that translates a pinned overlay's
 * top-left corner so the alignment-defined anchor sits at `(posX, posY)`
 * in ASS space (= `(posX*scale, posY*scale)` in preview pixels, which the
 * caller applies via CSS `left` / `top`).
 *
 * libass numpad anchor semantics:
 *   - 7 (top-left): anchor = top-left of the text box → no translation
 *   - 8 (top-center): anchor = top-center → translate-x by -50%
 *   - 9 (top-right): anchor = top-right → translate-x by -100%
 *   - 1 (bottom-left): anchor = bottom-left → translate-y by -100%
 *   - 2 (bottom-center): anchor = bottom-center → translate(-50%, -100%)
 *   - 3 (bottom-right): anchor = bottom-right → translate(-100%, -100%)
 *
 * The returned string is consumed by SubtitleOverlay as the CSS
 * `transform` value when rendering a pinned row.
 */
export function pinnedAnchorTransform(
  horizontalPosition: 'left' | 'center' | 'right',
  verticalPosition: 'top' | 'bottom',
): string {
  const tx =
    horizontalPosition === 'left' ? '0'
    : horizontalPosition === 'center' ? '-50%'
    : '-100%'
  const ty = verticalPosition === 'top' ? '0' : '-100%'
  return `translate(${tx}, ${ty})`
}

/**
 * Clamp a coordinate pair into the visible frame.  Pinned positions
 * outside the frame are valid (libass will still render them, just
 * clipped) but unbounded drift makes the UI confusing.  Clamp at the
 * frame edges so the user can always see where they dragged to.
 *
 * REQ-20260613-016 Phase 6 — applied per pointermove in the drag handler.
 */
export function clampAssPosition(
  x: number,
  y: number,
  videoWidthPx: number,
  videoHeightPx: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(videoWidthPx, x)),
    y: Math.max(0, Math.min(videoHeightPx, y)),
  }
}
