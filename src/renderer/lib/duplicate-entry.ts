/**
 * REQ-0322 §2 — exhaustive duplication of a `SubtitleEntry`.
 *
 * ## Why this exists
 *
 * `duplicateRow` used to build the duplicate by listing fields by hand.
 * That listing had drifted 16 fields behind the type (`casing`,
 * `shadowDepth`, `shadowColor`, `shadowAlpha`, `textAlpha`,
 * `outlineAlpha`, `rotation`, `karaokeEnabled`, `karaokeHighlightColor`,
 * `words`, `keywordEmphasisEnabled`, `emphasisColorHex`,
 * `emphasisScalePercent`, `emphasisSpans`, `emphasisKeywords`,
 * `emphasizedWordIndices`) — so duplicating a karaoke row silently
 * dropped its per-word timings and the copy fell back to even-split
 * karaoke, and duplicating an emphasised row lost the emphasis.
 *
 * This is the **third** instance of one bug class in this codebase:
 * *optional field + explicit re-construction = silent drop.*
 *   1. `SETTINGS_MERGE_RULES`      (REQ-0312 §1) — settings merge
 *   2. `BURNIN_FIELD_DISPOSITION`  (REQ-0321 §1) — burn-in IPC payload
 *   3. this module                 (REQ-0322 §2) — row duplication
 *
 * All three use the same cure: a `{ readonly [K in keyof T]-?: Rule }`
 * mapped type.  The `-?` is load-bearing — without it the homomorphic
 * mapped type preserves `?`, and a forgotten OPTIONAL key still
 * compiles.  Every field of `SubtitleEntry` is optional-heavy, so
 * without `-?` this file would enforce nothing at all.
 *
 * Adding a field to `SubtitleEntry` without classifying it here is a
 * `tsc` error (TS1360, "Property '<name>' is missing").
 */

import type { SubtitleEntry, SubtitleEntryOriginal } from '../../shared/types'
import { resolveLayer, MIN_LAYER } from '../../shared/cue-placement'

/**
 * What happens to a field when a row is duplicated.
 *
 * - `copy`       — carried over verbatim (value types, or references the
 *                  duplicate may safely share because they are immutable).
 * - `deep-copy`  — structurally cloned so the duplicate never shares
 *                  object identity with the source (mutating one row's
 *                  background / words / spans must not touch the other).
 * - `shift`      — recomputed relative to the source's timecodes.
 *                  **Currently empty**; see the note on `startSec` below.
 * - `regenerate` — a fresh value is minted (`id`).
 * - `reset`      — forced to a fixed value regardless of the source
 *                  (`isDeleted` / `isEdited`).
 * - `snapshot`   — rebuilt from the duplicate's own copied fields
 *                  (`original`, the "Reset row" reference point).
 */
export type DuplicationRule =
  | 'copy'
  | 'deep-copy'
  | 'shift'
  | 'regenerate'
  | 'reset'
  | 'snapshot'

/**
 * Classification of every `SubtitleEntry` field.
 *
 * Note on `startSec` / `endSec`: they are `copy`, not `shift`.  The
 * duplicate deliberately lands on the SAME timecodes as the source and
 * is inserted directly beneath it in the list — that is the pre-existing
 * behaviour and REQ-0322 §2 requires it stay unchanged.  The `shift`
 * variant is declared anyway so that a future "duplicate and offset by
 * the cue duration" decision has a place to be *written down* rather
 * than being an unremarked edit to the copy loop.  Same reasoning as
 * the (also empty) `omit` variant in `BURNIN_FIELD_DISPOSITION`: the
 * original bug was invisible precisely because "not copied" was an
 * *absence* rather than a *statement*.
 */
