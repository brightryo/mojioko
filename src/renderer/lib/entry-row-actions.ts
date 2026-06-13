import { toast } from 'sonner'
import type { SubtitleEntry } from '../../shared/types'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { commitTimeEdit } from '@/lib/commit-time-edit'

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
  const resetPatch = {
    ...original,
    fontId: original.fontId,
    isEdited: false,
    isDeleted: false
  }
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
  // Only difference between the two modes: pack pre-strips so the wrap
  // core sees a single long line; overflow passes the text through with
  // existing `\N` intact (applyAutoLineBreak then splits on `\N` and
  // measures each segment independently — see auto-line-break.ts:51).
  const input = mode === 'pack' ? latest.text.replace(/\\N/g, '') : latest.text
  const rewrapped = applyAutoLineBreak(
    input,
    latest.fontSizePx,
    latest.outlineThicknessPx,
    videoWidthPx,
    font,
    latest.fontId
  )
  if (rewrapped === latest.text) {
    toast.info(labels.noChangeToast)
    return
  }
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
  labels: { history: string; successToast: string }
): void {
  const projectStore = useProjectStore.getState()
  const pushHistory = useHistoryStore.getState().push
  const originalIdx = projectStore.entries.findIndex((e) => e.id === entry.id)
  if (originalIdx === -1) return

  // REQ-079 #2 / REQ-052 style id — collision-resistant when two
  // duplicates land within the same millisecond.  `dup-` prefix makes
  // the origin visible in debug tools and unit-test output.
  const newId = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
    ? `dup-${crypto.randomUUID()}`
    : `dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const base = {
    startSec: entry.startSec,
    endSec: entry.endSec,
    text: entry.text,
    fontSizePx: entry.fontSizePx,
    textColorHex: entry.textColorHex,
    outlineColorHex: entry.outlineColorHex,
    outlineThicknessPx: entry.outlineThicknessPx,
    fadeEnabled: entry.fadeEnabled,
    fontId: entry.fontId
  }
  const duplicate: SubtitleEntry = {
    id: newId,
    ...base,
    isDeleted: false,
    isEdited: true,
    original: { ...base }
  }

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

  const ui = useUiStore.getState()
  ui.setFocusedRowId(newId)
  ui.setScrollToRowId(newId)

  toast.success(labels.successToast)
}
