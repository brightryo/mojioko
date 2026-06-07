import type { SubtitleEntry } from './types'

export interface Cut {
  /** Original (uncut) timeline, seconds. */
  startSec: number
  /** Original (uncut) timeline, seconds. */
  endSec: number
  /** Stable UUID. */
  id: string
}

export type CutList = readonly Cut[]

export interface ClampedEntry extends SubtitleEntry {
  middleCuts: Array<{ startSec: number; endSec: number }>
}

/** Minimum visible subtitle duration after cut application, in seconds. */
export const MIN_SUBTITLE_DURATION_SEC = 0.05

/**
 * Sort, clamp, and merge a raw cut list so the §1.1 invariants hold:
 *   - 0 <= startSec < endSec <= maxSec (when maxSec given)
 *   - sorted by startSec ascending
 *   - no overlapping or touching pairs
 *
 * Used by every project-store mutation (addCut / updateCut / setCuts) so
 * downstream code (origToEdited, applyCutsToEntry, ffmpeg filter_complex
 * builder) can rely on the invariants without re-validating.
 */
export function sanitizeCuts(cuts: readonly Cut[], maxSec?: number): Cut[] {
  const cleaned: Cut[] = []
  for (const c of cuts) {
    if (!Number.isFinite(c.startSec) || !Number.isFinite(c.endSec)) continue
    const s = Math.max(0, c.startSec)
    const e = maxSec !== undefined ? Math.min(maxSec, c.endSec) : c.endSec
    if (!(e > s)) continue
    cleaned.push({ id: c.id, startSec: s, endSec: e })
  }
  cleaned.sort((a, b) => a.startSec - b.startSec)
  const merged: Cut[] = []
  for (const c of cleaned) {
    const last = merged[merged.length - 1]
    if (last && c.startSec <= last.endSec) {
      if (c.endSec > last.endSec) last.endSec = c.endSec
    } else {
      merged.push({ ...c })
    }
  }
  return merged
}

/**
 * Map a time in the ORIGINAL (uncut) timeline to its position on the EDITED
 * (ripple-applied) timeline.  Times that fall strictly inside a cut snap to
 * that cut's startSec on the Edited axis (= "the moment the cut consumed
 * the frame").
 *
 * Phase 0.5 trace 2 anchors this contract:
 *   origToEdited(28, [c0={3,7}, c1={15,17}, c2={28,35}]) === 22
 * — when tOrig is exactly at a cut's startSec, that cut's duration must NOT
 * be subtracted from `removed`.
 */
export function origToEdited(tOrig: number, cuts: CutList): number {
  let removed = 0
  for (const c of cuts) {
    if (tOrig <= c.startSec) break
    if (tOrig < c.endSec) return c.startSec - removed
    removed += c.endSec - c.startSec
  }
  return tOrig - removed
}

/**
 * Inverse of origToEdited: map a time on the EDITED axis back to the
 * underlying ORIGINAL time.  Used by Ruler scrub to translate a user's
 * Edited-axis seek into the `<video>.currentTime` (= Original) value.
 *
 * Boundary convention (`c.startSec > tOrig` — strict): when tEdited lands
 * exactly on a cut-collapse point both pre-cut and post-cut Original
 * times are valid inverses; we pick the **post-cut** side to match NLE
 * scrubbing behaviour ("Edited time at the very start of a kept segment
 * lands at the start of that kept segment in Original").  This also makes
 * the round-trip `editedToOrig(origToEdited(t))` land back on the original
 * frame for non-cut t and on the post-cut frame for cut-boundary t.
 */
export function editedToOrig(tEdited: number, cuts: CutList): number {
  let tOrig = tEdited
  for (const c of cuts) {
    if (c.startSec > tOrig) break
    tOrig += c.endSec - c.startSec
  }
  return tOrig
}

/** Total Edited timeline duration in seconds (always >= 0). */
export function editedDuration(originalDurationSec: number, cuts: CutList): number {
  let removed = 0
  for (const c of cuts) removed += c.endSec - c.startSec
  return Math.max(0, originalDurationSec - removed)
}

/**
 * Apply the full cut list to a single subtitle entry.  Returns null when
 * the entry is fully consumed (complete containment or visible-duration
 * floor); otherwise returns a ClampedEntry whose `startSec` / `endSec` are
 * the surviving Original-axis interval and whose `middleCuts` lists any
 * cuts strictly inside that interval (for optional UI badges).
 *
 * Phase 0.5 invariant: decisions (c)–(f) ALL read e.startSec / e.endSec
 * (the immutable input).  sClamped / enClamped are write-only accumulators
 * — never re-read for subsequent decisions.  This is what makes the
 * algorithm safe for multiple cuts on one entry.
 */
