/**
 * REQ-0532 §1 — burn side of the `verify:cut-anim-parity` gate.
 *
 * Bundled to CJS by index.mjs and `require`d. Runs the REAL pipeline the burn
 * runs: `translateEntriesToEditedAxis` (the shared fold from REQ-0531) followed
 * by the REAL `generateAss`. No hand-authored ASS — REQ-0316 forbids it, and a
 * hand-authored fixture is exactly how a parity gate stops measuring the
 * product.
 */
import { generateAss } from '../../src/main/services/ass-generator'
import { translateEntriesToEditedAxis, editedToOrig } from '../../src/shared/cuts'
import { getFontMeta, DEFAULT_FONT_ID } from '../../src/shared/fonts'
import type { BurninPosition, VideoInfo } from '../../src/shared/types'
import { CASES, VIDEO, VIDEO_H, VIDEO_W, VIDEO_DUR, cue, type CaseSpec } from './case-spec'

export const ASS_FONT_NAME: string = getFontMeta(DEFAULT_FONT_ID).assFontName
export { CASES, VIDEO_W, VIDEO_H, VIDEO_DUR }

/**
 * The ASS the burn would write for this case: cues translated onto the edited
 * axis first, exactly as `ffmpeg-burnin` does, then the production writer.
 */
export function renderAss(spec: CaseSpec): string {
  const burnin: BurninPosition = {
    horizontalPosition: 'center',
    verticalPosition: 'center',
    verticalMarginPx: 40,
  }
  const { entries } = translateEntriesToEditedAxis([cue(spec)], spec.cuts)
  return generateAss(
    entries, VIDEO as unknown as VideoInfo, burnin, undefined, ASS_FONT_NAME, false, 'switch',
  )
}

/**
 * The SOURCE time the preview's <video> must sit at to be showing the burn's
 * `tEdited`. The same inverse the seekbar and the still exporter use — the
 * harness must not invent its own, or the gate would be testing the harness.
 */
export function sourceTimeFor(spec: CaseSpec, tEdited: number): number {
  return editedToOrig(tEdited, spec.cuts)
}
