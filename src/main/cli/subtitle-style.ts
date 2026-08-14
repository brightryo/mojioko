/**
 * REQ-0457 A1/A2 — resolve the FULL subtitle style an agent needs to confirm
 * "what will be burned" before spending minutes on a burn.
 *
 * `status` used to expose only 5 fields.  This builds a representative cue via
 * the SAME seeding path burn/transcribe use (`entriesFromSegments`), then
 * summarises every style axis (karaoke / emphasis / animation / shadow /
 * rotation / alpha / line-spacing / offset) with the documented neutral
 * fallbacks — so the summary equals what a burned cue actually renders.
 */
import { entriesFromSegments } from './subtitle-io'
import { resolveAnimation } from '../../shared/cue-animation'
import { resolveKaraokeStyle, KARAOKE_STYLE_DEFAULT } from '../../shared/karaoke-style'
import { KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../shared/karaoke-gate'
import { EMPHASIS_DEFAULT_COLOR, clampEmphasisScalePercent } from '../../shared/emphasis'
import type { SubtitleEntry, VideoInfo } from '../../shared/types'
import type { loadSettings } from '../services/settings-store'

type AppSettings = Awaited<ReturnType<typeof loadSettings>>

export interface SubtitleStyleSummary {
  fontId: string
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  outlineThicknessPx: number
  autoLineBreak: boolean
  shadow: { depthPx: number; color: string; alphaPercent: number }
  textAlphaPercent: number
  outlineAlphaPercent: number
  rotationDeg: number
  casing: string
  lineSpacingPercent: number
  position: { horizontal: string; vertical: string; verticalMarginPx: number; posX: number | null; posY: number | null }
  karaoke: { enabled: boolean; style: string; highlightColor: string }
  emphasis: { enabled: boolean; color: string; scalePercent: number }
  animation: { type: string; inEnabled: boolean; outEnabled: boolean; durationSec: number; startScalePercent: number; blurPx: number }
  /**
   * REQ-0500 §1-2 — background box and z-order, the two remaining axes a GUI
   * user can set that this summary did not expose.  Added here rather than in a
   * second per-cue projection: `read_subtitle --with-style` reuses this exact
   * function, and a parallel summariser is precisely the drift this codebase
   * keeps paying for (`style-defaults-to-entry.ts` documents four instances).
   */
  background: { enabled: boolean; color: string; opacityPercent: number }
  layer: number
}

/** Summarise one cue's resolved style (neutral fallbacks match the ASS writer). */
export function summarizeSubtitleStyle(entry: SubtitleEntry, autoLineBreak: boolean): SubtitleStyleSummary {
  const anim = resolveAnimation(entry)
  return {
    fontId: entry.fontId ?? 'noto-sans-jp-semibold',
    fontSizePx: entry.fontSizePx,
    textColorHex: entry.textColorHex,
    outlineColorHex: entry.outlineColorHex,
    outlineThicknessPx: entry.outlineThicknessPx,
    autoLineBreak,
    shadow: { depthPx: entry.shadowDepth ?? 0, color: entry.shadowColor ?? '#000000', alphaPercent: entry.shadowAlpha ?? 100 },
    textAlphaPercent: entry.textAlpha ?? 100,
    outlineAlphaPercent: entry.outlineAlpha ?? 100,
    rotationDeg: entry.rotation ?? 0,
    casing: entry.casing ?? 'none',
    lineSpacingPercent: entry.lineSpacingPercent ?? 0,
    position: {
      horizontal: entry.horizontalPosition,
      vertical: entry.verticalPosition,
      verticalMarginPx: entry.verticalMarginPx,
      posX: entry.posX ?? null,
      posY: entry.posY ?? null,
    },
    karaoke: {
      enabled: entry.karaokeEnabled === true,
      style: resolveKaraokeStyle(entry.karaokeStyle, KARAOKE_STYLE_DEFAULT),
      highlightColor: entry.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR,
    },
    emphasis: {
      enabled: entry.keywordEmphasisEnabled === true,
      color: entry.emphasisColorHex ?? EMPHASIS_DEFAULT_COLOR,
      scalePercent: clampEmphasisScalePercent(entry.emphasisScalePercent),
    },
    animation: {
      type: anim.type,
      inEnabled: anim.inEnabled,
      outEnabled: anim.outEnabled,
      durationSec: anim.durationSec,
      startScalePercent: Math.round(anim.startScale * 100),
      blurPx: anim.blurMaxPx,
    },
    background: {
      enabled: entry.subtitleBackground?.enabled === true,
      color: entry.subtitleBackground?.color ?? 'black',
      opacityPercent: entry.subtitleBackground?.opacityPercent ?? 50,
    },
    // `undefined` ≡ 0 (`resolveLayer`); higher = nearer the front.
    layer: entry.layer ?? 0,
  }
}

/** A synthetic 1920×1080 canvas for resolving the default style (offsets need dims). */
const SYNTHETIC_VIDEO: VideoInfo = {
  path: '', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 0, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}

/**
 * The resolved DEFAULT subtitle style (from AppSettings) — what a fresh cue /
 * an SRT-seeded cue gets.  Reported by `status` (A1) and `burn`/`run` (A2).
 */
export function resolveDefaultSubtitleStyle(settings: AppSettings): SubtitleStyleSummary {
  const fontId = settings.activeFontId ?? 'noto-sans-jp-semibold'
  const [entry] = entriesFromSegments(
    [{ startSec: 0, endSec: 1, text: 'x' }],
    settings.transcriptionDefaults,
    SYNTHETIC_VIDEO,
    fontId,
    settings.fadeDurationSec ?? 0,
  )
  return summarizeSubtitleStyle(entry, settings.autoLineBreak ?? true)
}
