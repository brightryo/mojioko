import type { SubtitleEntry } from '../../shared/types'
import { computeEffectiveLayers } from '../../shared/effective-layer'

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
  /** 0-based track index. Higher = lower visually. */
  trackIndex: number
}

export interface TimelineLayout {
  placements: TimelinePlacement[]
  /** Total number of tracks needed (always ≥ 1 when entries is non-empty). */
  trackCount: number
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
 * Lay entries out into timeline rows where **row order = z-order** (REQ-0394).
 *
 * Each cue's `trackIndex` is the rank of its EFFECTIVE layer
 * (`computeEffectiveLayers` — stored `layer` intent + time-overlap separation)
 * among the distinct layers present, ordered DESCENDING: the top row
 * (`trackIndex` 0) is the front-most layer, layer 0 sits at the bottom.  Because
 * overlapping cues always get distinct effective layers, cues sharing a row
 * never overlap in time, so their blocks never collide — the property the old
 * greedy time-packer provided, now expressed as z-order.
 *
 * Inputs are not mutated; `placements` preserves input entry order so the caller
 * renders each Block by its own id without re-sorting.  Deleted rows are passed
 * through (the caller filters).  `minBlockSec` (REQ-088 #2) no longer affects row
 * assignment and is retained only for call-site compatibility.
 */
export function layoutEntries(
  entries: readonly SubtitleEntry[],
  fallbackDurationSec: number,
  minBlockSec: number = 0,
  overrides?: TimelineLayoutOverrides,
): TimelineLayout {
  if (entries.length === 0) {
    return { placements: [], trackCount: 0, totalSec: Math.max(1, fallbackDurationSec) }
  }

  const greedyTimes = overrides?.greedyTimes
  // REQ-0394 — rows ARE z-order now.  A cue's `trackIndex` is the RANK of its
  // EFFECTIVE layer (`computeEffectiveLayers` = stored `layer` intent + overlap
  // separation) among the distinct layers present, ordered DESCENDING: the TOP
  // row (trackIndex 0) is the front-most (highest) layer and layer 0 sits at the
  // BOTTOM.  Overlapping cues always get distinct effective layers → distinct
  // rows, so blocks on one row never collide (the property the old greedy time
  // packer provided, now expressed through z-order).
  //
  // REQ-20260613-002 drag pinning: `greedyTimes` is forwarded as the effective-
  // layer time override, so a dragged cue's overlap (and therefore its row) is
  // computed from its snapshot times and does not jump mid-drag.  The block's
  // live leftPx/widthPx still come from the caller, so it follows the cursor
  // laterally while its row stays pinned until pointer-up resettles it.
  //
  // `minBlockSec` no longer affects row assignment (rows are z-order, not a time
  // packing).  It is retained in the signature for call-site compatibility.
  void minBlockSec
  const effLayers = computeEffectiveLayers(entries, greedyTimes)
  const distinct = Array.from(new Set(entries.map((e) => effLayers.get(e.id) ?? 0)))
    .sort((a, b) => b - a) // DESC → highest layer = row 0 = top = front
  const rankOf = new Map<number, number>(distinct.map((v, i) => [v, i]))

  const placements: TimelinePlacement[] = entries.map((e) => ({
    entry: e,
    trackIndex: rankOf.get(effLayers.get(e.id) ?? 0) ?? 0,
  }))

  // totalSec is sourced from the LIVE entry endSecs — the visible timeline width
  // must always accommodate the rightmost block as the user sees it.
  const maxEntryEnd = entries.reduce((m, e) => (e.endSec > m ? e.endSec : m), 0)
  const totalSec = Math.max(fallbackDurationSec, maxEntryEnd)

  return {
    placements,
    trackCount: distinct.length,
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
