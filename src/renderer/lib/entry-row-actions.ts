import { toast } from 'sonner'
import type { SubtitleEntry } from '../../shared/types'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { loadSubtitleFont, loadSubtitleFontFor } from '@/lib/font-metrics'
import { isFontId } from '../../shared/fonts'
import { commitTimeEdit } from '@/lib/commit-time-edit'
import { buildDuplicateEntry } from '@/lib/duplicate-entry'
import { buildResetPatch } from '@/lib/cue-structure'
import { rendererLineBreakMetrics } from '@/lib/auto-line-break'
import { wrapCueText } from '../../shared/cue-wrap'
import { ASS_MARGIN_LR_PX } from '@/lib/tokens'
import { resolveLayer, findFreeLayerAbove } from '../../shared/cue-placement'

/**
 * Row-level edit operations that are shared between the list view
 * (subtitle-table) and the timeline-block inspector.  Extracted into this
 * module so the two surfaces drive **the same** history shape, sort
 * behaviour, and side effects — adding a third surface (e.g. command
 * palette) later only needs to call the same function.
 *
 * Why functions over hooks: history pushes happen synchronously from
 * event handlers and rely on `useProjectStore.getState()` / `useHistoryStore.getState()`
 * rather than subscribed selectors.  Wrapping these in hooks would force
 * the caller to memoise references it doesn't actually need; the existing
 * call sites already use the getState pattern.
 *
 * Why labels are passed in rather than read from i18next here: keeping the
 * lib free of i18n imports means it's trivially unit-testable and avoids
 * coupling renderer logic to translation-namespace structure.  Each caller
 * resolves the strings via its own `useTranslation` setup.
 */

/**
 * REQ-0131 §4.3 — 3-context predicate for the shared global-shortcut
 * handler.  Returns `true` only when the keydown is in **context B**
 * (editor screen, no modal, focus outside any editable element).  In
 * context A (a modal is open) and context C (focus is in a form field
 * or contentEditable region) it returns `false` so the caller bails
 * and the keystroke falls through to the modal's own Esc/Enter contract
 * (A) or the field's native character-input (C).
 *
 * Extracted so unit tests can pin the tri-state rule without spinning
 * up a React render.  Both the shared `useGlobalShortcuts` handler and
 * the preview panels' Space bindings call this function so every
 * global shortcut answers the same question the same way.  The
 * per-shortcut key/modifier check (Ctrl+Z vs Delete vs Space) is the
 * caller's job — this predicate only decides *whether it is allowed
 * to fire in principle*.
 */
export function shouldGlobalShortcutFire(
  activeTagName: string | null,
  isContentEditable: boolean,
  overlayOpen: boolean,
): boolean {
  if (overlayOpen) return false                  // context A → suppress
  if (isContentEditable) return false            // context C → typing
  const tag = (activeTagName ?? '').toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return false // context C
  return true                                     // context B → fire
}

/**
 * REQ-0130 — pure predicate for the timeline's DEL / Backspace guard.
 * Kept for the existing unit tests + call sites that pre-date the
 * REQ-0131 consolidation.  Layer over `shouldGlobalShortcutFire` so
 * both surfaces route through the same context judgement — the only
 * extra thing this variant does is check the key + modifier shape
 * (bare Delete / Backspace).  The `overlayOpen` parameter defaults
 * to `false` because REQ-0130's own unit fixtures pre-date the overlay
 * concept.
 */
export function shouldTimelineDeleteFire(
  key: string,
  modifiers: { ctrl: boolean; alt: boolean; meta: boolean; shift: boolean },
  activeTagName: string | null,
  isContentEditable: boolean,
  overlayOpen = false,
): boolean {
  if (key !== 'Delete' && key !== 'Backspace') return false
  if (modifiers.ctrl || modifiers.alt || modifiers.meta || modifiers.shift) return false
  return shouldGlobalShortcutFire(activeTagName, isContentEditable, overlayOpen)
}

