import { useTranslation } from 'react-i18next'
import { List, GanttChartSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUiStore, type EditorViewMode } from '@/stores/ui-store'

/**
 * 2-segment toggle that selects which editor view renders in the STEP 2
 * lower area: the classic subtitle table (`list`) or the horizontal
 * timeline (`timeline`).  Visual style intentionally matches the filter-
 * tab pill group on the same row (bg-surface-1 rounded-lg p-1 + active
 * pill bg-surface-2) so the two controls read as siblings rather than
 * one-off chrome.
 *
 * Both views read/write the same `useProjectStore.entries` — see
 * `dev-docs/specs/timeline.md` §3.  This switcher only flips a UI flag.
 */
export function EditorViewSwitcher() {
  const { t } = useTranslation(['step2'])
  const mode = useUiStore((s) => s.editorViewMode)
  const setMode = useUiStore((s) => s.setEditorViewMode)
  // REQ-20260615-059 A — switching to the timeline view collapses any
  // bulk selection so a clip click drives the single-row inspector
  // instead of leaving the bulk-edit panel up (where the per-row
  // inspector controls would be hidden).  List view still preserves
  // selection on the way out so the user can come back to it from the
  // timeline if they want.
  const clearRowSelection = useUiStore((s) => s.clearRowSelection)

  // REQ-068: timeline first because it is now the default view (REQ-063).
  // Putting the default leftmost matches the user's mental "primary →
  // secondary" reading order so the active segment sits where they look first.
  const OPTIONS: { key: EditorViewMode; label: string; Icon: typeof List }[] = [
    { key: 'timeline', label: t('viewMode.timeline'), Icon: GanttChartSquare },
    { key: 'list',     label: t('viewMode.list'),     Icon: List }
  ]

  return (
    <div
      role="tablist"
      aria-label={t('viewMode.ariaLabel')}
      className="flex items-center gap-1 bg-surface-1 rounded-lg p-1"
    >
      {OPTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          role="tab"
          aria-selected={mode === key}
          type="button"
          onClick={() => {
            if (key === 'timeline') clearRowSelection()
            setMode(key)
          }}
          className={cn(
            'flex h-7 items-center gap-1.5 px-2.5 rounded-md text-body-sm font-medium',
            'transition-colors duration-150',
            mode === key
              ? 'bg-surface-2 text-fg-primary'
              : 'text-fg-muted hover:text-fg-secondary'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}
