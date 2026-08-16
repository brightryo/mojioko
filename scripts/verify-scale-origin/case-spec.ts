/**
 * REQ-0514 — the ONE definition of a `verify:scale-origin` case.
 *
 * Imported by BOTH sides of the gate: `dump-entry.ts` (bundled for node, calls
 * the real `generateAss`) and `harness-entry.tsx` (bundled for chromium, feeds
 * the real `VideoPreviewPanel`).  One builder means the burn and the preview
 * cannot be measuring two different cues — which is the whole point of a parity
 * gate.
 */
import { DEFAULT_FONT_ID } from '../../src/shared/fonts'
import {
  animationTransformAt,
  animationWindows,
  resolveAnimation,
} from '../../src/shared/cue-animation'
import type { SubtitleEntry } from '../../src/shared/types'

export const VIDEO_W = 1920
export const VIDEO_H = 1080

/** The cue's own time window; the gate samples inside the entrance ramp. */
export const CUE_START = 1.0
export const CUE_END = 4.0

const LINES: Record<string, string[]> = {
  latin: ['Hello World', 'Second Line'],
  jp: ['こんにちは世界', '字幕のテスト'],
}

export interface CaseSpec {
  h: 'left' | 'center' | 'right'
  v: 'top' | 'center' | 'bottom'
  /** Display lines (1 or 2). */
  L: 1 | 2
  marginV: number
  fs: number
  lineSpacingPercent: number
  script: 'latin' | 'jp'
  rotation: number
  anim: 'scale' | 'pop'
  durationSec: number
  /** STORED start scale percent (0 = grows from nothing). */
  startScalePercent: number
  /** When set the cue is PINNED here in ASS space (= what a drag writes). */
  pin?: { x: number; y: number }
  outline: number
}

export const BASE: CaseSpec = {
  h: 'center', v: 'center', L: 1, marginV: 40, fs: 100, lineSpacingPercent: 0,
  script: 'latin', rotation: 0, anim: 'scale', durationSec: 1,
  startScalePercent: 30, outline: 3,
}

export const VIDEO = {
  path: 'x.mp4', hasVideoStream: true, widthPx: VIDEO_W, heightPx: VIDEO_H,
  durationSec: 6, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

export function cue(spec: CaseSpec): SubtitleEntry {
  const text = LINES[spec.script].slice(0, spec.L).join('\\N')
  const base = {
    id: 'c1', startSec: CUE_START, endSec: CUE_END, text,
    fontSizePx: spec.fs,
    textColorHex: '#ffffff', textAlpha: 100,
    outlineColorHex: '#000000', outlineThicknessPx: spec.outline, outlineAlpha: 100,
    fadeDurationSec: 0,
    fontId: DEFAULT_FONT_ID,
    horizontalPosition: spec.h,
    verticalPosition: spec.v,
    verticalMarginPx: spec.marginV,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 60 },
    lineSpacingPercent: spec.lineSpacingPercent,
    rotation: spec.rotation,
    animationType: spec.anim,
    animationInEnabled: true,
    animationOutEnabled: true,
    animationDurationSec: spec.durationSec,
    animationStartScalePercent: spec.startScalePercent,
    ...(spec.pin ? { posX: spec.pin.x, posY: spec.pin.y } : {}),
    isDeleted: false,
    isEdited: false,
  }
  return { ...base, original: { ...base } } as unknown as SubtitleEntry
}

/** The scale the SHARED animation model is at, at absolute `tSec`. */
export function scaleAt(spec: CaseSpec, tSec: number): number {
  return animationTransformAt(resolveAnimation(cue(spec)), CUE_START, CUE_END, tSec).scale
}

/** The entrance ramp length in seconds, after the shared clamp. */
export function inSecOf(spec: CaseSpec): number {
  return animationWindows(resolveAnimation(cue(spec)), CUE_START, CUE_END).inSec
}