/**
 * REQ-0138 — delete-only keyboard binding for DEL / Backspace.  Looks
 * up the selected entry and, if it is not already deleted, soft-deletes
 * it via a single history op.  Returns `true` when a delete actually
 * fired so the caller (`use-global-shortcuts.ts`) can decide whether to
 * swallow the keystroke.
 *
 * Semantics (REQ-0138 §1.1):
 *   - Undeleted row → soft-delete + history push.
 *   - Already-deleted row → **no-op**.  Returns `false` so the keystroke
 *     is not swallowed and the user does not perceive anything happening.
 *   - Unknown / no selection → `false`.
 *
 * Rationale: REQ-0129 / REQ-0130 originally routed DEL through
 * `toggleDeleteRow`, which flipped `isDeleted` in either direction.
 * Owner feedback (REQ-0138 §0-1): pressing DEL on a deleted row
 * silently restored it, which felt like "the delete didn't stick."
 * Restore is now keyboard-inaccessible for DEL; users restore via the
 * inspector's restore button (which still calls `toggleDeleteRow`) or
 * via `Ctrl+Z` on the delete op.
 */
export function deleteEntryById(
  entryId: string | null | undefined,
  labels: { delete: string }
): boolean {
  if (!entryId) return false
  const entry = useProjectStore.getState().entries.find((e) => e.id === entryId)
  if (!entry) return false
  if (entry.isDeleted) return false
  softDeleteRow(entry, labels)
  return true
}

/**
 * REQ-0138 — soft-delete without the "restore" branch that
 * `toggleDeleteRow` has.  Pushes one history op labelled with
 * `labels.delete`.  Callers that need the toggle semantic (the
 * inspector's delete/restore button) keep using `toggleDeleteRow`;
 * callers that only want "delete" (the DEL/BS keyboard binding) use
 * this so a re-press on an already-deleted row is a no-op rather than
 * a silent restore.
 */
export function softDeleteRow(
  entry: SubtitleEntry,
  labels: { delete: string }
): void {
  if (entry.isDeleted) return
  const projectStore = useProjectStore.getState()
  const pushHistory = useHistoryStore.getState().push
  const snapshot = { ...entry }
  pushHistory({
    label: labels.delete,
    undo: () => projectStore.updateEntry(entry.id, snapshot),
    redo: () => projectStore.updateEntry(entry.id, { ...snapshot, isDeleted: true })
  })
  projectStore.updateEntry(entry.id, { isDeleted: true })
}

/**
 * Toggle a row between active and soft-deleted.  Pushes a single
 * history op labelled with `labels.delete` (when actively deleting) or
 * `labels.restore` (when undeleting), so undo / redo cycle the row back
 * and forth through identical states.
 */
export function toggleDeleteRow(
  entry: SubtitleEntry,
  labels: { delete: string; restore: string }
): void {
  const projectStore = useProjectStore.getState()
  const pushHistory = useHistoryStore.getState().push
  const snapshot = { ...entry }
  const next = !entry.isDeleted
  pushHistory({
    label: next ? labels.delete : labels.restore,
    undo: () => projectStore.updateEntry(entry.id, snapshot),
    redo: () => projectStore.updateEntry(entry.id, { ...snapshot, isDeleted: next })
  })
  projectStore.updateEntry(entry.id, { isDeleted: next })
}

/**
 * Reset a row to its `original` snapshot — clears any user edits to
 * text / style / time / fontId AND restores `isDeleted: false`.
 *
 * Time-affecting resets (`original.startSec !== entry.startSec` or end)
 * re-sort and run the post-edit `commitTimeEdit` bundle so the row
 * visually lands at its original chronological position with focus +
 * scroll into view, matching the inline TimeInput commit behaviour.
 *
 * The patch deliberately writes `fontId: original.fontId` explicitly
 * (even when undefined) so the store merge clears any current override
 * — without this the `{...original}` spread would omit the key and leave
 * a stale override in place (REQ-022 step 7).
 *
 * `isEdited: false` in the patch is now redundant because `updateEntry`
 * auto-recomputes (REQ-059), but kept for call-site readability.
 */
