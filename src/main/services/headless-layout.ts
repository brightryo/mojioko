/**
 * REQ-0456 — headless auto line-break + vertical overflow guard.
 *
 * The GUI bakes `\N` into `entry.text` at transcription time (`step1.tsx`) via
 * `applyAutoLineBreak`, measured against the video width — so a break the user
 * sees in the preview is the exact break libass burns.  The CLI / MCP paths had
 * no equivalent (renderer-only module), so SRT input and resolution-scaled
 * projects burned with text running off the frame (REQ §0).
 *
 * This module is the headless counterpart, sharing the SAME break core
 * (`shared/line-break-core.ts`) and font metrics (`font-metrics-node.ts`) as the
 * GUI, plus a vertical guard the GUI never had (§2): a cue whose stacked line
 * height exceeds the frame is counted (`warn`), shrunk to fit (`shrink`), or
 * rejected (`error`, thrown by the caller).
 */
import type { SubtitleEntry, VideoInfo } from '../../shared/types'
import { applyAutoLineBreakCore } from '../../shared/line-break-core'
import { estimateCueHeightAssPx } from '../../shared/line-spacing'
import {
  resolveEmphasis,
  clampEmphasisScalePercent,
  cueMaxRenderedFontAssPx,
  type EmphasisRange,
} from '../../shared/emphasis'
import { getLineBreakMetrics } from './font-metrics-node'
import type { LineBreakMetrics } from '../../shared/line-break-core'

/** `--overflow` mode.  `warn` (default) counts, `shrink` fits, `error` rejects. */
export type OverflowMode = 'warn' | 'shrink' | 'error'

export interface LayoutOptions {
  videoWidthPx: number
  videoHeightPx: number
  /** Horizontal wrap margin (`--margin-x`, default `ASS_MARGIN_LR_PX`). */
  marginLrPx: number
  /** Vertical overflow budget margin (`--margin-y`). */
  marginYPx: number
  /** Whether keyword emphasis is tier-allowed for this build (affects wrap width + height). */
  emphasisTierAllowed: boolean
  /**
   * Metrics resolver for a fontId.  Defaults to the on-disk node loader
   * (`getLineBreakMetrics`); tests inject a fake so they need no font files.
   */
  metricsFor?: (fontId: string | undefined) => LineBreakMetrics
}

/** Smallest font size the shrink guard will fall to before giving up. */
const MIN_SHRINK_FONT_PX = 8

/** Emphasis descriptor for a cue, or undefined when it has none / is tier-gated off. */
function emphasisForEntry(
  entry: SubtitleEntry,
  emphasisTierAllowed: boolean,
): { ranges: readonly EmphasisRange[]; scale: number } | undefined {
  if (!emphasisTierAllowed || entry.keywordEmphasisEnabled !== true) return undefined
  const ranges = resolveEmphasis(entry).ranges
  if (ranges.length === 0) return undefined
  return { ranges, scale: clampEmphasisScalePercent(entry.emphasisScalePercent) / 100 }
}

/**
 * Re-run auto line-break on one cue's text at the given width.  Existing `\N`
 * are preserved (each segment is wrapped independently), so a project authored
 * in the GUI keeps its manual breaks and only gains breaks where a line would
 * overflow — and a same-resolution burn is idempotent (byte-identical `\N`).
 */
function wrapEntryText(entry: SubtitleEntry, opts: LayoutOptions): string {
  const metrics = (opts.metricsFor ?? getLineBreakMetrics)(entry.fontId)
  return applyAutoLineBreakCore(
    entry.text,
    entry.fontSizePx,
    entry.outlineThicknessPx,
    opts.videoWidthPx,
    opts.marginLrPx,
    metrics,
    emphasisForEntry(entry, opts.emphasisTierAllowed),
  )
}

/**
 * Apply auto line-break to every non-deleted cue at the OUTPUT width.  Returns a
 * new array (entries are shallow-cloned only when their text changes).
 */
export function autoLineBreakEntries(entries: SubtitleEntry[], opts: LayoutOptions): SubtitleEntry[] {
  return entries.map((e) => {
    if (e.isDeleted) return e
    const text = wrapEntryText(e, opts)
    return text === e.text ? e : { ...e, text }
  })
}

/**
 * REQ-0456 — transcribe-time auto line-break, mirroring the GUI (`step1.tsx`):
 * wrap at the SOURCE video width and write the broken text into BOTH `text` and
 * `original.text` (so a later "reset row" restores the wrapped version).  Fresh
 * cues carry no emphasis, so `emphasisTierAllowed` is irrelevant here.
 */
export function autoLineBreakTranscribedEntries(entries: SubtitleEntry[], opts: LayoutOptions): SubtitleEntry[] {
  return entries.map((e) => {
    if (e.isDeleted) return e
    const text = wrapEntryText(e, opts)
    if (text === e.text) return e
    return { ...e, text, original: { ...e.original, text } }
  })
}