export const SUBTITLE_ENTRY_DUPLICATION = {
  // --- timing ---------------------------------------------------------
  startSec: 'copy',
  endSec: 'copy',
  // --- content --------------------------------------------------------
  text: 'copy',
  // --- base typography ------------------------------------------------
  fontSizePx: 'copy',
  textColorHex: 'copy',
  outlineColorHex: 'copy',
  outlineThicknessPx: 'copy',
  fadeDurationSec: 'copy',
  fontId: 'copy',
  // --- layout (REQ-20260613-016) --------------------------------------
  horizontalPosition: 'copy',
  verticalPosition: 'copy',
  verticalMarginPx: 'copy',
  subtitleBackground: 'deep-copy',
  posX: 'copy',
  posY: 'copy',
  // REQ-0332 — line spacing (行間).
  lineSpacingPercent: 'copy',
  // REQ-0392/0396 — z-order.  `shift`: the duplicate is placed on the layer ONE
  // ABOVE the source (front), so it lands on the row above the original instead
  // of sharing (and overlapping) its row.  Recomputed in `buildDuplicateEntry`.
  layer: 'shift',
  // --- style effects (REQ-0277 / REQ-0310) ----------------------------
  casing: 'copy',
  shadowDepth: 'copy',
  shadowColor: 'copy',
  shadowAlpha: 'copy',
  textAlpha: 'copy',
  outlineAlpha: 'copy',
  rotation: 'copy',
  // --- karaoke (REQ-0286 / REQ-0322 §3) -------------------------------
  karaokeEnabled: 'copy',
  karaokeHighlightColor: 'copy',
  karaokeStyle: 'copy',
  // REQ-0336 §2 — the user's 「発話タイミング」 choice.  `copy`: the duplicate
  // lands on the SAME timecodes and carries the same `words`, so whatever the
  // source resolved to, the copy resolves to as well; carrying the choice keeps
  // them identical instead of silently re-enabling real timings on the copy.
  karaokeUseWordTimings: 'copy',
  words: 'deep-copy',
  // --- entrance / exit animation (REQ-0323 Phase C) -------------------
  animationType: 'copy',
  animationInEnabled: 'copy',
  animationOutEnabled: 'copy',
  animationDurationSec: 'copy',
  animationDirection: 'copy',
  animationDistancePx: 'copy',
  // REQ-0331 §1-3 — per-type strength ("強さ") row.
  animationStartScalePercent: 'copy',
  animationBlurPx: 'copy',
  // --- keyword emphasis (REQ-0305 / 0306 / 0307) ----------------------
  keywordEmphasisEnabled: 'copy',
  emphasisColorHex: 'copy',
  emphasisScalePercent: 'copy',
  emphasisSpans: 'deep-copy',
  emphasisKeywords: 'deep-copy',
  emphasizedWordIndices: 'deep-copy',
  // --- identity / bookkeeping -----------------------------------------
  id: 'regenerate',
  // REQ-0400 — the duplicate must be DISTINGUISHABLE from its source, so it does
  // NOT inherit the source's display number.  `reset` to `undefined` here; the
  // store's `addEntry` then mints a fresh monotonic `cueNumber` (a pure builder
  // cannot know the project-wide max).  Same reasoning as `id`, but the value
  // is assigned by the store rather than passed in.
  cueNumber: 'reset',
  isDeleted: 'reset',
  isEdited: 'reset',
  original: 'snapshot',
} as const satisfies { readonly [K in keyof SubtitleEntry]-?: DuplicationRule }

type Rules = typeof SUBTITLE_ENTRY_DUPLICATION

/** The field names carrying a given rule. */
type KeysWithRule<R extends DuplicationRule> = {
  [K in keyof Rules]: Rules[K] extends R ? K : never
}[keyof Rules]

/** Rules whose values are taken from the source entry field-by-field. */
const CARRIED_RULES: ReadonlySet<DuplicationRule> = new Set<DuplicationRule>([
  'copy',
  'deep-copy',
])

function cloneValue<T>(value: T): T {
  // Electron 30 (Node 20) and jsdom/vitest both provide structuredClone.
  // Guarded anyway so this module stays usable in any host.
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : (JSON.parse(JSON.stringify(value)) as T)
}

/**
 * The `SubtitleEntry` fields whose values are objects/arrays and therefore must
 * be structurally cloned to avoid two rows (or a row and a snapshot) sharing
 * object identity.  Derived from the single classification above, so a field
 * reclassified to / from `deep-copy` moves this set automatically.
 */
export const DEEP_COPY_FIELDS: ReadonlySet<keyof SubtitleEntry> = new Set(
  (Object.entries(SUBTITLE_ENTRY_DUPLICATION) as [keyof SubtitleEntry, DuplicationRule][])
    .filter(([, rule]) => rule === 'deep-copy')
    .map(([key]) => key),
)

/**
 * REQ-0464 — a history-safe snapshot of an entry for the Undo path.
 *
 * `applyBulk` / `applyStyleEdit` used `{ ...entry }`, a SHALLOW copy: the
 * nested `deep-copy` fields (`subtitleBackground`, `words`, the emphasis
 * arrays) were shared by reference with the live entry, so a later in-place
 * mutation of one of those objects would silently rewrite the Undo target and
 * Undo would restore the *mutated* value.  This returns a copy with exactly the
 * nested fields cloned, so the snapshot is decoupled from the live store.
 *
 * `patch` (optional) narrows the clone to the nested fields the edit will
 * actually touch — Undo only restores the patch's keys, so cloning `words` for
 * a font-size edit would be wasted work on a select-all over thousands of rows.
 * Omit it to clone every nested field (a full independent snapshot).
 */