export function resetRow(
  entry: SubtitleEntry,
  labels: { reset: string }
): void {
  const projectStore = useProjectStore.getState()
  const pushHistory = useHistoryStore.getState().push
  const { original } = entry
  const snapshot = { ...entry }
  const affectsTime =
    original.startSec !== entry.startSec || original.endSec !== entry.endSec
  // REQ-0555 §2 — the patch itself now lives in `cue-structure.ts` so the CLI's
  // `reset_cue` restores exactly what this button restores, including the four
  // explicit optional-field lines that were each their own bug.
  const resetPatch = buildResetPatch(entry)
  pushHistory({
    label: labels.reset,
    undo: () => {
      projectStore.updateEntry(entry.id, snapshot)
      if (affectsTime) useProjectStore.getState().sortByStartSec()
    },
    redo: () => {
      projectStore.updateEntry(entry.id, resetPatch)
      if (affectsTime) useProjectStore.getState().sortByStartSec()
    }
  })
  projectStore.updateEntry(entry.id, resetPatch)
  if (affectsTime) commitTimeEdit(entry.id)
}

/**
 * Wrap mode used by `wrapRow` / bulk handlers:
 *   - `'pack'`     : strip every existing `\N` first, then re-wrap.  The
 *                    entry collapses to one logical line that is packed
 *                    to the full effective width.  This is the legacy
 *                    "auto-wrap" behaviour (= REQ-20260612-003 §1 A
 *                    敷き詰め改行).
 *   - `'overflow'` : keep existing `\N` exactly where they are, only add
 *                    new `\N` inside segments that overflow the
 *                    effective width (REQ-20260612-003 §1 B はみ出し改行).
 *
 * Both modes call `applyAutoLineBreak` with identical width / font /
 * outline arguments, so break positions for any single line are
 * width-identical between modes — the *only* difference is whether the
 * existing `\N` are stripped before measurement.
 */
export type WrapMode = 'pack' | 'overflow'

/**
 * Shared row-wrap implementation for both pack and overflow modes.
 *
 * - `pack` strips existing `\N` first (REQ-20260612-003 A 敷き詰め改行).
 * - `overflow` preserves existing `\N` (REQ-20260612-003 B はみ出し改行).
 *
 * When the rewrap result matches the current text (no breaks would
 * change), surfaces an info toast and skips the history push so an
 * unchanged row doesn't pollute the undo stack.
 *
 * Awaits `loadSubtitleFont` so the glyph-accurate measurement path is
 * used — character-class fallback overestimates wide-glyph widths by
 * ~45 % and breaks land too early.  The font is in the module cache after
 * Step 2 mount so the await typically resolves immediately.
 */
