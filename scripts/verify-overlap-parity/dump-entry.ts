// REQ-0380 — inspect the REAL ASS emit path for time-overlapping animated cues,
// and the preview's stack offsets, from the same shared code the app uses.
import { generateAss } from '../../src/main/services/ass-generator'
import { computeFixedStackOffsets } from '../../src/shared/stack-offsets'
import { estimateCueHeightAssPx } from '../../src/shared/line-spacing'
import { cueMaxRenderedFontAssPx } from '../../src/shared/emphasis'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'
import type { SubtitleEntry, VideoInfo } from '../../src/shared/types'

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1280, heightPx: 720,
  durationSec: 8, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

function cue(id: string, text: string, over: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    id, startSec: 2.0, endSec: 5.59, text,
    fontSizePx: 80, textColorHex: '#ffffff', textAlpha: 100,
    outlineColorHex: '#000000', outlineThicknessPx: 6, outlineAlpha: 100,
    fadeDurationSec: 0, fontId: undefined,
    ...makeEntryLayoutDefaults(),
    isDeleted: false, isEdited: false,
    animationType: 'blur', animationInEnabled: true, animationOutEnabled: true,
    animationDurationSec: 0.8, animationBlurPx: 80,
    ...over,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...base, original: { ...base } } as any
}

export function buildAss(animType: string) {
  // Distinct primary colours so each cue's ink is measurable in the burned frame.
  const entries = [
    cue('a', 'FIRSTCUE', { animationType: animType, textColorHex: '#ff0000' }),
    cue('b', 'SECONDCUE', { animationType: animType, textColorHex: '#00ff00' }),
    cue('c', 'THIRDCUE', { animationType: animType, textColorHex: '#0000ff' }),
  ]
  const ass = generateAss(
    entries, video,
    { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 },
    undefined, 'Arial', false, 'switch',
  )
  // Preview stack offsets (emphasis-aware height, tier off).  Bottom-anchored,
  // so a larger offset = higher up (smaller y).  Convert to a predicted y band
  // top-of-ink is out of scope; we compare ORDER + spacing, not absolute y.
  const offsets = computeFixedStackOffsets(entries, (e) =>
    estimateCueHeightAssPx(e, cueMaxRenderedFontAssPx(e, false)))
  return {
    ass,
    playResX: video.widthPx, playResY: video.heightPx,
    offsets: entries.map((e) => ({ id: e.id, offset: offsets.get(e.id) ?? 0 })),
    dialogues: ass.split('\n').filter((l) => l.startsWith('Dialogue:')),
  }
}
