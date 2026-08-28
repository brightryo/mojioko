/**
 * REQ-0514 — burn side of the `verify:scale-origin` gate.
 *
 * Bundled to CJS by index.mjs and `require`d.  Calls the REAL `generateAss` on
 * the REAL cue built by `case-spec.ts`, so the gate measures what ships
 * (REQ-0316 forbids hand-authored ASS fixtures).
 */
import { generateAss } from '../../src/main/services/ass-generator'
import { getFontMeta, DEFAULT_FONT_ID } from '../../src/shared/fonts'
import type { BurninPosition, VideoInfo } from '../../src/shared/types'
import { BASE, CUE_END, CUE_START, VIDEO, VIDEO_H, VIDEO_W, cue, inSecOf, scaleAt, type CaseSpec } from './case-spec'

export const ASS_FONT_NAME: string = getFontMeta(DEFAULT_FONT_ID).assFontName
export { BASE, CUE_START, CUE_END, VIDEO_W, VIDEO_H, inSecOf, scaleAt }

/** Real production `generateAss` (all-`\pos`, the shipping default). */
export function renderAss(spec: CaseSpec): string {
  const burnin: BurninPosition = {
    horizontalPosition: spec.h,
    verticalPosition: spec.v,
    verticalMarginPx: spec.marginV,
  }
  return generateAss(
    [cue(spec)], VIDEO as unknown as VideoInfo, burnin, undefined, ASS_FONT_NAME, false, 'switch',
  )
}