async function wrapRow(
  entry: SubtitleEntry,
  mode: WrapMode,
  labels: { history: string; noChangeToast: string }
): Promise<void> {
  if (entry.isDeleted) return
  const projectStore = useProjectStore.getState()
  const pushHistory = useHistoryStore.getState().push
  const font = await loadSubtitleFont().catch(() => null)
  const videoWidthPx = projectStore.video?.widthPx ?? 1920
  // REQ-20260612-004: re-read the entry from the store rather than
  // trusting the closure-captured `entry` argument.  When a sibling
  // text-input is focused and the user clicks a wrap button, the
  // browser fires `blur` on the input synchronously before the
  // button's `click` handler runs.  The blur commits the user's
  // typed draft via `updateEntry({text: ...})`, but the closure-
  // captured `entry` was snapshotted at component render time and
  // still holds the pre-blur text.  Without this refresh, the wrap
  // would measure the stale text and write back a result that
  // silently DISCARDS the user's just-typed edit.  Reading from
  // `getState()` here costs nothing extra (already called above)
  // and is the same pattern other handlers in this file use.
  const latest =
    projectStore.entries.find((e) => e.id === entry.id) ?? entry
  if (latest.isDeleted) return
  // REQ-087 — when the row carries a per-row font override that is NOT
  // the currently-active font, the `await loadSubtitleFont()` above only
  // guarantees the ACTIVE font's metrics are cached.  Without this
  // extra wait, `applyAutoLineBreak` would fall through `getSubtitleFontFor`
  // to the character-class fallback and break the row at the wrong
  // glyph (visible as e.g. "ゃ" alone on the next line for Dela Gothic
  // One rows transcribed before the cache populated).  Best-effort:
  // a font load failure here just degrades back to the fallback path.
  if (isFontId(latest.fontId)) {
    await loadSubtitleFontFor(latest.fontId).catch(() => null)
  }
  /*
   * REQ-0556 §2 — the mode difference (pack pre-strips `\N` and re-anchors the
   * emphasis ranges onto the collapsed text; overflow passes them through) now
   * lives in `shared/cue-wrap.ts`, so the CLI's wrap produces the same result
   * as this button rather than a careful re-derivation of it.
   *
   * `font` above is still awaited for its side effect: it warms the metrics
   * cache that `rendererLineBreakMetrics` then reads.
   */
  void font
  const rewrapped = wrapCueText(latest, mode, {
    videoWidthPx,
    marginLrPx: ASS_MARGIN_LR_PX,
    metrics: rendererLineBreakMetrics(latest.fontId),
  })
  if (rewrapped === latest.text) {
    toast.info(labels.noChangeToast)
    return
  }
  // REQ-0288 — retained words on auto-line-break.  Pre-REQ-0288 this
  // path cleared `words: undefined` "defensively" (Layer 1).  Removed
  // for the same reason as commit-text-edit's Layer 1 clear (see the
  // REQ-0288 docblock there): the destructive clear breaks the
  // "revert restores karaoke" invariant, and Layer 2
  // (`areWordsValidForText`, REQ-0287's strip-all-whitespace
  // normaliser) already tolerates `\N` insertion so karaoke stays on
  // through wrap operations naturally.  Undo restores from the
  // snapshot (which preserves the pre-edit words) exactly as before.
  const snapshot = { ...latest }
  pushHistory({
    label: labels.history,
    undo: () => projectStore.updateEntry(latest.id, snapshot),
    redo: () => projectStore.updateEntry(latest.id, { ...snapshot, text: rewrapped })
  })
  projectStore.updateEntry(latest.id, { text: rewrapped })
}

/**
 * 敷き詰め改行 (REQ-20260612-003 §1 A).  Strips every existing `\N` in
 * the row, then re-wraps the resulting single line to the effective
 * video width.  Identical to the legacy "auto-wrap" behaviour — name
 * kept as `autoLineBreakRow` so callers and external references in
 * other surfaces (bulk bar, timeline inspector) remain stable.
 */
export function autoLineBreakRow(
  entry: SubtitleEntry,
  labels: { history: string; noChangeToast: string }
): Promise<void> {
  return wrapRow(entry, 'pack', labels)
}

/**
 * はみ出し改行 (REQ-20260612-003 §1 B).  Preserves every existing `\N`
 * the user already placed and only inserts additional `\N` inside
 * segments that overflow the effective video width.  Shares the same
 * width / font / outline measurement path as `autoLineBreakRow` via
 * the underlying `applyAutoLineBreak` call (no separate width logic).
 */
export function overflowWrapRow(
  entry: SubtitleEntry,
  labels: { history: string; noChangeToast: string }
): Promise<void> {
  return wrapRow(entry, 'overflow', labels)
}

/**
 * 複製 (REQ-20260613-001 §2-3).  Insert a full copy of `entry`
 * immediately after it in the entries array.  Both rows end up with
 * identical startSec / endSec — the user is expected to adjust the
 * times afterwards.  Pattern mirrors the AddRow flow in
 * `routes/step2.tsx`:
 *
 *   - new collision-resistant `id`
 *   - explicit `isEdited: true` + `isDeleted: false`
 *   - `original` is a snapshot of the just-copied current state, so
 *     a later Reset on the duplicate returns to the duplicate's own
 *     baseline (= what was visible at duplication time) rather than
 *     to the source row's pre-edit transcript
 *
 * Insertion order: `addEntry(duplicate, originalIdx + 1)` keeps the
 * duplicate directly under the source in the array.  Because
 * `filterEntries` reads `entries` in array order without re-sorting,
 * the list view also renders the duplicate directly under the source.
 * `sortByStartSec` is a stable sort (ES2019+) so even if it runs
 * later, equal-startSec rows preserve their array order.  In the
 * timeline view, the greedy track allocator (`timeline-layout.ts`
 * `compareForLayout`) tie-breaks on lexicographic id; both rows
 * share the same span so the duplicate lands on a separate track —
 * intentional, the user can see both clips simultaneously.
 *
 * Side effects (mirroring AddRow):
 *   - `setFocusedRowId(duplicate.id)` so the new row is highlighted
 *   - `setScrollToRowId(duplicate.id)` so the list scrolls to it
 *   - success toast acknowledging the operation
 *
 * One history op pushed; undo removes the duplicate by id; redo
 * re-inserts it directly after the original's CURRENT position
 * (re-looked up at redo time so the row stays correctly placed even
 * if surrounding rows have been reordered in the meantime).
 */