/** Collision-aware rendered height of a cue in ASS px (emphasis-aware). */
function cueHeightPx(entry: SubtitleEntry, emphasisTierAllowed: boolean): number {
  return estimateCueHeightAssPx(entry, cueMaxRenderedFontAssPx(entry, emphasisTierAllowed))
}

/** Shrink one overflowing cue's font size (re-wrapping each step) until it fits or hits the floor. */
function shrinkEntryToFit(entry: SubtitleEntry, opts: LayoutOptions, budgetPx: number): SubtitleEntry {
  let e = entry
  let guard = 0
  while (cueHeightPx(e, opts.emphasisTierAllowed) > budgetPx && e.fontSizePx > MIN_SHRINK_FONT_PX && guard < 100) {
    const nextFs = Math.max(MIN_SHRINK_FONT_PX, Math.floor(e.fontSizePx * 0.94))
    if (nextFs === e.fontSizePx) break
    // Re-wrap at the smaller size: a narrower font fits more per line, so the
    // line count (and thus the height) can drop faster than the size alone.
    const candidate = { ...e, fontSizePx: nextFs }
    e = { ...candidate, text: wrapEntryText(candidate, opts) }
    guard++
  }
  return e
}

export interface VerticalGuardResult {
  entries: SubtitleEntry[]
  /** Cues that overflowed the vertical budget at detection time. */
  overflowCueCount: number
  /** Cues still overflowing AFTER the guard (0 unless shrink hit the font floor / mode≠shrink). */
  remainingOverflowCount: number
}

/**
 * Vertical overflow guard (§2).  A cue overflows when its stacked line height
 * exceeds `videoHeightPx − 2×marginYPx`.  `shrink` reduces the font until it
 * fits; `warn` / `error` leave the cue unchanged (the caller rejects on
 * `error`).  Call AFTER `autoLineBreakEntries` so the line count is final.
 */
export function applyVerticalOverflowGuard(
  entries: SubtitleEntry[],
  mode: OverflowMode,
  opts: LayoutOptions,
): VerticalGuardResult {
  const budgetPx = opts.videoHeightPx - 2 * opts.marginYPx
  let overflowCueCount = 0
  let remainingOverflowCount = 0

  if (budgetPx <= 0) {
    // Degenerate frame / margin — nothing can fit; report all visible cues.
    const visible = entries.filter((e) => !e.isDeleted).length
    return { entries, overflowCueCount: visible, remainingOverflowCount: visible }
  }

  const out = entries.map((e) => {
    if (e.isDeleted) return e
    if (cueHeightPx(e, opts.emphasisTierAllowed) <= budgetPx) return e
    overflowCueCount++
    if (mode === 'shrink') {
      const fitted = shrinkEntryToFit(e, opts, budgetPx)
      if (cueHeightPx(fitted, opts.emphasisTierAllowed) > budgetPx) remainingOverflowCount++
      return fitted
    }
    // warn / error: leave the cue as-is (error is rejected by the caller).
    remainingOverflowCount++
    return e
  })

  return { entries: out, overflowCueCount, remainingOverflowCount }
}

/** Overflow summary included in the `burn` / `run` result JSON (§2). */
export interface OverflowReport {
  mode: OverflowMode
  /** Cues that overflowed the vertical budget (before shrink). */
  overflowCueCount: number
  /** Cues still overflowing after the guard (shrink hit the font floor, or warn/error). */
  remainingOverflowCount: number
  marginX: number
  marginY: number
}

export interface BurnLayoutInput {
  entries: SubtitleEntry[]
  /** The RENDER video (post-resolution-scaling), whose width/height bound the layout. */
  video: VideoInfo
  marginX: number
  marginY: number
  overflowMode: OverflowMode
  emphasisTierAllowed: boolean
}

/**
 * The full headless layout pass for a burn: auto line-break at the output width,
 * then the vertical overflow guard.  Returns the laid-out entries plus the
 * `OverflowReport` for the result JSON.  The caller rejects (throws) when
 * `overflowMode === 'error'` and `overflowCueCount > 0`.
 */
export function layoutForBurn(input: BurnLayoutInput): { entries: SubtitleEntry[]; overflow: OverflowReport } {
  const opts: LayoutOptions = {
    videoWidthPx: input.video.widthPx,
    videoHeightPx: input.video.heightPx,
    marginLrPx: input.marginX,
    marginYPx: input.marginY,
    emphasisTierAllowed: input.emphasisTierAllowed,
  }
  const wrapped = autoLineBreakEntries(input.entries, opts)
  const guarded = applyVerticalOverflowGuard(wrapped, input.overflowMode, opts)
  return {
    entries: guarded.entries,
    overflow: {
      mode: input.overflowMode,
      overflowCueCount: guarded.overflowCueCount,
      remainingOverflowCount: guarded.remainingOverflowCount,
      marginX: input.marginX,
      marginY: input.marginY,
    },
  }
}
