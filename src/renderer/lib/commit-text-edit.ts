import type { SubtitleEntry } from '../../shared/types'
import type { HistoryEntry } from '@/stores/history-store'

/**
 * REQ-0199 — shared text-commit helper used by both the list-view text cell
 * (`subtitle-table.tsx`) and the timeline inspector's text area
 * (`timeline-block-inspector.tsx`).  Extracted so the guard and the history
 * push shape live in exactly one place — the incident in REQ-0198 was two
 * copies of the same guard drifting silently from the post-REQ-0125 store
 * semantics.
 *
 * Contract:
 *   - Compares `normalizedNew` (blur-time draft, ASS-normalized) to
 *     `normalizedOnFocus` (pre-focus store text, ASS-normalized).  If they
 *     match, returns `false` and DOES NOT push a history op or mutate the
 *     store — the "focused but no net change" case.
 *   - Otherwise, pushes exactly one history op whose `undo` restores the
 *     pre-focus text and whose `redo` re-applies the blur-time text, then
 *     writes the blur-time text through `updateEntry` with `isEdited: true`.
 *
 * Why compare against `normalizedOnFocus` and not `entry.text`:
 *   The onChange stream on both surfaces writes every keystroke into the
 *   store via `updateEntryPreview` (REQ-0125 / REQ-0127) so the overlay
 *   reflects typing live.  That means `entry.text === normalizedNew`
 *   ALWAYS holds by the time commit runs, which defeats a naive
 *   `normalizedNew === entry.text` guard — every commit is skipped and
 *   text edits disappear from Undo (REQ-0198 root cause).  The pre-focus
 *   snapshot is the only value that faithfully represents "what the user
 *   was looking at when they started typing," so it is the correct
 *   comparator for "did anything actually change this session."
 *
 * Why `normalizedOnFocus: string | null`:
 *   Both call sites currently always have a focus session (CellEditor
 *   captures the value at mount; the inspector captures it in
 *   handleTextFocus).  The `null` branch is a defensive fallback for any
 *   future programmatic commit path that bypasses focus — in that case
 *   we can't judge "did anything change" so we fall through to a
 *   traditional snapshot-based history op (undo restores the full
 *   pre-commit entry).  Present callers pass strings; the branch exists
 *   so a null slip doesn't silently swallow the edit.
 */
export interface CommitTextEditParams {
  /** The entry as of just before commit (post-preview-stream). */
  entry: SubtitleEntry
  /** Blur-time draft after `\n → \N` normalization. */
  normalizedNew: string
  /** Pre-focus store text after `\n → \N` normalization; null if unavailable. */
  normalizedOnFocus: string | null
  /** i18n-resolved label for the history op (e.g. `t('history.editText')`). */
  label: string
  /** Store writer — pushes the ASS-\N form directly into the entry. */
  updateEntry: (id: string, patch: Partial<SubtitleEntry>) => void
  /** History store push. */
  pushHistory: (entry: HistoryEntry) => void
}

/**
 * Returns `true` when a history op was pushed and the store was mutated,
 * `false` when the guard fired and nothing happened.  Callers use the
 * boolean to skip any post-commit side effects (e.g. clearing dirty
 * flags) they'd only want to run on a real commit.
 */
export function commitTextEditWithHistory(params: CommitTextEditParams): boolean {
  const { entry, normalizedNew, normalizedOnFocus, label, updateEntry, pushHistory } = params

  // Guard — see the module doc-comment above for why we compare against
  // `normalizedOnFocus` and not `entry.text`.
  if (normalizedOnFocus !== null && normalizedNew === normalizedOnFocus) {
    return false
  }

  const snapshot: SubtitleEntry = { ...entry }
  const undoState: SubtitleEntry = normalizedOnFocus !== null
    ? { ...snapshot, text: normalizedOnFocus }
    : snapshot
  const redoState: SubtitleEntry = { ...snapshot, text: normalizedNew, isEdited: true }

  pushHistory({
    label,
    undo: () => updateEntry(entry.id, undoState),
    redo: () => updateEntry(entry.id, redoState),
  })
  updateEntry(entry.id, { text: normalizedNew, isEdited: true })
  return true
}
