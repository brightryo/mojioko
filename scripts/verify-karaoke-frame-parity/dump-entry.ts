// REQ-0381 — build the REAL karaoke-sweep ASS from the app's own generateAss,
// so the frame-export parity gate measures the exact colouring the burn-in
// emits.  One long spaceless run → a single `\kf` unit → a smooth continuous
// left-to-right sweep whose red fraction tracks the libass evaluation time.
import { generateAss } from '../../src/main/services/ass-generator'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'
import type { SubtitleEntry, VideoInfo } from '../../src/shared/types'

// Re-export the REAL shipping helpers so the gate exercises the exact
// frame-selection + subtitle-time-alignment logic the exporter uses.
export { displayedFrameSeekSec, frameExportSubtitleFilter } from '../../src/shared/frame-seek'

// Sweep window — kept short so a fraction-of-a-frame time error moves the red
// fraction by a clearly measurable amount (0.6s sweep → 1/30s ≈ 5.5 %).
export const SWEEP_START = 1.0
export const SWEEP_END = 1.6
export const FPS = 30

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1280, heightPx: 720,
  durationSec: 6, fps: FPS, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

export function buildAss(): { ass: string; playResX: number; playResY: number } {
  const base = {
    id: 'k', startSec: SWEEP_START, endSec: SWEEP_END,
    // Single spaceless run of one wide glyph → one karaoke unit → one `\kf`
    // that sweeps continuously, so red fraction ≈ (t − start)/(end − start).
    text: 'MMMMMMMMMMMMMMMMMMMMMMMMMMMMMM',
    fontSizePx: 96,
    // PrimaryColour (spoken / swept) = red; SecondaryColour (unspoken) = white.
    textColorHex: '#ffffff', karaokeHighlightColor: '#ff0000',
    textAlpha: 100, outlineColorHex: '#000000', outlineThicknessPx: 4, outlineAlpha: 100,
    fadeDurationSec: 0, fontId: undefined,
    ...makeEntryLayoutDefaults(),
    isDeleted: false, isEdited: false,
    // No entrance/exit animation — isolate the karaoke clock.
    animationType: 'none' as const, animationInEnabled: false, animationOutEnabled: false,
    // Karaoke ON, sweep style.  No `words` → equal-split fallback over the
    // cue window (resolveKaraokeTiming → 'equal'), a clean uniform sweep.
    karaokeEnabled: true, karaokeStyle: 'sweep' as const,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = { ...base, original: { ...base } } as any as SubtitleEntry
  const ass = generateAss(
    [entry], video,
    { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 },
    undefined, 'Arial', false, 'sweep',
  )
  return { ass, playResX: video.widthPx, playResY: video.heightPx }
}
