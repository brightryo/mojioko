/**
 * REQ-0536 — burn side of the rotation-edge measurement.
 *
 * The `glyph` / `border` subjects go through the REAL `generateAss`, so what is
 * measured is the ASS production actually emits (REQ-0316). The `shape` subject
 * has no production counterpart — MOJIOKO never emits a rotated `\p1` drawing —
 * so it is authored here, explicitly as a control for libass's rasteriser.
 */
import { generateAss } from '../../src/main/services/ass-generator'
import { FONT_REGISTRY as REGISTRY, getFontMeta, type FontId } from '../../src/shared/fonts'
import { buildEncoderArgs } from '../../src/shared/encode-quality'
import type { BurninPosition, SubtitleEntry, VideoInfo } from '../../src/shared/types'

/** The app's own encoder arguments, so the encoded stage is the real one. */
export function encoderArgs(encoder: string): string[] {
  return buildEncoderArgs(encoder as Parameters<typeof buildEncoderArgs>[0])
}

export const VIDEO_W = 1920
export const VIDEO_H = 1080

const VIDEO = {
  path: 'x.mp4', hasVideoStream: true, widthPx: VIDEO_W, heightPx: VIDEO_H,
  durationSec: 6, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}
const burnin: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'center', verticalMarginPx: 40,
}

/** The registry, flattened to what the harness needs to locate a TTF. */
export const FONTS = REGISTRY.map((f) => ({
  id: f.id,
  displayName: f.displayName,
  fileName: f.fileName,
  assFontName: f.assFontName,
}))

export interface CueOpts {
  fontId: string
  rotation: number
  /** `glyph` = no outline (body only); `border` = thick outline, outer edge. */
  mode: 'glyph' | 'border'
  /**
   * REQ-0536 §2 candidate (c) — render everything at N x and downscale.  The
   * cue's sizes scale with the frame so the result is the SAME picture at a
   * higher sampling rate, which is the whole point of supersampling.
   */
  scale?: number
}

/**
 * A single cue.  `I` repeated: a tall straight stem is the cleanest straight
 * edge a font offers, so the metric measures the font's own edge rather than a
 * curve's changing tangent.
 */
function cue(o: CueOpts): SubtitleEntry {
  const k = o.scale ?? 1
  const base = {
    id: 'c1', startSec: 0, endSec: 2, text: 'IIII',
    fontSizePx: 300 * k,
    textColorHex: '#ffffff', textAlpha: 100,
    outlineColorHex: '#ffffff',
    outlineThicknessPx: o.mode === 'border' ? 20 * k : 0,
    outlineAlpha: 100,
    fadeDurationSec: 0,
    fontId: o.fontId,
    horizontalPosition: 'center' as const,
    verticalPosition: 'center' as const,
    verticalMarginPx: 40 * k,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 60 },
    lineSpacingPercent: 0,
    rotation: o.rotation,
    words: [], karaokeEnabled: false,
    karaokeHighlightColor: '#ffffff', karaokeStyle: 'switch' as const,
    isDeleted: false, isEdited: false,
  }
  return { ...base, original: { ...base } } as unknown as SubtitleEntry
}

export function cueAss(o: CueOpts): string {
  const k = o.scale ?? 1
  const video = { ...VIDEO, widthPx: VIDEO_W * k, heightPx: VIDEO_H * k }
  return generateAss(
    [cue(o)], video as unknown as VideoInfo, burnin, undefined,
    getFontMeta(o.fontId as FontId).assFontName, true, 'switch',
  )
}

/**
 * CONTROL — a rotated rectangle drawn with `\p1`.
 *
 * No font is involved, so a jagged edge here would be libass's rasteriser or
 * its `\frz` transform, and a clean edge here rules both of those out.
 */
export function shapeAss(rotationDeg: number, w: number, h: number): string {
  const frz = rotationDeg === 0 ? '' : `\\frz${(360 - rotationDeg) % 360}`
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${w}
PlayResY: ${h}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Shape,Arial,100,&H00FFFFFF,&H00FFFFFF,1,0,0,5,0,0,0,1

[Events]
Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Shape,0,0,0,,{\\an5\\pos(${w / 2},${h / 2})\\bord0\\shad0\\1c&HFFFFFF&${frz}\\p1}m 0 0 l 120 0 l 120 600 l 0 600{\\p0}
`
}