export function applyCutsToEntry(
  e: SubtitleEntry,
  cuts: CutList,
): ClampedEntry | null {
  let sClamped = e.startSec
  let enClamped = e.endSec
  const middleCuts: Array<{ startSec: number; endSec: number }> = []

  for (const c of cuts) {
    if (c.endSec <= e.startSec) continue                                // (a)
    if (c.startSec >= e.endSec) break                                   // (b)
    if (c.startSec <= e.startSec && e.endSec <= c.endSec) return null   // (c)
    if (c.startSec <= e.startSec && e.startSec < c.endSec) {            // (d)
      sClamped = c.endSec
      continue
    }
    if (c.startSec < e.endSec && e.endSec <= c.endSec) {                // (e)
      enClamped = c.startSec
      break
    }
    middleCuts.push({ startSec: c.startSec, endSec: c.endSec })         // (f)
  }

  const removedMiddleSec = middleCuts.reduce(
    (a, c) => a + (c.endSec - c.startSec), 0,
  )
  const visibleSec = (enClamped - sClamped) - removedMiddleSec
  if (visibleSec < MIN_SUBTITLE_DURATION_SEC) return null

  return { ...e, startSec: sClamped, endSec: enClamped, middleCuts }
}

/**
 * REQ-102 — table / count classification of an entry, derived from
 * its manual flags AND any cuts that overlap it.  The shape is
 * intentionally a 2-tuple of booleans so consumers can build their
 * tab predicates from a single per-entry computation without re-
 * invoking `applyCutsToEntry` for every tab.
 */
export interface EffectiveEntryState {
  /**
   * True when the entry is hidden from `all` / `ready` / `edited` /
   * `warnings` and surfaces only in the `deleted` tab.  Set when
   * either:
   *   - the user manually soft-deleted the row (`entry.isDeleted`), OR
   *   - the row is fully contained in (or shrunk below
   *     `MIN_SUBTITLE_DURATION_SEC` by) any cut — `applyCutsToEntry`
   *     returns null.
   */
  effectivelyDeleted: boolean
  /**
   * True when the entry counts toward the `edited` tab.  Set when
   * either:
   *   - the user manually edited a field (`entry.isEdited`), OR
   *   - a cut clamps the entry's `startSec` / `endSec` to something
   *     different from the original (= head- or tail-overlap, or
   *     middle cuts present).
   *
   * When `effectivelyDeleted` is true, this field still reflects the
   * underlying `entry.isEdited` for diagnostic completeness, but the
   * consumer should typically treat `effectivelyDeleted` as a hard
   * exclude — the `edited` tab predicate is `effectivelyEdited &&
   * !effectivelyDeleted` to avoid double-counting.
   */
  effectivelyEdited: boolean
}

/**
 * REQ-102 — derive the table classification for one entry against the
 * current cut list.  Pure function; entry is not mutated.  Inverse of
 * `applyCutsToEntry`'s output, packaged for the table tabs / counts /
 * export filter.
 *
 * Boundary contract (matches `applyCutsToEntry`):
 *   - `entry.isDeleted` always wins → effectivelyDeleted = true.
 *   - Empty cuts list → effective state mirrors the manual flags.
 *   - `applyCutsToEntry` returns null (= entry fully contained, OR
 *     clamped below MIN_SUBTITLE_DURATION_SEC) → effectivelyDeleted
 *     = true.
 *   - `applyCutsToEntry` returns clamped entry with
 *     startSec / endSec different from the original → effectivelyEdited
 *     bumps to true (cut-induced edit).
 *   - Original times preserved (cut doesn't overlap) → effective state
 *     mirrors the manual flags.
 */
export function effectiveEntryState(
  entry: SubtitleEntry,
  cuts: CutList,
): EffectiveEntryState {
  if (entry.isDeleted) {
    return { effectivelyDeleted: true, effectivelyEdited: entry.isEdited }
  }
  if (cuts.length === 0) {
    return { effectivelyDeleted: false, effectivelyEdited: entry.isEdited }
  }
  const clamped = applyCutsToEntry(entry, cuts)
  if (clamped === null) {
    return { effectivelyDeleted: true, effectivelyEdited: entry.isEdited }
  }
  const cutClamped =
    clamped.startSec !== entry.startSec ||
    clamped.endSec !== entry.endSec
  return {
    effectivelyDeleted: false,
    effectivelyEdited: entry.isEdited || cutClamped,
  }
}

/**
 * Build the "kept-segments" list — the complement of `cuts` in
 * [0, originalDurationSec].  Used by the ffmpeg filter_complex builder
 * (§5.2) to emit one `trim=start=A:end=B` branch per kept segment.
 *
 * Returns `[{ startSec: 0, endSec: originalDurationSec }]` when cuts is
 * empty, which the caller can use as the "no trim/concat needed" signal
 * to fall back to the legacy single-input argv (§5.4 backward compat).
 */
export function buildKeptSegments(
  originalDurationSec: number,
  cuts: CutList,
): Array<{ startSec: number; endSec: number }> {
  const kept: Array<{ startSec: number; endSec: number }> = []
  let cursor = 0
  for (const c of cuts) {
    if (c.startSec > cursor) kept.push({ startSec: cursor, endSec: c.startSec })
    cursor = Math.max(cursor, c.endSec)
  }
  if (cursor < originalDurationSec) {
    kept.push({ startSec: cursor, endSec: originalDurationSec })
  }
  return kept
}
