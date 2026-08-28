/**
 * REQ-0400 — stable per-cue display numbers ("字幕ID").
 *
 * The internal `SubtitleEntry.id` is a UUID: unique and reorder-stable, but
 * unfriendly to read and useless for telling a duplicate apart from its source
 * at a glance.  `cueNumber` is a small monotonic integer assigned once at
 * creation and shown in the inspector.
 *
 * These helpers are the single source of truth for that numbering.  They are
 * pure (no store access) so they can be unit-tested directly and so the store's
 * `setEntries` / `addEntry` — the funnel every creation path (transcription,
 * add-row, SRT import, duplicate, project load) already passes through — can
 * apply them in one place.
 *
 * Design notes:
 *   - Monotonic, never reused: the next number is `max(existing) + 1`.  Because
 *     soft-deleted cues stay in the array (isDeleted), their numbers keep
 *     counting toward the max, so a new cue never collides with a deleted one.
 *   - NOT the list index: a cue keeps its number through sorting, filtering and
 *     reordering (the number lives on the entry, not on its position).
 *   - Back-fill in array order: a project saved before this field, or any entry
 *     that arrives without a number, is numbered following the saved order,
 *     which is chronological, then persisted — so it is stable thereafter.
 */

import type { SubtitleEntry } from './types'

/** The largest `cueNumber` present, or 0 when none carry one. */
export function maxCueNumber(entries: readonly SubtitleEntry[]): number {
  let max = 0
  for (const e of entries) {
    if (typeof e.cueNumber === 'number' && Number.isFinite(e.cueNumber) && e.cueNumber > max) {
      max = e.cueNumber
    }
  }
  return max
}

/** The number the next new cue should get: one past the current maximum. */
export function nextCueNumber(entries: readonly SubtitleEntry[]): number {
  return maxCueNumber(entries) + 1
}

/**
 * Return `entries` with every entry lacking a `cueNumber` assigned one, counting
 * up from the current maximum in array order.  Entries that already carry a
 * number are returned by identity (referential stability — a fully-numbered
 * array comes back unchanged, and only the newly-numbered entries are cloned).
 */
export function assignCueNumbers(entries: readonly SubtitleEntry[]): SubtitleEntry[] {
  let counter = maxCueNumber(entries)
  let mutated = false
  const out = entries.map((e) => {
    if (typeof e.cueNumber === 'number' && Number.isFinite(e.cueNumber)) return e
    counter += 1
    mutated = true
    return { ...e, cueNumber: counter }
  })
  return mutated ? out : (entries as SubtitleEntry[])
}
