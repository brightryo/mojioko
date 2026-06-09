import type { SubtitleEntry } from '../../shared/types'
import type { TableFilter } from '@/stores/ui-store'
import { hasAnyError, hasAnyWarning, type EntryWarnings } from '@/lib/entry-warnings'
import { effectiveEntryState, type CutList } from '../../shared/cuts'

/**
 * Single source of truth for the Step 2 table's filter logic.
 *
 * Extracted out of SubtitleTable so BulkEditBar can compute the same
 * "currently visible" id list (needed for its hidden-selection count and
 * for Shift+click range selection) without duplicating the rules.  Any
 * future tab is added in one place and both consumers stay in sync.
 *
 * REQ-103 rewrite — the table now uses the spec's two-group tab model:
 *
 *   行き先 (mutually exclusive, count-conservation holds):
 *     'all'     = everything (normal + edited + manuallyDeleted + trimDeleted)
 *     'ready'   = normal + edited       (= !effectivelyDeleted)
 *     'deleted' = manuallyDeleted + trimDeleted (= effectivelyDeleted)
 *
 *     ⇒  filterEntries('ready') + filterEntries('deleted')
 *        === filterEntries('all') for every entries/cuts pair.
 *
 *   フィルタ (cross-cutting, may include deleted rows):
 *     'edited'   = wasEdited        (manual edit OR cut clamp)
 *     'warnings' = hasAnyWarning(w) (any non-empty-text warning)
 *
 *   The cross-cutting filters DO NOT exclude `effectivelyDeleted` rows
 *   because REQ-103 §B explicitly wants 編集済み to surface deleted
 *   rows that were once edited (= "削除済みでも出力対象でも、編集
 *   されていれば表示").  The timeline view applies its own additional
 *   `!effectivelyDeleted` filter on top so deleted rows never render
 *   as blocks even when the user is on 編集済み / 警告.
 *
 *   `warnings` no longer requires `!w.emptyText` to surface the row —
 *   that error is still excluded from the export filter in
 *   step2.tsx:getOutputEntries (= the row appears in the 警告 tab so
 *   the user can fix it).
 */
export function filterEntries(
  entries: readonly SubtitleEntry[],
  filter: TableFilter,
  warningsMap: ReadonlyMap<string, EntryWarnings>,
  cuts: CutList,
): SubtitleEntry[] {
  switch (filter) {
    case 'all':
      // REQ-103: include deleted rows.  The whole inventory.
      return [...entries]
    case 'ready':
      // REQ-103 行き先: normal + edited.  No emptyText filter — the
      // tab counts emptyText rows because they ARE in `normal` /
      // `edited` per the 4-state partition; the actual export filter
      // (getOutputEntries) drops them at write time.
      return entries.filter((e) => !effectiveEntryState(e, cuts).effectivelyDeleted)
    case 'edited':
      // REQ-103 フィルタ: cross-cutting — include deleted rows that
      // were once edited.  Predicate is the bare `wasEdited` flag.
      return entries.filter((e) => effectiveEntryState(e, cuts).wasEdited)
    case 'warnings':
      // REQ-103 フィルタ + REQ-121 「問題あり」: cross-cutting — include
      // every row that carries an error OR a warning so the user has
      // one place to find things to address.  Pre-REQ-121 this tab
      // showed warnings only and `emptyText` was missing entirely; the
      // new tab name ("問題あり" / "Issues") reflects the broader scope.
      // Deleted rows are still allowed through (REQ-103 §B cross-
      // cutting) so a previously-flagged row the user deleted is still
      // visible.  Step 3 transition gating in `step2.tsx` reads
      // `errorCount` (= hasAnyError) directly so the disable logic is
      // independent of which filter the user is on.
      return entries.filter((e) => {
        const w = warningsMap.get(e.id)
        return w !== undefined && (hasAnyError(w) || hasAnyWarning(w))
      })
    case 'deleted':
      // REQ-103 行き先: manuallyDeleted + trimDeleted.
      return entries.filter((e) => effectiveEntryState(e, cuts).effectivelyDeleted)
    default:
      return [...entries]
  }
}
