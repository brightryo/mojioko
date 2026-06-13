import type { SubtitleEntry } from '../../shared/types'

/**
 * Floating-point tolerance (seconds) when comparing one block's end to the
 * next block's start.  Whisper output frequently has `A.endSec === B.startSec`
 * (contiguous segments); we treat exact contact — and contact within this
 * tolerance — as non-overlapping so the two blocks share a track.  A genuine
 * overlap of more than this tolerance still forces a new track.
 */
const TIME_EPS_SEC = 1e-3

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
 * Stable tiebreaker for entries that share `startSec`.  Sorting by id keeps
 * the greedy track assignment deterministic across renders so a tiny edit
 * to one row does not reshuffle the lane stacking of unrelated rows.
 *
 * `greedyTimes` (REQ-20260613-002): when supplied, the override startSec
 * is used for the primary sort key in place of the live `entry.startSec`.
 * Keeps the dragged entry pinned to its starting sort position even as
 * its live startSec diverges from neighbouring clips during a drag.
 */
function compareForLayout(
  a: SubtitleEntry,
  b: SubtitleEntry,
  greedyTimes?: ReadonlyMap<string, { startSec: number; endSec: number }>
): number {
  const aStart = greedyTimes?.get(a.id)?.startSec ?? a.startSec
  const bStart = greedyTimes?.get(b.id)?.startSec ?? b.startSec
  if (aStart !== bStart) return aStart - bStart
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Greedy interval graph coloring: assign each entry to the first track whose
 * last block has already ended.  Spawn a new track only when no existing
 * track fits.
 *
 * Inputs are not mutated.  Entries are read in `startSec` ascending order
 * (with `id` tiebreak); the returned `placements` array preserves the input
 * entry order so callers can render rows by their input position without
 * re-sorting.
 *
 * Deleted rows are passed through to the caller; the caller decides whether
 * to filter them out before invoking.  This keeps the function pure and
 * lets the "Deleted" filter still produce a visual layout.
 *
 * `minBlockSec` (REQ-088 #2) lets the caller reserve a minimum amount of
 * track-time per block so very-short blocks (Whisper sometimes emits
 * 0.02-s segments) don't sit beside another block on the same track and
 * visually overlap at min-render-width.  Default is 0 = legacy
 * boundary-only behaviour (unit tests rely on this).
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
  // REQ-20260613-002: when an entry has a greedy-time override, the
  // sort key AND the interval-fit check both use those override values
  // (= snapshot times for a dragged entry).  Live values are preserved
  // on the entry itself so the caller's `editedBlockPositions` still
  // renders the block at its live position; only the trackIndex gets
  // pinned.
  function timesFor(e: SubtitleEntry): { startSec: number; endSec: number } {
    const o = greedyTimes?.get(e.id)
    if (o !== undefined) return o
    return { startSec: e.startSec, endSec: e.endSec }
  }

  const sorted = [...entries].sort((a, b) => compareForLayout(a, b, greedyTimes))
  // trackEndSec[i] = effective endSec of the most recent block placed on
  // track i, where "effective" means max(actualEnd, start + minBlockSec).
  // Reserving `minBlockSec` past actualEnd is what stops the rendered
  // min-width of a 0.02-s block from overlapping the next block on the
  // same track (REQ-088 #2).
  const trackEndSec: number[] = []
  const trackOf = new Map<string, number>()

  for (const e of sorted) {
    const t = timesFor(e)
    const effectiveEnd = t.endSec > t.startSec + minBlockSec
      ? t.endSec
      : t.startSec + minBlockSec
    let assigned = -1
    for (let i = 0; i < trackEndSec.length; i++) {
      if (trackEndSec[i] <= t.startSec + TIME_EPS_SEC) {
        assigned = i
        break
      }
    }
    if (assigned === -1) {
      assigned = trackEndSec.length
      trackEndSec.push(effectiveEnd)
    } else {
      trackEndSec[assigned] = effectiveEnd
    }
    trackOf.set(e.id, assigned)
  }

  const placements: TimelinePlacement[] = entries.map((e) => ({
    entry: e,
    trackIndex: trackOf.get(e.id) ?? 0
  }))

  // totalSec is sourced from the LIVE entry endSecs, never the
  // greedy-time overrides — the visible timeline width must always
  // accommodate the rightmost block as the user sees it (a drag that
  // pushes a clip past the previous timeline end should extend the
  // ruler, not let the block escape it).
  const maxEntryEnd = entries.reduce((m, e) => (e.endSec > m ? e.endSec : m), 0)
  const totalSec = Math.max(fallbackDurationSec, maxEntryEnd)

  return {
    placements,
    trackCount: trackEndSec.length,
    totalSec
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
