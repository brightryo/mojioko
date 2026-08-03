import type { SubtitleEntry } from '../../shared/types'
import { resolveLayer } from '../../shared/cue-placement'

/**
 * REQ-088 #2: minimum amount of track-time each block is treated as
 * occupying when assigning tracks.  Block elements render with a CSS
 * minimum width of 2 px so very-short blocks remain clickable; that
 * minimum extends the block's visual right edge past its actual endSec.
 * Without reserving the same minimum in the layout, an adjacent block
 * that starts at (or shortly after) endSec sits on the same track and
 * its left edge overlaps the previous block's rendered right edge by
 * 1–2 px — the user reads that as "blocks duplicated on one row."
 *
 * Reserving 0.05 s of track-time (= 2.5 px at the default 50 px/s zoom,
 * 5 px at 100 px/s) gives any visually-adjacent block enough clearance
 * to either (a) sit on a fresh track or (b) start past the rendered
 * right edge of the short block.  Matches MIN_SUBTITLE_DURATION_SEC in
 * shared/cuts.ts — both are "the smallest meaningful duration we treat
 * as a real subtitle."
 */
export const LAYOUT_MIN_BLOCK_SEC = 0.05

export interface TimelinePlacement {
  entry: SubtitleEntry
  /**
   * 0-based track/row index, top → bottom.  REQ-0396: this is the RANK of the
   * cue's stored `layer` among the distinct layers present, DESCENDING — row 0
   * is the highest layer (front, top); the highest index is layer 0 (back,
   * bottom).  Read the row's LAYER value from `TimelineLayout.trackLayers`.
   */
  trackIndex: number
}

export interface TimelineLayout {
  placements: TimelinePlacement[]
  /** Total number of rows (= distinct `layer` values; ≥ 1 when non-empty). */
  trackCount: number
  /**
   * REQ-0396 — the stored `layer` value for each row, indexed by `trackIndex`
   * (row 0 = top = highest layer, last = bottom = lowest/0).  The timeline
   * gutter labels rows with these values so the row number == the layer number.
   */
  trackLayers: number[]
  /** Total horizontal duration (seconds) the timeline should span. */
  totalSec: number
}

/**
 * Per-entry time overrides used by the greedy track allocator (REQ-20260613-002).
 *
 * Background: dragging a clip in the timeline mutates `entry.startSec` /
 * `entry.endSec` on every pointermove tick.  If the greedy sort relies on
 * the live values, the sort order between the dragged clip and another
 * clip at the same time can flip the moment one diverges — greedy then
 * reassigns the lower track to whichever now sorts earlier, and the
 * rendered blocks visually swap rows even though React's `key={id}`
 * reconciliation kept each Block bound to its own entry.  The user
 * perceives this as "the wrong clip moved."
 *
 * By supplying `greedyTimes` for the dragged entry (= its snapshot
 * startSec / endSec at drag-start), the sort key and the interval-fit
 * check both see the PRE-DRAG values, so the dragged clip stays in its
 * starting greedy slot and keeps its trackIndex stable through the
 * entire drag.  The block's *visual* leftPx / widthPx still derive from
 * the live entry values in the caller, so the block follows the cursor
 * laterally — only the vertical row stays pinned.
 *
 * Empty or omitted → identity behaviour (= legacy single-arg call sites
 * are byte-identical).
 */
export interface TimelineLayoutOverrides {
  /** id → times to use for greedy sort + interval check */
  greedyTimes?: ReadonlyMap<string, { startSec: number; endSec: number }>
}

