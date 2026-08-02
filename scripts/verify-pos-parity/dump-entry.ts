/**
 * REQ-0389 (positioning-redesign Phase 1a) — real-generator side of the
 * `verify:pos-parity` gate.
 *
 * Bundled to CJS by index.mjs and `require`d.  It builds real `SubtitleEntry`s
 * and calls the REAL `generateAss` twice per case (REQ-0316 forbids
 * hand-authored ASS fixtures):
 *   - LEGACY: `generateAss(...7)` — today's output.  A single, static,
 *     non-split cue is NOT in the self-position set, so libass places it from
 *     `MarginV` (the "現行 MarginV レンダ").
 *   - POS:    `generateAss(...7, forceSelfPositionAll=true)` — the shadow
 *     seam that routes every cue through `computeCuePlacement` → per-line
 *     `\pos` (the all-`\pos` render Phase 1b adopts).
 *
 * The gate then burns both through libass and compares ink positions in pixels.
 */
import { generateAss } from '../../src/main/services/ass-generator'
import { getFontMeta, DEFAULT_FONT_ID } from '../../src/shared/fonts'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'

/** Real bundled family covering Latin + Japanese; matches the TTF name table. */
export const ASS_FONT_NAME: string = getFontMeta(DEFAULT_FONT_ID).assFontName

export const VIDEO_W = 1920
export const VIDEO_H = 1080

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: VIDEO_W, heightPx: VIDEO_H,
  durationSec: 6, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
}

/** Per-script display-line templates (first line always ≥ 4 code units). */
const LINES: Record<string, string[]> = {
  latin: ['Hello World', 'Second Line', 'Third Row Here'],
  jp: ['こんにちは世界', '字幕のテスト', '三行目の行です'],
  mixed: ['Hello 世界', 'Mix 混在 Line', '三行目 Three'],
}

export interface CaseSpec {
  h: 'left' | 'center' | 'right'
  v: 'top' | 'center' | 'bottom'
  L: 1 | 2 | 3
  marginV: number
  fs: number
  lineSpacing: number
  emphasis: boolean
  script: 'latin' | 'jp' | 'mixed'
  bgBox: boolean
  outline: number
}

function cueText(spec: CaseSpec): string {
  return LINES[spec.script].slice(0, spec.L).join('\\N')
}

function cue(spec: CaseSpec): SubtitleEntry {
  const text = cueText(spec)
  const base = {
    id: 'c1', startSec: 1.0, endSec: 4.0, text,
    fontSizePx: spec.fs,
    textColorHex: '#ffffff', textAlpha: 100,
    outlineColorHex: '#000000', outlineThicknessPx: spec.outline, outlineAlpha: 100,
    fadeDurationSec: 0,
    fontId: DEFAULT_FONT_ID,
    horizontalPosition: spec.h,
    verticalPosition: spec.v,
    verticalMarginPx: spec.marginV,
    subtitleBackground: { enabled: spec.bgBox, color: 'black' as const, opacityPercent: 60 },
    lineSpacingPercent: spec.lineSpacing,
    ...(spec.emphasis
      ? {
          keywordEmphasisEnabled: true,
          emphasisScalePercent: 150,
          emphasisColorHex: '#ffcc00',
          // Emphasise the first 4 code units (inside line 1 for every template).
          emphasisSpans: [{ start: 0, end: 4, text: text.slice(0, 4) }],
        }
      : {}),
    isDeleted: false,
    isEdited: false,
  }
  return { ...base, original: { ...base } } as unknown as SubtitleEntry
}

function burninOf(spec: CaseSpec): BurninPosition {
  return { horizontalPosition: spec.h, verticalPosition: spec.v, verticalMarginPx: spec.marginV }
}

/** Real `generateAss` for both sides of one case. */
export function renderPair(spec: CaseSpec): {
  legacyAss: string
  posAss: string
  expectedLines: number
} {
  const entries = [cue(spec)]
  const burnin = burninOf(spec)
  // isMsix false throughout — keyword emphasis is free-tier
  // (canUseKeywordEmphasisInTier === true) so it renders in both sides anyway,
  // and karaoke is off (no karaokeEnabled cue).
  const legacyAss = generateAss(entries, video, burnin, undefined, ASS_FONT_NAME, false, 'switch')
  const posAss = generateAss(entries, video, burnin, undefined, ASS_FONT_NAME, false, 'switch', true)
  return { legacyAss, posAss, expectedLines: spec.L }
}

/**
 * Negative control (spec §10-2): the POS side is rendered for a cue displaced
 * `shiftPx` from the legacy cue, so a correct gate MUST measure a Δ well above
 * the pass tolerance.  A bottom-anchored line at `marginV + shiftPx` sits
 * `shiftPx` higher than one at `marginV`.
 */
export function renderNegControl(shiftPx: number): { legacyAss: string; posAss: string } {
  const base: CaseSpec = {
    h: 'center', v: 'bottom', L: 1, marginV: 40, fs: 100,
    lineSpacing: 0, emphasis: false, script: 'latin', bgBox: false, outline: 3,
  }
  const legacyAss = generateAss([cue(base)], video, burninOf(base), undefined, ASS_FONT_NAME, false, 'switch')
  const shifted: CaseSpec = { ...base, marginV: base.marginV + shiftPx }
  const posAss = generateAss([cue(shifted)], video, burninOf(shifted), undefined, ASS_FONT_NAME, false, 'switch', true)
  return { legacyAss, posAss }
}
