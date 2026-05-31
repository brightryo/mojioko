import type { SubtitleEntry } from '../../shared/types'
import type { TableFilter } from '@/stores/ui-store'
import { hasAnyWarning, isOutputTarget, type EntryWarnings } from '@/lib/entry-warnings'

/**
 * Single source of truth for the Step 2 table's filter logic.
 *
 * Extracted out of SubtitleTable so BulkEditBar can compute the same
 * "currently visible" id list (needed for its hidden-selection count and
 * for Shift+click range selection) without duplicating the rules.  Any
 * future tab is added in one place and both consumers stay in sync.
 */
export function filterEntries(
  entries: readonly SubtitleEntry[],
  filter: TableFilter,
  warningsMap: ReadonlyMap<string, EntryWarnings>
): SubtitleEntry[] {
  switch (filter) {
    case 'all':
      return entries.filter((e) => !e.isDeleted)
    case 'ready':
      // Output target = warnings allowed, errors (empty text / deleted) dropped.
      return entries.filter((e) => {
        const w = warningsMap.get(e.id)
        return w !== undefined && isOutputTarget(e, w)
      })
    case 'edited':
      return entries.filter((e) => e.isEdited && !e.isDeleted)
    case 'warnings':
      return entries.filter((e) => {
        if (e.isDeleted) return false
        const w = warningsMap.get(e.id)
        return w !== undefined && hasAnyWarning(w)
      })
    case 'deleted':
      return entries.filter((e) => e.isDeleted)
    default:
      return entries.filter((e) => !e.isDeleted)
  }
}
