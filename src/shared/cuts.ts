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
 * Sort and clean a raw cut list so the §1.1 invariants hold:
 *   - 0 <= startSec < endSec <= maxSec (when maxSec given)
 *   - sorted by startSec ASC; tie-break by endSec DESC (= outer cut comes
 *     first when two cuts share startSec)
 *   - no two cuts share the exact same (startSec, endSec) pair
 *   - OVERLAPPING and TOUCHING cuts are KEPT as separate entries with
 *     their original `id`s (REQ-105 Phase 2 — the staged-unbind UI needs
 *     each cut addressable by id so the user can remove the outer one
 *     while the inner one stays in storage).
 *
 * Used by every project-store mutation (addCut / updateCut / setCuts).
 * Downstream coordinate math (`origToEdited` / `editedToOrig` /
 * `editedDuration`) routes through `unionizeCuts` so overlapping cuts
 * do not double-subtract — that's the Phase 1 contract this function
 * relies on.
 *
 * Dedupe rule: only "fully identical" cuts (= same startSec AND same
 * endSec) are collapsed.  The first occurrence wins, so the original
 * `id` (and any history reference to it) is preserved.  Different ids
 * on the same interval are pointless — the user can never tell them
 * apart visually — but they could leak into storage via a history
 * snapshot replay, and this rule guarantees the storage shape stays
 * deterministic.
 *
 * Tie-break rationale (`endSec DESC` on equal startSec): the
 * staged-unbind logic in Phase 4 needs to find "the outer cut" quickly.
 * With outer-first ordering, the linear scan in `containsCut` /
 * `removableCutIds` can short-circuit as soon as it hits a containing
 * cut whose startSec equals the candidate's startSec — without this
 * tie-break we would have to sort or rescan elsewhere.
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
  // Sort: startSec ASC; tie-break endSec DESC so the outer cut comes first
  // when two cuts share the same startSec.
  cleaned.sort((a, b) => a.startSec - b.startSec || b.endSec - a.endSec)
  // Dedupe by exact (startSec, endSec) pair — first occurrence wins so the
  // `id` from the earliest mutation is preserved.  Different `id`s on the
  // same interval are indistinguishable to the user, so collapsing them
  // is purely a storage cleanup, not a semantic change.
  const out: Cut[] = []
  for (const c of cleaned) {
    const dup = out.find((p) => p.startSec === c.startSec && p.endSec === c.endSec)
    if (dup) continue
    out.push({ id: c.id, startSec: c.startSec, endSec: c.endSec })
  }
  return out
}

/**
 * REQ-105 Phase 1 — collapse `cuts` into the disjoint union of intervals
 * that they cover.  Used INTERNALLY by `origToEdited` / `editedToOrig` /
 * `editedDuration` to make those functions overlap-tolerant when the
 * stored cuts list contains overlapping / touching entries (= the future
 * Phase 2 storage shape).
 *
 * Contract:
 *   - Input MAY contain overlapping, touching, or fully-identical
 *     intervals (caller's responsibility to ensure they are sorted by
 *     `startSec` ascending — `sanitizeCuts` already does this; defensive
 *     sort here would be cheap but is intentionally omitted so this
 *     function stays a pure linear-time merge).
 *   - Output: disjoint, sorted, non-touching intervals (= the actual
 *     frames the concat path would remove).  Cut identity (`id`) is
 *     dropped — this is computation-only, never written back to storage.
 *   - Empty input returns empty output.
 *
 * Phase 1 invariant: when input is already disjoint (= the current
 * Phase 1 storage shape after sanitizeCuts), output equals input with
 * the `id` stripped — so the three coordinate functions are
 * bit-identical to their pre-REQ-105 behaviour for every existing
 * caller.
 *
 * Phase 2 (next REQ) will relax `sanitizeCuts` to allow overlapping
 * cuts in storage; at that point this function's overlap-handling
 * branch starts running for real inputs.
 */
