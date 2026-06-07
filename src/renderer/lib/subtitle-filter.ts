import type { SubtitleEntry } from '../../shared/types'
import type { TableFilter } from '@/stores/ui-store'
import { hasAnyWarning, type EntryWarnings } from '@/lib/entry-warnings'
import { effectiveEntryState, type CutList } from '../../shared/cuts'

/**
 * Single source of truth for the Step 2 table's filter logic.
 *
 * Extracted out of SubtitleTable so BulkEditBar can compute the same
 * "currently visible" id list (needed for its hidden-selection count and
 * for Shift+click range selection) without duplicating the rules.  Any
 * future tab is added in one place and both consumers stay in sync.
 *
 * REQ-102: every tab predicate is now driven by the cut-aware
 * `effectiveEntryState` so the table, the timeline view (which also
 * calls filterEntries with `tableFilter = 'all'` in REQ-101) and the
 * burn-in output agree on which subtitles are present.  Mapping:
 *   - effectivelyDeleted = manual `entry.isDeleted` OR
 *     `applyCutsToEntry(entry, cuts) === null` (fully contained or
 *     clamped below MIN_SUBTITLE_DURATION_SEC).
 *   - effectivelyEdited = manual `entry.isEdited` OR cut-induced
 *     start/end clamp (= partial overlap).
 * No table predicate touches `entry.isDeleted` / `entry.isEdited`
 * directly anymore; cut-induced classification rides on top of the
 * manual flags without mutating the stored entry.
 */
export function filterEntries(
  entries: readonly SubtitleEntry[],
  filter: TableFilter,
  warningsMap: ReadonlyMap<string, EntryWarnings>,
  cuts: CutList,
): SubtitleEntry[] {
  switch (filter) {
    case 'all':
      return entries.filter((e) => !effectiveEntryState(e, cuts).effectivelyDeleted)
    case 'ready':
      // Output target = warnings allowed, errors (empty text /
      // deleted / effectively-cut-deleted) dropped.
      return entries.filter((e) => {
        const w = warningsMap.get(e.id)
        if (w === undefined) return false
        const state = effectiveEntryState(e, cuts)
        return !state.effectivelyDeleted && !w.emptyText
      })
    case 'edited':
      return entries.filter((e) => {
        const state = effectiveEntryState(e, cuts)
        return state.effectivelyEdited && !state.effectivelyDeleted
      })
    case 'warnings':
      return entries.filter((e) => {
        const state = effectiveEntryState(e, cuts)
        if (state.effectivelyDeleted) return false
        const w = warningsMap.get(e.id)
        return w !== undefined && hasAnyWarning(w)
      })
    case 'deleted':
      return entries.filter((e) => effectiveEntryState(e, cuts).effectivelyDeleted)
    default:
      return entries.filter((e) => !effectiveEntryState(e, cuts).effectivelyDeleted)
  }
}