export function deepSnapshotEntry(
  entry: SubtitleEntry,
  patch?: Partial<SubtitleEntry>,
): SubtitleEntry {
  const out: SubtitleEntry = { ...entry }
  const keys = patch
    ? (Object.keys(patch) as (keyof SubtitleEntry)[]).filter((k) => DEEP_COPY_FIELDS.has(k))
    : [...DEEP_COPY_FIELDS]
  for (const key of keys) {
    // Only clone fields the row actually carries; an absent optional field stays
    // absent (writing `undefined` would defeat `buildUndoPatch`'s "restore unset").
    if (key in entry && entry[key] !== undefined) {
      const rec = out as unknown as Record<string, unknown>
      rec[key as string] = cloneValue((entry as unknown as Record<string, unknown>)[key as string])
    }
  }
  return out
}

/**
 * Build the `SubtitleEntryOriginal`-shaped payload shared by the
 * duplicate's live fields and its `original` snapshot.
 *
 * Absence is preserved: a key that is **not present** on the source is
 * not written as `undefined` on the duplicate.  This keeps
 * `'key' in entry` answering the same on both rows, which the emphasis
 * migration path (`resolveEmphasis`: `emphasisSpans` absent → fall back
 * to `emphasisKeywords`) actually reads.
 */
function carryFields(entry: SubtitleEntry): SubtitleEntryOriginal {
  const out: Record<string, unknown> = {}
  for (const [key, rule] of Object.entries(SUBTITLE_ENTRY_DUPLICATION)) {
    if (!CARRIED_RULES.has(rule)) continue
    if (!(key in entry)) continue
    const value = (entry as unknown as Record<string, unknown>)[key]
    out[key] = rule === 'deep-copy' ? cloneValue(value) : value
  }
  return out as unknown as SubtitleEntryOriginal
}

/**
 * Produce the duplicate of `entry` under the id `newId`.
 *
 * Pure — no store access, no toast, no history.  `duplicateRow` in
 * `entry-row-actions.ts` owns those side effects; this function owns
 * *what the duplicate contains*, so the contents can be tested without
 * standing up the whole renderer.
 */
export function buildDuplicateEntry(
  entry: SubtitleEntry,
  newId: string,
  /**
   * REQ-0528 §1-2 — the layer the copy should land on, normally resolved by
   * `findFreeLayerAbove` so the duplicate skips past any layer already occupied
   * at these times.  Optional, and defaulting to the historical `source + 1`,
   * because this function's contract is "what the duplicate CONTAINS" — layer
   * SELECTION needs the whole entry list and therefore belongs to the caller.
   * The default keeps this module usable (and unit-testable) standalone.
   */
  targetLayer?: number,
): SubtitleEntry {
  const carried = carryFields(entry)

  // REQ-0396 — `shift` fields are recomputed for the duplicate rather than
  // copied.  `layer` shifts up by one so the duplicate paints on the row/layer
  // ABOVE the source (front), instead of sharing — and overlapping — its row.
  // REQ-0397 §2 — clamped to `MIN_LAYER` so the copy is never negative (source+1
  // is already ≥ 1 for any non-legacy source; the floor only guards a project
  // that carries a legacy negative layer).  The timeline is bottom-anchored, so
  // "one above" (front) is literally one row up the stack.
  // (The `Pick` over `KeysWithRule<'shift'>` makes tsc demand exactly the shift
  // fields, so reclassifying a field to `shift` without computing it fails.)
  // REQ-0528 §1 — `targetLayer` (when the caller resolved one) replaces the
  // blind `+ 1`.  The old expression only knew the SOURCE's layer, so two
  // duplicates of the same cue both landed on source+1 and overlapped.
  const shiftedLayer = Math.max(MIN_LAYER, targetLayer ?? resolveLayer(entry) + 1)
  const shifted: Pick<SubtitleEntryOriginal, KeysWithRule<'shift'>> = {
    layer: shiftedLayer,
  }

  // Likewise for the non-carried rules: classifying a field as
  // `regenerate` / `reset` / `snapshot` and then forgetting to compute it
  // is a compile error, not a silent `undefined`.
  const minted: Pick<
    SubtitleEntry,
    KeysWithRule<'regenerate'> | KeysWithRule<'reset'> | KeysWithRule<'snapshot'>
  > = {
    id: newId,
    // REQ-0400 — left unset so the store's addEntry mints a fresh display number
    // (the duplicate must not share the source's 字幕ID).
    cueNumber: undefined,
    isDeleted: false,
    isEdited: true,
    // Independently cloned so the live row and its original snapshot
    // never share object identity for any `deep-copy` field.  REQ-0396: the
    // snapshot carries the SHIFTED layer too, so the duplicate's baseline (and
    // therefore Reset / isEdited) is the row it actually starts on, not the
    // source's layer.
    original: { ...carryFields(entry), layer: shiftedLayer },
  }

  return { ...carried, ...shifted, ...minted }
}
