/**
 * REQ-0556 §2 — the two wrap operations, as one shared decision.
 *
 * ## What was already shared, and what was not
 *
 * The break-finding core (`line-break-core.ts`) and the font metrics behind it
 * have been shared since REQ-0456 / REQ-0537: the GUI measures through
 * `renderer/lib/font-metrics.ts`, headless through `font-metrics-node.ts`, and
 * both feed the same `applyAutoLineBreakCore`.
 *
 * What was NOT shared is the small amount of preparation that distinguishes the
 * two buttons — and it is exactly where the two modes differ:
 *
 *   - 敷き詰め (`pack`)     — strip every existing `\N` first, so the core sees
 *                             one long line, and MAP THE EMPHASIS RANGES onto
 *                             the collapsed coordinates.
 *   - はみ出し (`overflow`) — pass the text through with its `\N` intact; the
 *                             core wraps each segment independently.
 *
 * That range mapping is the subtle part (REQ-0306 §2 / REQ-0307): a cue with
 * enlarged emphasised glyphs must be measured at the enlarged size or the wrap
 * button reports "no change" on a line that visibly overflows. In `pack` mode
 * the ranges are anchored to the ORIGINAL text, so deleting the `\N` shifts
 * every offset after them — left unmapped, the emphasis is measured on the
 * wrong characters.
 *
 * Reimplementing that headlessly and getting it slightly wrong would produce a
 * wrap that differs from the preview only on emphasised cues — which is the
 * kind of divergence nobody notices until a burn looks wrong. So it lives here
 * once, and both callers reach it.
 */

import { applyAutoLineBreakCore, type LineBreakMetrics } from './line-break-core'
import {
  clampEmphasisScalePercent,
  mapRangesAcrossBreakCollapse,
  resolveEmphasisRanges,
  type EmphasisRange,
} from './emphasis'
import type { SubtitleEntry } from './types'

/**
 * Which wrap the caller wants.
 *
 * - `pack`     — 敷き詰め改行: discard the user's manual breaks and re-fill.
 * - `overflow` — はみ出し改行: keep every manual break, add breaks only where a
 *                segment overflows.
 */
export type CueWrapMode = 'pack' | 'overflow'

export interface CueWrapOptions {
  videoWidthPx: number
  /** Horizontal wrap margin. The GUI's `applyAutoLineBreak` defaults to `ASS_MARGIN_LR_PX`. */
  marginLrPx: number
  /** Metrics for the cue's effective font — the caller supplies its surface's loader. */
  metrics: LineBreakMetrics
  /**
   * Whether keyword emphasis is tier-allowed for this build. A free build that
   * will not RENDER the enlarged glyphs must not MEASURE them either, or the
   * headless wrap would differ from what is actually burned.
   */
  emphasisTierAllowed?: boolean
}

/**
 * The emphasis descriptor to measure this cue with, in the coordinate system
 * the wrapped input will actually use.
 */
function emphasisFor(
  entry: SubtitleEntry,
  mode: CueWrapMode,
  emphasisTierAllowed: boolean,
): { ranges: readonly EmphasisRange[]; scale: number } | undefined {
  if (!emphasisTierAllowed || entry.keywordEmphasisEnabled !== true) return undefined
  const resolved = resolveEmphasisRanges(entry)
  if (resolved.length === 0) return undefined
  const ranges = mode === 'pack'
    // `pack` deletes every `\N`, which shifts every offset after each one.
    ? mapRangesAcrossBreakCollapse(entry.text, resolved, 0)
    : resolved
  return { ranges, scale: clampEmphasisScalePercent(entry.emphasisScalePercent) / 100 }
}

/**
 * Compute the wrapped text for one cue. Pure: no store, no I/O, no toast.
 *
 * Returns the new text, which may be identical to `entry.text` — "no change" is
 * a real and common answer (the GUI shows a toast for it), so callers must
 * compare rather than assume a change happened.
 */
export function wrapCueText(
  entry: SubtitleEntry,
  mode: CueWrapMode,
  opts: CueWrapOptions,
): string {
  const input = mode === 'pack' ? entry.text.replace(/\\N/g, '') : entry.text
  return applyAutoLineBreakCore(
    input,
    entry.fontSizePx,
    entry.outlineThicknessPx,
    opts.videoWidthPx,
    opts.marginLrPx,
    opts.metrics,
    emphasisFor(entry, mode, opts.emphasisTierAllowed ?? true),
  )
}
