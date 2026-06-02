import { useTranslation } from 'react-i18next'
import { List, GanttChartSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUiStore, type EditorViewMode } from '@/stores/ui-store'

/**
 * 2-segment toggle that selects which editor view renders in the STEP 2
 * lower area: the classic subtitle table (`list`) or the horizontal
 * timeline (`timeline`).  Visual style intentionally matches the filter-
 * tab pill group on the same row (bg-zinc-900 rounded-lg p-1 + active
 * pill bg-zinc-800) so the two controls read as siblings rather than
 * one-off chrome.
 *
 * Both views read/write the same `useProjectStore.entries` — see
 * `dev-docs/specs/timeline.md` §3.  This switcher only flips a UI flag.
 */
export function EditorViewSwitcher() {
  const { t } = useTranslation(['step2'])
  const mode = useUiStore((s) => s.editorViewMode)
  const setMode = useUiStore((s) => s.setEditorViewMode)

  const OPTIONS: { key: EditorViewMode; label: string; Icon: typeof List }[] = [
    { key: 'list',     label: t('viewMode.list'),     Icon: List },
    { key: 'timeline', label: t('viewMode.timeline'), Icon: GanttChartSquare }
  ]

  return (
    <div
      role="tablist"
      aria-label={t('viewMode.ariaLabel')}
      className="flex items-center gap-1 bg-zinc-900 rounded-lg p-1"
    >
      {OPTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          role="tab"
          aria-selected={mode === key}
          type="button"
          onClick={() => setMode(key)}
          className={cn(
            'flex h-7 items-center gap-1.5 px-2.5 rounded-md text-[12px] font-medium',
            'transition-colors duration-150',
            mode === key
              ? 'bg-zinc-800 text-zinc-50'
              : 'text-zinc-500 hover:text-zinc-300'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  )
}
