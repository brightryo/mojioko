import type { SubtitleEntry } from '../../shared/types'
import { resolveLayer, MIN_LAYER, MAX_LAYER } from '../../shared/cue-placement'

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
   * 0-based track/row index, top → bottom.  REQ-0402: rows are CONTIGUOUS layer
   * values (no gaps), so `trackIndex = maxRow − resolveLayer(entry)` — row 0 is
   * the top (highest layer shown), the last row is layer 0 (bottom).  Read the
   * row's LAYER value from `TimelineLayout.trackLayers`.
   */
  trackIndex: number
}

export interface TimelineLayout {
  placements: TimelinePlacement[]
  /** Total number of rows (= `maxRow + 1`, contiguous 0..maxRow; ≥ 2 when non-empty). */
  trackCount: number
  /**
   * REQ-0402 — the `layer` value for each row, indexed by `trackIndex`
   * (row 0 = top = highest layer shown = `maxRow`; last = bottom = 0).  Rows are
   * CONTIGUOUS: `trackLayers` is `[maxRow, maxRow−1, …, 1, 0]`, so the gutter
   * numbering never skips a layer even when no cue occupies it.
   */
  trackLayers: number[]
  /** Total horizontal duration (seconds) the timeline should span. */
  totalSec: number
}

/**
 * REQ-0402 — the top row index of the timeline: `min(MAX_LAYER, maxOccupied + 1)`.
 * Rows run contiguously from 0 (bottom) up to this value (top), so there is
 * always ONE empty spare track above the highest occupied layer to drag a clip
 * into (and it grows/shrinks as the max occupied layer changes), while never
 * exceeding the z-order cap of 50.  Returns 0 for an empty timeline.
 *
 * Shared with the vertical-drag handler (`timeline-view.tsx`) so the drag clamps
 * a clip to exactly the same rows the layout renders.
 */
export function timelineMaxRow(entries: readonly SubtitleEntry[]): number {
  if (entries.length === 0) return 0
  let maxOccupied = MIN_LAYER
  for (const e of entries) {
    const l = resolveLayer(e)
    if (l > maxOccupied) maxOccupied = l
  }
  maxOccupied = Math.min(MAX_LAYER, Math.max(MIN_LAYER, maxOccupied))
  return Math.min(MAX_LAYER, maxOccupied + 1)
}

/**
 * Lay entries out into timeline rows where **row = the stored z-order layer**
 * (REQ-0394 introduced row=z-order; REQ-0396 made the row the stored `layer`
 * itself; REQ-0402 made the rows CONTIGUOUS).
 *
 * Rows run 0..`maxRow` where `maxRow = timelineMaxRow(entries)` (= the highest
 * occupied layer + one spare, capped at 50).  They are contiguous — EVERY layer
 * in that range gets a row, even one no cue occupies — so the gutter numbering
 * never skips (the REQ-0399 "1 → 3 with no track 2" jump is gone) and there is
 * always a spare track above to drag a clip into.  A cue's `trackIndex` is
 * `maxRow − resolveLayer(entry)`: the TOP row (trackIndex 0) is the highest
 * layer shown (front); the BOTTOM row is layer 0 (back).  Cues that share a
 * layer share a row (and overlap on it if they also overlap in time — the user
 * separates them by changing a layer).  `trackLayers` gives the layer per row.
 *
 * Inputs are not mutated; `placements` preserves input entry order so the caller
 * renders each Block by its own id without re-sorting.  Deleted rows are passed
 * through (the caller filters).  Rows depend only on `layer`, not time, so
 * `minBlockSec` (REQ-088 #2) no longer affects row assignment and is kept only
 * for call-site signature compatibility.  (REQ-0466 §1 removed the vestigial
 * `greedyTimes` drag-pin override, which the layer-based rows had made a no-op.)
 */
export function layoutEntries(
  entries: readonly SubtitleEntry[],
  fallbackDurationSec: number,
  minBlockSec: number = 0,
): TimelineLayout {
  if (entries.length === 0) {
    return { placements: [], trackCount: 0, trackLayers: [], totalSec: Math.max(1, fallbackDurationSec) }
  }

  // REQ-0402 — rows are CONTIGUOUS layer values 0..maxRow (bottom→top), no gaps.
  // `trackIndex = maxRow − layer` places a cue on its layer's row; the extra
  // spare row at `maxRow` (= highest occupied + 1) is what a clip is dragged
  // into to raise its z-order.  Legacy layers above the cap clamp onto the top.
  //
  // Because rows depend only on `layer` (not on time), a horizontal drag never
  // changes a cue's row — so the old `greedyTimes` drag row-pinning was removed
  // (REQ-0466 §1).  `minBlockSec` is retained only for call-site signature
  // compatibility.
  void minBlockSec
  const maxRow = timelineMaxRow(entries)
  const rowCount = maxRow + 1
  // Top → bottom: [maxRow, maxRow−1, …, 1, 0].
  const trackLayers = Array.from({ length: rowCount }, (_, i) => maxRow - i)

  const placements: TimelinePlacement[] = entries.map((e) => {
    const layer = Math.min(maxRow, Math.max(MIN_LAYER, resolveLayer(e)))
    return { entry: e, trackIndex: maxRow - layer }
  })

  // totalSec is sourced from the LIVE entry endSecs — the visible timeline width
  // must always accommodate the rightmost block as the user sees it.
  const maxEntryEnd = entries.reduce((m, e) => (e.endSec > m ? e.endSec : m), 0)
  const totalSec = Math.max(fallbackDurationSec, maxEntryEnd)

  return {
    placements,
    trackCount: rowCount,
    trackLayers,
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
