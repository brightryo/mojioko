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
 * REQ-103 — top-level mutually-exclusive status for one entry.
 * Drives the 行き先 tab partition (すべて / 出力対象 / 削除) and
 * the per-row status badge.  Exactly one of the four values applies
 * to every entry; partitioning ensures the 件数整合
 * (`出力対象 + 削除 = すべて`) invariant the REQ spelled out.
 */
export type ClipStatus =
  /** Not edited, not deleted.  Default state. */
  | 'normal'
  /** Manually edited (`entry.isEdited`) OR cut head/tail clamp.
   *  Surfaces in 出力対象 + 編集済み filter. */
  | 'edited'
  /** `entry.isDeleted` is set by the user.  Surfaces in 削除 only. */
  | 'manuallyDeleted'
  /** Cut fully contained the entry (`applyCutsToEntry === null`) and the
   *  user did NOT also manually delete it.  Surfaces in 削除 only. */
  | 'trimDeleted'

/**
 * REQ-103 — table / count classification of an entry, derived from
 * its manual flags AND any cuts that overlap it.  Replaces the REQ-102
 * 2-boolean shape with a 4-state `status` so the 行き先 partition
 * (すべて / 出力対象 / 削除) is exact and 'trimDeleted' can be
 * distinguished from 'manuallyDeleted' (= the REQ-103 §C badge
 * requirement).
 *
 * `wasEdited` is a cross-cutting flag for the 編集済み filter that
 * stays true even when the row is also deleted — exactly per the
 * REQ-103 §B clause "削除済みでも出力対象でも、編集されていれば表示".
 * The OR over manual + cut-induced edits means a row never
 * double-counts in 編集済み.
 *
 * Backwards-compat: `effectivelyDeleted` / `effectivelyEdited` are
 * kept as convenience accessors for callers that haven't migrated to
 * `status` yet.  New code should prefer `status` / `wasEdited`.
 */
export interface EffectiveEntryState {
  /** REQ-103 — mutually exclusive 4-state classification.  Use this
   *  for tab partition and the row's primary status badge. */
  status: ClipStatus
  /** REQ-103 — cross-cutting "was edited" flag.  True when the entry
   *  was manually edited OR a cut clamped its start/end times, even
   *  if it was later deleted (manual or trim).  Drives the 編集済み
   *  filter; not affected by `status === 'manuallyDeleted'` /
   *  `'trimDeleted'`. */
  wasEdited: boolean
  /** Convenience: `status === 'manuallyDeleted' || status === 'trimDeleted'`.
   *  Use for "should this row appear on the timeline?" and the 削除
   *  tab predicate. */
  effectivelyDeleted: boolean
  /** Convenience: `wasEdited && !effectivelyDeleted`.  Equivalent to
   *  the REQ-102 field of the same name and kept as a back-compat
   *  alias; deletion-aware "edited" counts (= the new 編集済み tab
   *  that includes deleted rows) should read `wasEdited` instead. */
  effectivelyEdited: boolean
}

/**
 * REQ-103 — derive the table classification for one entry against the
 * current cut list.  Pure function; entry is not mutated.
 *
 * Boundary contract (matches `applyCutsToEntry`):
 *   1. `entry.isDeleted` ALWAYS wins → `status = 'manuallyDeleted'`.
 *      Locks the REQ-079 / REQ-091 contract that manual delete is the
 *      strongest signal.
 *   2. Empty cuts list → `status` mirrors the manual flags
 *      (normal or 'edited' depending on `entry.isEdited`).
 *   3. `applyCutsToEntry` returns null AND `!entry.isDeleted` →
 *      `status = 'trimDeleted'` (= REQ-103 §A new state).
 *   4. `applyCutsToEntry` returns clamped entry with start/end
 *      different from the original → `wasEdited = true`.  If no
 *      deletion took the row, `status = 'edited'`.
 *   5. Times preserved (cut doesn't overlap) → manual flags only.
 *
 * `wasEdited` is independent of `status`.  A row that was manually
 * edited and then manually deleted reports `status =
 * 'manuallyDeleted'`, `wasEdited = true` — so the 削除 tab counts it
 * once AND the 編集済み filter also surfaces it (the
 * cross-cutting contract from REQ-103 §B).
 */
export function effectiveEntryState(
  entry: SubtitleEntry,
  cuts: CutList,
): EffectiveEntryState {
  const clamped = cuts.length === 0 ? null : applyCutsToEntry(entry, cuts)
  const cutContained = cuts.length > 0 && clamped === null
  const cutClamped =
    clamped !== null &&
    (clamped.startSec !== entry.startSec || clamped.endSec !== entry.endSec)

  const wasEdited = entry.isEdited || cutClamped

  let status: ClipStatus
  if (entry.isDeleted) {
    status = 'manuallyDeleted'
  } else if (cutContained) {
    status = 'trimDeleted'
  } else if (wasEdited) {
    status = 'edited'
  } else {
    status = 'normal'
  }

  const effectivelyDeleted =
    status === 'manuallyDeleted' || status === 'trimDeleted'
  return {
    status,
    wasEdited,
    effectivelyDeleted,
    effectivelyEdited: wasEdited && !effectivelyDeleted,
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
