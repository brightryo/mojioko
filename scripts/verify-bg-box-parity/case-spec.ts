/**
 * REQ-0535 — the ONE definition of a `verify:bg-box-parity` case.
 *
 * Imported by BOTH sides: `dump-entry.ts` (bundled for node, calls the real
 * `generateAss`) and `harness-entry.tsx` (bundled for chromium, feeds the real
 * preview overlay).  One builder means the burn and the preview cannot be
 * measuring two different cues.
 */
import { DEFAULT_FONT_ID } from '../../src/shared/fonts'
import type { SubtitleEntry } from '../../src/shared/types'

export const VIDEO_W = 1920
export const VIDEO_H = 1080
/**
 * The cue covers t = 0 deliberately, and the sample is taken there.
 *
 * The preview harness serves its video over a plain HTTP handler with no Range
 * support, so chromium refuses to seek and `currentTime` stays pinned at 0 —
 * measured, after a seek that silently did nothing.  Sampling the first frame
 * removes the seek from the gate entirely.  Nothing here is time-dependent:
 * `fadeDurationSec` is 0 and no case uses an entrance animation, so frame 0 is
 * the cue's settled state on both sides.
 */
export const CUE_START = 0
export const CUE_END = 5.0
export const SAMPLE_SEC = 0

export const VIDEO = {
  path: 'x.mp4', hasVideoStream: true, widthPx: VIDEO_W, heightPx: VIDEO_H,
  durationSec: 6, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

/**
 * Mid-grey source.  A background box at opacity p over this grey lands at a
 * value the gate can PREDICT (`128 × (1 − p)`), which is what lets it judge
 * "one uniform layer" by absolute value instead of by preview/burn agreement.
 * REQ-0535 §2 is explicit that agreement alone is not evidence.
 */
export const SOURCE_GREY = 128

export interface CaseSpec {
  name: string
  /** Cue text; `\N` makes the hard-break cases. */
  text: string
  /** 行間 %, the REQ-0332 field.  Non-zero also splits the cue into events. */
  spacing: number
  /** `\bord`; also the box's padding, so it drives how far boxes overlap. */
  outline: number
  /** Background opacity %, < 100 so double-compositing is visible at all. */
  opacity: number
  fontSizePx: number
  /** REQ-0537 — cue rotation in degrees; 0 / absent keeps the upright cases. */
  rotation?: number
}

export const CASES: readonly CaseSpec[] = [
  // The owner's report: two lines, black box, translucent, default spacing.
  { name: 'hard-break, spacing 0', text: 'AAAA\\NAAAA', spacing: 0, outline: 8, opacity: 60, fontSizePx: 60 },
  // Negative spacing pulls the lines together, widening the overlap band.
  { name: 'hard-break, spacing -20', text: 'AAAA\\NAAAA', spacing: -20, outline: 8, opacity: 60, fontSizePx: 60 },
  // Positive spacing pushes them apart: at +40 the boxes separate entirely,
  // so this case has NO overlap band and guards the opposite failure (a gate
  // that "fixes" the seam by painting the gap would break this one).
  { name: 'hard-break, spacing +40', text: 'AAAA\\NAAAA', spacing: 40, outline: 8, opacity: 60, fontSizePx: 60 },
  // Three lines: two seams, so a fix that only handles the first is caught.
  { name: 'three lines', text: 'AAAA\\NAAAA\\NAAAA', spacing: 0, outline: 8, opacity: 60, fontSizePx: 60 },
  // A thin outline still overlaps by exactly 2×bord at spacing 0.
  { name: 'thin outline', text: 'AAAA\\NAAAA', spacing: 0, outline: 3, opacity: 60, fontSizePx: 60 },
  // REQ-0537 §2 — rotation was never covered by REQ-0535, and the owner saw the
  // stripe on a rotated cue.  `\frz` moves every line's box, so the seam between
  // them is computed from rotated anchors; nothing else in the matrix exercises
  // that.
  { name: 'rotated 15deg', text: 'AAAA\\NAAAA', spacing: 0, outline: 8, opacity: 60, fontSizePx: 60, rotation: 15 },
]

export function cue(spec: CaseSpec): SubtitleEntry {
  const base = {
    id: 'c1', startSec: CUE_START, endSec: CUE_END, text: spec.text,
    fontSizePx: spec.fontSizePx,
    textColorHex: '#ffffff', textAlpha: 100,
    outlineColorHex: '#ff0000', outlineThicknessPx: spec.outline, outlineAlpha: 100,
    fadeDurationSec: 0,
    fontId: DEFAULT_FONT_ID,
    horizontalPosition: 'center' as const,
    verticalPosition: 'center' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: true, color: 'black' as const, opacityPercent: spec.opacity },
    lineSpacingPercent: spec.spacing,
    rotation: spec.rotation ?? 0,
    words: [],
    karaokeEnabled: false,
    karaokeHighlightColor: '#ffffff',
    karaokeStyle: 'switch' as const,
    isDeleted: false, isEdited: false,
  }
  return { ...base, original: { ...base } } as unknown as SubtitleEntry
}
