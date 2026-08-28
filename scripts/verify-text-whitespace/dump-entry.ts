/**
 * REQ-0515 — burn side of the `verify:text-whitespace` gate.
 *
 * Bundled to CJS by index.mjs and `require`d.  Calls the REAL `generateAss` on
 * the REAL cue from `case-spec.ts` (REQ-0316 forbids hand-authored ASS).
 */
import { generateAss } from '../../src/main/services/ass-generator'
import { getFontMeta, DEFAULT_FONT_ID } from '../../src/shared/fonts'
import {
  buildKaraokeAssText,
  projectCueWhitespaceOntoWords,
  splitWordsAtHardBreaks,
} from '../../src/shared/karaoke-ass'
import type { BurninPosition, VideoInfo } from '../../src/shared/types'
import { CUE_END, CUE_START, SAMPLE_SEC, VIDEO, VIDEO_H, VIDEO_W, WORDS, cue, type CaseSpec } from './case-spec'

export const ASS_FONT_NAME: string = getFontMeta(DEFAULT_FONT_ID).assFontName
export { CUE_START, CUE_END, SAMPLE_SEC, VIDEO_W, VIDEO_H }

const burnin: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'center', verticalMarginPx: 40,
}

/** Real production `generateAss`.  `isMsix = true` so the karaoke tier passes. */
export function renderAss(spec: CaseSpec): string {
  return generateAss(
    [cue(spec)], VIDEO as unknown as VideoInfo, burnin, undefined,
    ASS_FONT_NAME, true, 'switch',
  )
}

/** The karaoke body for a unit list, spelled exactly as the writer spells it. */
function bodyFor(text: string, units: readonly { text: string; startSec: number; endSec: number }[]): string {
  return buildKaraokeAssText(
    splitWordsAtHardBreaks(text, units), CUE_START, CUE_END, (s) => s, text,
  )
}

/**
 * ★ THE NEGATIVE CONTROL, burn side.
 *
 * Takes production's own ASS and swaps ONLY the karaoke body back to what the
 * pre-REQ-0515 pipeline produced — the same units minus the
 * `projectCueWhitespaceOntoWords` step, i.e. still spelling the stale
 * transcription text.  Every other byte (style block, `\pos`, timings) is
 * whatever production just wrote, so the control differs in exactly the one way
 * under test.
 *
 * Reconstructing the defect beats checking the old file out of git: historical
 * sources import the tree as it was then, which rots on any later refactor
 * (`verify:anim-first-frame` was dead for four REQs from exactly that), and
 * `--grep=REQ-NNNN` silently resolves a LATER commit mentioning the same REQ so
 * the control ends up measuring the fixed code.  Both learned in REQ-0514 and
 * recorded in CLAUDE.md §18.
 */
export function renderAssPreFix(spec: CaseSpec): string {
  const real = renderAss(spec)
  if (!spec.karaoke) return real
  const fixed = bodyFor(spec.text, projectCueWhitespaceOntoWords(spec.text, WORDS))
  const preFix = bodyFor(spec.text, WORDS)
  if (!real.includes(fixed)) throw new Error('control could not locate the karaoke body')
  return real.split(fixed).join(preFix)
}
