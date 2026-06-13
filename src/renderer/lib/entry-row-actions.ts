import { toast } from 'sonner'
import type { SubtitleEntry } from '../../shared/types'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
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
 * Re-wrap a single row's text using `applyAutoLineBreak` with the row's
 * current fontSizePx / outlineThicknessPx / fontId (per-row font respected
 * for correct glyph metrics).  Strips any existing `\N` first so the
 * rewrap starts from a single-line string — same contract as the bulk
 * "auto-line-break" button.
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
export async function autoLineBreakRow(
  entry: SubtitleEntry,
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
  const stripped = latest.text.replace(/\\N/g, '')
  const rewrapped = applyAutoLineBreak(
    stripped,
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
