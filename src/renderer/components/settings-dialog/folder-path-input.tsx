import { useTranslation } from 'react-i18next'
import { Folder, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { openDirectoryDialog } from '@/services/dialog'

interface FolderPathInputProps {
  /** Current path, or `null` when the user has not chosen one. */
  value: string | null
  onChange: (path: string | null) => void
  /** Placeholder shown when `value === null`. e.g. "システムの Videos フォルダ" */
  placeholder: string
  /** Full label for the picker's aria (used as the folder dialog's title indirectly). */
  ariaLabel: string
}

/**
 * REQ-0121 — path display + [参照…] + [クリア] used by Settings > General
 * for the user-preferred default input / output folders.  Clearing sets
 * the value back to `null`, at which point the main-side dialog handler
 * falls through to `app.getPath('videos')` per REQ.
 *
 * The dialog handler validates the path on use (`fs.existsSync`); this
 * component intentionally does NOT check the path at display time so a
 * temporarily-disconnected drive is not silently forgotten.
 */
export function FolderPathInput({ value, onChange, placeholder, ariaLabel }: FolderPathInputProps) {
  const { t } = useTranslation('settings')

  async function handleBrowse() {
    const picked = await openDirectoryDialog(value ?? undefined)
    if (picked) onChange(picked)
  }

  function handleClear() {
    onChange(null)
  }

  return (
    <div className="flex items-center gap-2 w-full min-w-0">
      <div
        className="flex-1 min-w-0 h-9 px-3 rounded-md border border-line bg-surface-1 flex items-center text-body-sm truncate"
        title={value ?? placeholder}
        aria-label={ariaLabel}
      >
        {value ? (
          <span className="text-fg-primary truncate">{value}</span>
        ) : (
          <span className="text-fg-muted italic">{placeholder}</span>
        )}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="lg"
        onClick={handleBrowse}
        className="flex-shrink-0"
      >
        <Folder />
        {t('general.folderPathBrowse')}
      </Button>
      {value !== null && (
        <Button
          type="button"
          variant="icon"
          size="lg"
          onClick={handleClear}
          className="flex-shrink-0 w-9 p-0"
          aria-label={t('general.folderPathClear')}
          title={t('general.folderPathClear')}
        >
          <X />
        </Button>
      )}
    </div>
  )
}