/**
 * Lay entries out into timeline rows where **row = the stored z-order layer**
 * (REQ-0394 introduced row=z-order; REQ-0396 made the row the stored `layer`
 * itself, dropping the automatic time-overlap separation).
 *
 * Each cue's `trackIndex` is the rank of its `resolveLayer` value among the
 * distinct layers present, DESCENDING: the top row (`trackIndex` 0) is the
 * highest layer (front); the bottom row is layer 0 (back).  A cue never leaves
 * the row its own `layer` names — there is no automatic layer movement.  Cues
 * that share a layer share a row (and, if they also overlap in time, overlap
 * on it — the user separates them by changing a layer).  `trackLayers` gives the
 * layer value per row so the gutter can label rows with the layer number.
 *
 * Inputs are not mutated; `placements` preserves input entry order so the caller
 * renders each Block by its own id without re-sorting.  Deleted rows are passed
 * through (the caller filters).  Rows depend only on `layer`, not time, so
 * `minBlockSec` (REQ-088 #2) and `overrides.greedyTimes` (REQ-20260613-002 drag
 * pinning) no longer affect row assignment and are kept only for call-site
 * signature compatibility.
 */
export function layoutEntries(
  entries: readonly SubtitleEntry[],
  fallbackDurationSec: number,
  minBlockSec: number = 0,
  overrides?: TimelineLayoutOverrides,
): TimelineLayout {
  if (entries.length === 0) {
    return { placements: [], trackCount: 0, trackLayers: [], totalSec: Math.max(1, fallbackDurationSec) }
  }

  // REQ-0396 — rows ARE the stored z-order layer (no auto-separation).  A cue's
  // `trackIndex` is the RANK of its `resolveLayer` value among the distinct
  // layers present, ordered DESCENDING: the TOP row (trackIndex 0) is the
  // highest layer (front); the BOTTOM row is layer 0 (back).  A cue therefore
  // never leaves the row its own `layer` names — no automatic layer movement.
  //
  // Cues that share a layer occupy the SAME row.  If two such cues overlap in
  // time their blocks overlap horizontally on that row (WYSIWYG — they also
  // overlap in the burn at the same z-order); the user separates them by moving
  // one to another layer (inspector "bring to front / send to back").
  //
  // Because rows depend only on `layer` (not on time), a horizontal drag never
  // changes a cue's row — so the old `greedyTimes` drag row-pinning is no longer
  // needed.  `minBlockSec` / `overrides` are retained only for call-site
  // signature compatibility.
  void minBlockSec
  void overrides
  const distinct = Array.from(new Set(entries.map((e) => resolveLayer(e))))
    .sort((a, b) => b - a) // DESC → highest layer = row 0 = top = front; layer 0 at bottom
  const rankOf = new Map<number, number>(distinct.map((v, i) => [v, i]))

  const placements: TimelinePlacement[] = entries.map((e) => ({
    entry: e,
    trackIndex: rankOf.get(resolveLayer(e)) ?? 0,
  }))

  // totalSec is sourced from the LIVE entry endSecs — the visible timeline width
  // must always accommodate the rightmost block as the user sees it.
  const maxEntryEnd = entries.reduce((m, e) => (e.endSec > m ? e.endSec : m), 0)
  const totalSec = Math.max(fallbackDurationSec, maxEntryEnd)

  return {
    placements,
    trackCount: distinct.length,
    trackLayers: distinct,
    totalSec,
  }
}

/**
 * Choose a sensible major-tick interval for the ruler based on the current
 * zoom (pixels per second).  Returns the interval in seconds.
 *
 * Targets ~80–160 px between adjacent major ticks at the chosen interval —
 * dense enough for reference but not crowded.
 */
export function chooseRulerStepSec(pixelsPerSec: number): number {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  const targetPx = 100
  for (const c of candidates) {
    if (c * pixelsPerSec >= targetPx) return c
  }
  return candidates[candidates.length - 1]
}

/**
 * Format a timestamp for ruler labels.  Compact form: "M:SS" for sub-hour
 * spans, "H:MM:SS" once we cross the hour mark.  Sub-second steps add a
 * one-digit decimal.
 */
export function formatRulerLabel(sec: number, stepSec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const showDecimals = stepSec < 1
  const secStr = showDecimals
    ? ss.toFixed(1).padStart(4, '0')
    : Math.floor(ss).toString().padStart(2, '0')
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${secStr}`
  }
  return `${m}:${secStr}`
}
