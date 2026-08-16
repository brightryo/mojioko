/**
 * REQ-0515 — the ONE definition of a `verify:text-whitespace` case.
 *
 * Imported by BOTH sides of the gate: `dump-entry.ts` (bundled for node, calls
 * the real `generateAss`) and `harness-entry.tsx` (bundled for chromium, feeds
 * the real `VideoPreviewPanel`).  One builder means the burn and the preview
 * cannot be measuring two different cues.
 */
import { DEFAULT_FONT_ID } from '../../src/shared/fonts'
import type { SubtitleEntry, WordSpan } from '../../src/shared/types'

export const VIDEO_W = 1920
export const VIDEO_H = 1080
export const CUE_START = 1.0
export const CUE_END = 4.0
/** Sampled well inside the cue, after both words have activated. */
export const SAMPLE_SEC = 3.5

export const VIDEO = {
  path: 'x.mp4', hasVideoStream: true, widthPx: VIDEO_W, heightPx: VIDEO_H,
  durationSec: 6, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

/**
 * The transcription-time word list.  Note it spells 「テストです」 with NO
 * whitespace — that is the whole point: every case below edits only `text`,
 * which is exactly what the owner did, and `areWordsValidForText` keeps
 * returning true because it strips whitespace before comparing.
 */
export const WORDS: readonly WordSpan[] = [
  { text: 'テスト', startSec: 1.0, endSec: 2.0 },
  { text: 'です', startSec: 2.0, endSec: 3.0 },
]

export interface CaseSpec {
  /** The cue text the user is looking at. */
  text: string
  /** Karaoke toggle.  OFF is the reference: it always drew `text` verbatim. */
  karaoke: boolean
}

export function cue(spec: CaseSpec): SubtitleEntry {
  const base = {
    id: 'c1', startSec: CUE_START, endSec: CUE_END, text: spec.text,
    fontSizePx: 100,
    textColorHex: '#ffffff', textAlpha: 100,
    // Outline 0 and a black background: the only ink is the glyph fill, so an
    // ink gap IS a whitespace gap.
    outlineColorHex: '#000000', outlineThicknessPx: 0, outlineAlpha: 100,
    fadeDurationSec: 0,
    fontId: DEFAULT_FONT_ID,
    horizontalPosition: 'center' as const,
    verticalPosition: 'center' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 60 },
    words: WORDS,
    karaokeEnabled: spec.karaoke,
    // Both karaoke colours白 so the measurement is "is there ink", never
    // "which colour" — the sweep's timing is `karaoke-frame-parity`'s subject.
    karaokeHighlightColor: '#ffffff',
    karaokeStyle: 'switch' as const,
    isDeleted: false, isEdited: false,
  }
  // `original` keeps the transcription-time text AND times, so
  // `resolveKaraokeTiming` sees untouched times: the user edited only text.
  // That is the state the bug lives in — real word timings still in force.
  return {
    ...base,
    original: { ...base, text: 'テストです' },
  } as unknown as SubtitleEntry
}