export function duplicateRow(
  entry: SubtitleEntry,
  labels: { history: string; successToast: string; maxLayerBlocked: string }
): void {
  const projectStore = useProjectStore.getState()
  const pushHistory = useHistoryStore.getState().push
  const originalIdx = projectStore.entries.findIndex((e) => e.id === entry.id)
  if (originalIdx === -1) return

  /*
   * REQ-0398 §3 — the duplicate lands ABOVE the source (front, REQ-0397 §2),
   * and if there is no free layer left it is blocked outright rather than
   * silently clamped onto an occupied row.
   *
   * REQ-0528 §1 — "above" now means "the first layer above the source that is
   * actually FREE at these times", not "source + 1".  The old form never looked
   * at what was already there, so the reported bug was: duplicate a layer-0
   * cue (copy → layer 1), then duplicate the same source again → a second copy
   * on layer 1, stacked on the first.
   *
   * The MAX_LAYER check is now the search returning `null` — one condition
   * instead of two, so "the top of the range" and "everything above is taken"
   * cannot disagree.  A source already AT MAX_LAYER still fails, because the
   * search starts above it and has nowhere to go.
   *
   * Blocked BEFORE anything is mutated: no id minted, no history op pushed, no
   * entry added.  REQ-0528 §1-3 asks for no half-applied state.
   */
  const targetLayer = findFreeLayerAbove(
    entry,
    resolveLayer(entry) + 1,
    projectStore.entries,
  )
  if (targetLayer === null) {
    toast.error(labels.maxLayerBlocked)
    return
  }

  // REQ-079 #2 / REQ-052 style id — collision-resistant when two
  // duplicates land within the same millisecond.  `dup-` prefix makes
  // the origin visible in debug tools and unit-test output.
  const newId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? `dup-${crypto.randomUUID()}`
    : `dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // REQ-0322 §2 — the field list used to live inline here and had drifted
  // 16 fields behind `SubtitleEntry` (style effects, karaoke `words`,
  // emphasis spans).  It now lives in `duplicate-entry.ts` behind a
  // `{ [K in keyof SubtitleEntry]-?: DuplicationRule }` classification, so
  // a new field that nobody classifies fails `tsc` instead of being
  // silently dropped from every duplicate.  See that module for the
  // per-field copy / deep-copy / regenerate / reset / snapshot table.
  const duplicate: SubtitleEntry = buildDuplicateEntry(entry, newId, targetLayer)

  pushHistory({
    label: labels.history,
    undo: () => {
      const s = useProjectStore.getState()
      s.setEntries(s.entries.filter((e) => e.id !== newId))
    },
    redo: () => {
      const s = useProjectStore.getState()
      const idx = s.entries.findIndex((e) => e.id === entry.id)
      const insertAt = idx === -1 ? s.entries.length : idx + 1
      s.addEntry(duplicate, insertAt)
    }
  })

  projectStore.addEntry(duplicate, originalIdx + 1)

  // REQ-20260614-001 Phase 3 — the freshly-duplicated row becomes the
  // user's current selection (drives green left-border + inspector
  // content).  `setFocusedRowId` was the pre-Phase-3 path; the playback
  // follower stays untouched here so a duplicate during playback does
  // not yank the playback-active indicator away from the playing entry.
  const ui = useUiStore.getState()
  ui.setSelectedEntryId(newId)
  ui.setScrollToRowId(newId)

  toast.success(labels.successToast)
}
