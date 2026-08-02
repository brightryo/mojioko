// REQ-0391 (positioning-redesign Phase 1b) — WYSIWYG overlap + z-order gate.
//
// Under all-\pos MOJIOKO positions every cue itself with NO runtime
// auto-stacking, so time-overlapping same-position cues OVERLAP (render where
// authored, matching the preview) instead of being spread apart by libass'
// fix_collisions.  And because Dialogue emission order = the on-screen z-order,
// the later-emitted cue paints ON TOP.
//
// The historical libass-MarginV path (`forceSelfPositionAll = false`) still
// auto-stacks; the gate burns both to prove the difference is real (it is the
// negative control), replacing REQ-0380's git-checkout-of-pre-fix control.
import { generateAss } from '../../src/main/services/ass-generator'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'
import type { SubtitleEntry, VideoInfo } from '../../src/shared/types'

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1280, heightPx: 720,
  durationSec: 8, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

const burnin = { horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const, verticalMarginPx: 40 }

function cue(id: string, text: string, colorHex: string): SubtitleEntry {
  const base = {
    id, startSec: 2.0, endSec: 5.59, text,
    fontSizePx: 80, textColorHex: colorHex, textAlpha: 100,
    outlineColorHex: '#000000', outlineThicknessPx: 6, outlineAlpha: 100,
    fadeDurationSec: 0, fontId: undefined,
    ...makeEntryLayoutDefaults(), // center / bottom / verticalMarginPx 40
    isDeleted: false, isEdited: false,
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...base, original: { ...base } } as any
}

/**
 * Three fully time-overlapping, SAME-position cues with distinct R/G/B colours
 * and distinct text (so each colour's ink is measurable).  Vertical spread
 * across the three tells overlap (≈0) from stacked (≫0).
 */
export function buildOverlapAss(forceSelfPositionAll: boolean) {
  const entries = [
    cue('a', 'FIRSTCUE', '#ff0000'),
    cue('b', 'SECONDCUE', '#00ff00'),
    cue('c', 'THIRDCUE', '#0000ff'),
  ]
  const ass = generateAss(entries, video, burnin, undefined, 'Arial', false, 'switch', forceSelfPositionAll)
  return { ass, W: video.widthPx, H: video.heightPx }
}

/**
 * Two fully time-overlapping cues with the SAME text at the SAME position:
 * red emitted first, blue emitted last.  Under all-\pos they occupy the exact
 * same pixels, so the later (blue) cue paints over the red one — the visible
 * colour is the z-order proof.
 */
export function buildZOrderAss(forceSelfPositionAll: boolean) {
  const entries = [
    cue('back', 'OVERLAP', '#ff0000'),
    cue('front', 'OVERLAP', '#0000ff'),
  ]
  const ass = generateAss(entries, video, burnin, undefined, 'Arial', false, 'switch', forceSelfPositionAll)
  return { ass, W: video.widthPx, H: video.heightPx }
}

/**
 * REQ-0392 — z-order via the `layer` field OVERRIDES emission order.  Red is
 * emitted FIRST (so plain emission order would paint blue on top) but is given
 * the higher `layer`, so it must paint in front: the visible colour is red.
 */
export function buildLayerOverrideAss() {
  const entries = [
    { ...cue('back', 'OVERLAP', '#ff0000'), layer: 1 },
    { ...cue('front', 'OVERLAP', '#0000ff'), layer: 0 },
  ]
  const ass = generateAss(entries, video, burnin, undefined, 'Arial', false, 'switch', true)
  return { ass, W: video.widthPx, H: video.heightPx }
}