export function unionizeCuts(
  cuts: readonly { startSec: number; endSec: number }[],
): Array<{ startSec: number; endSec: number }> {
  const out: Array<{ startSec: number; endSec: number }> = []
  for (const c of cuts) {
    const last = out[out.length - 1]
    if (last && c.startSec <= last.endSec) {
      // Overlap OR touch — extend the previous interval's end.  `Math.max`
      // (rather than blind assignment) handles the case where `c` is fully
      // contained in `last` (c.endSec <= last.endSec) without shrinking it.
      if (c.endSec > last.endSec) last.endSec = c.endSec
    } else {
      out.push({ startSec: c.startSec, endSec: c.endSec })
    }
  }
  return out
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
 *
 * REQ-105 Phase 1 — pre-unions overlapping cuts so the `removed`
 * accumulator does not double-count.  Existing disjoint inputs are
 * bit-identical (unionizeCuts is the identity on disjoint input).
 */
export function origToEdited(tOrig: number, cuts: CutList): number {
  const ranges = unionizeCuts(cuts)
  let removed = 0
  for (const c of ranges) {
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
  const ranges = unionizeCuts(cuts)
  let tOrig = tEdited
  for (const c of ranges) {
    if (c.startSec > tOrig) break
    tOrig += c.endSec - c.startSec
  }
  return tOrig
}

/**
 * Total Edited timeline duration in seconds (always >= 0).
 *
 * REQ-105 Phase 1 — sums the union of cut intervals, not the raw cuts
 * list, so overlapping cuts (Phase 2 storage shape) do not double-subtract.
 * For disjoint inputs (Phase 1 / pre-REQ-105 callers) `unionizeCuts` is the
 * identity and the result is bit-identical.
 */
export function editedDuration(originalDurationSec: number, cuts: CutList): number {
  const ranges = unionizeCuts(cuts)
  let removed = 0
  for (const c of ranges) removed += c.endSec - c.startSec
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

  // REQ-105 Phase 3 — `middleCuts` may overlap each other once Phase 2's
  // sanitizeCuts allowed overlapping cuts into storage (e.g. two cuts that
  // both fall strictly inside the entry, with one nested in the other).
  // Summing them naively double-counts the overlapping frames and can
  // push `visibleSec` below the floor, mis-classifying the entry as
  // trim-deleted.  Route through `unionizeCuts` so the floor check uses
  // the actual frames removed.  `middleCuts` itself stays as the raw
  // per-cut list so UI consumers (Phase 4 scissor badges) can still
  // address each cut individually.
  //
  // REQ-112 — a second double-count source: branch (f) decides "middle"
  // against the IMMUTABLE `e.startSec` / `e.endSec`, not against the
  // CLAMPED `sClamped` / `enClamped`.  When a head-clamp cut (branch d)
  // moves sClamped forward AND another cut later falls in the head-clamp
  // region (because it's still strictly inside [e.startSec, e.endSec]),
  // it lands in middleCuts.  Its frames were already removed by the
  // head-clamp cut, so summing them double-subtracts and visibleSec
  // can go negative — the user's observed regression.  Clip each middle
  // cut to the surviving `[sClamped, enClamped]` interval BEFORE the
  // union so the floor check counts only frames inside the visible
  // window.  The raw `middleCuts` array is still returned unchanged so
  // the Phase 4 scissor-badge UI sees every cut the user made.
  const clippedMiddleCuts = middleCuts
    .map((c) => ({
      startSec: Math.max(c.startSec, sClamped),
      endSec: Math.min(c.endSec, enClamped),
    }))
    .filter((c) => c.endSec > c.startSec)
  const middleUnion = unionizeCuts(clippedMiddleCuts)
  const removedMiddleSec = middleUnion.reduce(
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
 *      different from the original OR a non-empty `middleCuts`
 *      array (= REQ-104 pure-middle-cut path: start/end preserved
 *      but the cut sits inside the visible interval) → `wasEdited
 *      = true`.  If no deletion took the row, `status = 'edited'`.
 *   5. Times preserved AND no middle cuts overlap → manual flags only.
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
  // REQ-104 — pure middle cuts leave startSec / endSec untouched (Phase 0.5
  // spec §3.1: "中間切り抜き ⇒ sClamped / enClamped も変えない") and instead
  // record the consumed interval in `middleCuts`.  Treat that as a cut-
  // induced edit so the row surfaces in 編集済み / 出力対象 just like
  // head- / tail-clamped rows do, matching the spec §2.2 promise "端・真ん中
  // とも編集済み".  Without the `middleCuts.length > 0` clause the row was
  // silently classified as 'normal'.
  const cutClamped =
    clamped !== null &&
    (clamped.startSec !== entry.startSec ||
      clamped.endSec !== entry.endSec ||
      clamped.middleCuts.length > 0)

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
 * REQ-105 Phase 4 — staged-unbind containment predicate.
 *
 * Returns true when `outer` strictly contains `inner`:
 *   - they are not the same cut (`id` differs)
 *   - `outer.startSec <= inner.startSec` AND `inner.endSec <= outer.endSec`
 *
 * "Same-range" cuts (identical `startSec` AND `endSec`, different `id`) are
 * already deduped by `sanitizeCuts` (REQ-105 Phase 2), so in practice
 * `containsCut` only fires when the geometry is a real proper containment.
 * The `id` guard protects the predicate against accidentally calling it
 * on a cut against itself in a single-pass scan.
 *
 * Pure function; no React / store dependencies.
 */
export function containsCut(outer: Cut, inner: Cut): boolean {
  if (outer.id === inner.id) return false
  return outer.startSec <= inner.startSec && inner.endSec <= outer.endSec
}

/**
 * REQ-105 Phase 4 — staged-unbind "currently removable" set.
 *
 * Returns the set of cut `id`s the user is currently allowed to remove via
 * the scissor marker UI.  A cut is removable iff no OTHER cut in the same
 * list contains it.  Inner / nested cuts are locked until their outer
 * container is removed first; once the outer goes, the next layer becomes
 * the new "outermost" and gets unlocked automatically (the predicate is
 * re-evaluated against the new cut list on every storage mutation).
 *
 * Time complexity: O(N²) over `cuts.length`.  Cuts list is typically < 100
 * entries even for heavy editing sessions, so the cost is sub-millisecond
 * in practice; the memo at the call site keeps it from running per render.
 *
 * Pure function — Phase 3 locked the algebra in `cuts.test.ts` against
 * pre-computed scenarios; this is the same logic factored out of the test
 * so the test and the production UI go through the same predicate
 * physically.
 */
export function removableCutIds(cuts: CutList): Set<string> {
  const out = new Set<string>()
  for (const c of cuts) {
    const isInside = cuts.some((other) => containsCut(other, c))
    if (!isInside) out.add(c.id)
  }
  return out
}

/**
 * REQ-105 Phase 5 — list the entries that would STILL be trim-deleted
 * after a specific cut is removed from `cutsBefore`.
 *
 * Used by the staged-unbind UI to surface "the outer cut you just
 * scissor-removed could not bring N subtitle(s) back — another cut
 * still consumes them" (= the spec §3 unified revival eligibility
 * criterion, evaluated against `cutsBefore - removingCutId`).
 *
 * Algorithm: an entry contributes IFF
 *   1. `entry.isDeleted === false` (manually-deleted entries belong to
 *      the manual-delete tab's revival path, NEVER to scissor-marker
 *      revival per spec §3)
 *   2. `applyCutsToEntry(entry, cutsBefore) === null` (= it was already
 *      trim-deleted by the cuts that included the one we're removing)
 *   3. `applyCutsToEntry(entry, cutsAfter) === null` (= still
 *      trim-deleted even after the cut is gone — some OTHER cut still
 *      consumes it)
 *
 * Returns entries (not just count) so the caller can inspect them if
 * needed; the Phase 5 UI uses `.length` for the toast.
 *
 * Pure function — no React / store dependency.
 */
export function entriesStillTrimDeletedAfter(
  entries: readonly SubtitleEntry[],
  cutsBefore: CutList,
  removingCutId: string,
): SubtitleEntry[] {
  const cutsAfter = cutsBefore.filter((c) => c.id !== removingCutId)
  const out: SubtitleEntry[] = []
  for (const e of entries) {
    if (e.isDeleted) continue   // spec §3 — manual delete is its own revival path
    const wasTrimDeleted = applyCutsToEntry(e, cutsBefore) === null
    if (!wasTrimDeleted) continue
    const stillTrimDeleted = applyCutsToEntry(e, cutsAfter) === null
    if (stillTrimDeleted) out.push(e)
  }
  return out
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
