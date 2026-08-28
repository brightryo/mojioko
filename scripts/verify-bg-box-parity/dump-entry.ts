/**
 * REQ-0535 — burn side of `verify:bg-box-parity`.
 *
 * Bundled to CJS by index.mjs and `require`d.  Calls the REAL `generateAss` on
 * the REAL cue from `case-spec.ts` (REQ-0316 forbids hand-authored ASS).
 */
import { generateAss } from '../../src/main/services/ass-generator'
import { getFontMeta, DEFAULT_FONT_ID, FONT_REGISTRY } from '../../src/shared/fonts'
import { getFontFilePath } from '../../src/main/lib/paths'
import type { BurninPosition, VideoInfo } from '../../src/shared/types'
import { CASES, CUE_END, CUE_START, SAMPLE_SEC, SOURCE_GREY, VIDEO, VIDEO_H, VIDEO_W, cue, type CaseSpec } from './case-spec'
import { assertRealFont, metricsFor } from './gate-metrics'

export const ASS_FONT_NAME: string = getFontMeta(DEFAULT_FONT_ID).assFontName
export { CASES, CUE_START, CUE_END, SAMPLE_SEC, SOURCE_GREY, VIDEO_W, VIDEO_H }
export { assertRealFont }

/**
 * REQ-0537 — every registry font and where production would look for its file.
 *
 * Used to CHOOSE the real-app negative control by looking at the machine rather
 * than hard-coding a font id that may or may not be installed.
 */
export const FONT_FILES: { id: string; path: string }[] = FONT_REGISTRY.map((m) => ({
  id: m.id,
  path: getFontFilePath(m),
}))

const burnin: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'center', verticalMarginPx: 40,
}
const ASS_MARGIN_LR_PX = 60

/**
 * Real production `generateAss`, with REAL font metrics injected — see
 * `gate-metrics.ts` for why the default resolver would silently put the writer
 * back on its pre-REQ-0535 path.
 */
export function renderAss(spec: CaseSpec): string {
  return generateAss(
    [cue(spec)], VIDEO as unknown as VideoInfo, burnin, undefined,
    ASS_FONT_NAME, true, 'switch', true, ASS_MARGIN_LR_PX, metricsFor,
  )
}

/**
 * ★ THE NEGATIVE CONTROL, burn side.
 *
 * Production's own ASS, with the ONE decision under test perturbed back: the
 * background returns to libass's per-line `BorderStyle=3` box.  That is done by
 * withholding the font metrics — the exact input that makes `generateAss`
 * choose the old path — so the control runs the CURRENT writer over the CURRENT
 * tree and cannot rot.  No `git checkout`, no historical import (CLAUDE.md §18,
 * learned in REQ-0514).
 */
export function renderAssPreFix(spec: CaseSpec): string {
  return generateAss(
    [cue(spec)], VIDEO as unknown as VideoInfo, burnin, undefined,
    ASS_FONT_NAME, true, 'switch', true, ASS_MARGIN_LR_PX,
    () => ({ font: null, libassScale: 1, cmap: null, tofu: null }),
  )
}
