import type { SubtitleEntry } from '../../shared/types'

/** Minimum temporal gap (seconds) to treat two intervals as non-overlapping. */
const TIME_EPS_SEC = 1e-3

/**
 * Stable tiebreaker for entries that share `startSec`.  Sorting by id keeps
 * the greedy track assignment deterministic across renders so a tiny edit
 * to one row does not reshuffle the lane stacking of unrelated rows.
 */
function compareForLayout(a: SubtitleEntry, b: SubtitleEntry): number {
  if (a.startSec !== b.startSec) return a.startSec - b.startSec
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

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
 */
export function layoutEntries(
  entries: readonly SubtitleEntry[],
  fallbackDurationSec: number
): TimelineLayout {
  if (entries.length === 0) {
    return { placements: [], trackCount: 0, totalSec: Math.max(1, fallbackDurationSec) }
  }

  const sorted = [...entries].sort(compareForLayout)
  // trackEndSec[i] = endSec of the most recent block placed on track i.
  const trackEndSec: number[] = []
  const trackOf = new Map<string, number>()

  for (const e of sorted) {
    let assigned = -1
    for (let i = 0; i < trackEndSec.length; i++) {
      if (trackEndSec[i] <= e.startSec - TIME_EPS_SEC) {
        assigned = i
        break
      }
    }
    if (assigned === -1) {
      assigned = trackEndSec.length
      trackEndSec.push(e.endSec)
    } else {
      trackEndSec[assigned] = e.endSec
    }
    trackOf.set(e.id, assigned)
  }

  const placements: TimelinePlacement[] = entries.map((e) => ({
    entry: e,
    trackIndex: trackOf.get(e.id) ?? 0
  }))

  const maxEntryEnd = sorted.reduce((m, e) => (e.endSec > m ? e.endSec : m), 0)
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
