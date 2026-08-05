import { Check, Download, Target, Trash2, Database, HardDrive, FolderOpen } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/format'

/**
 * REQ-0408 — shared, PRESENTATIONAL card for a downloadable/managed model or
 * tool.  Extracted verbatim from `WhisperModelManager`'s inline `ModelCard` so
 * the Whisper model picker and the translation-tool section render the exact
 * same chrome (title + size + description + recommended chip + installed/active
 * badge + state-driven actions + in-card download progress).
 *
 * It owns NO i18n and NO business logic: every label is passed in and every
 * action is a callback, so both callers keep their own namespace + handlers.
 */

export type ManagedCardState = 'not-downloaded' | 'downloaded' | 'active'

export interface ManagedModelCardLabels {
  download: string
  downloading: string
  cancel: string
  /** "Use this" button (a downloaded, non-active card). */
  useThis: string
  /** The active card's button text ("選択中" / "使用中"). */
  selected: string
  /** Top-right badge on a downloaded, non-active card. */
  installedBadge: string
  /** Top-right badge on the active card. */
  activeBadge: string
  /** Chip shown when `recommended`. */
  recommended?: string
  /** Delete (trash) button title. */
  deleteTitle: string
}

export interface ManagedModelCardProps {
  title: string
  /** Pre-formatted size (Whisper: expected size; tool: disk size when installed). */
  sizeLabel: string
  description: string
  state: ManagedCardState
  recommended?: boolean
  isDownloading?: boolean
  downloadPercent?: number
  /** Current file being fetched (optional; falls back to `labels.downloading`). */
  downloadFile?: string
  /** REQ-0409 — optional throughput/ETA line under the progress bar (e.g. "12.3 MB/s · 2:30"). */
  downloadDetail?: string
  onDownload?: () => void
  onSelect?: () => void
  onDelete?: () => void
  onCancel?: () => void
  /**
   * Optional — when provided, the ACTIVE card's button becomes clickable to
   * turn the selection off.  Whisper omits it (you switch by picking another),
   * so its active button stays disabled; the translation tool passes it.
   */
  onDeselect?: () => void
  labels: ManagedModelCardLabels
}

export function ManagedModelCard({
  title,
  sizeLabel,
  description,
  state,
  recommended = false,
  isDownloading = false,
  downloadPercent = 0,
  downloadFile = '',
  downloadDetail = '',
  onDownload,
  onSelect,
  onDelete,
  onCancel,
  onDeselect,
  labels,
}: ManagedModelCardProps) {
  const isActive = state === 'active'
  const isInstalled = state !== 'not-downloaded'

  return (
    <div
      className={cn(
        'rounded-md border p-4 flex flex-col gap-3 transition-colors duration-150',
        isActive ? 'border-primary bg-primary/5' : 'border-line bg-surface-0',
      )}
    >
      {/* Top: name + size + recommended chip + status badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-body font-semibold text-fg-primary leading-tight">{title}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className={cn('text-body-sm', isActive ? 'text-primary-hover' : 'text-fg-disabled')}>{sizeLabel}</p>
            {recommended && labels.recommended && (
              <span className="flex-shrink-0 inline-flex items-center text-caption font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary-hover whitespace-nowrap">
                {labels.recommended}
              </span>
            )}
          </div>
        </div>
        {isInstalled && (
          <span
            className={cn(
              'flex-shrink-0 flex items-center gap-1 text-caption font-medium px-2 py-0.5 rounded-full whitespace-nowrap',
              isActive ? 'bg-primary text-fg-inverse' : 'bg-row-selected/15 text-info',
            )}
          >
            <Check className="h-2.5 w-2.5" />
            {isActive ? labels.activeBadge : labels.installedBadge}
          </span>
        )}
      </div>

      {/* Description */}
      <p className="text-body-sm text-fg-muted leading-relaxed flex-1">{description}</p>

      {/* Action area */}
      {isDownloading ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-caption text-fg-muted">
            <span className="truncate mr-2">{downloadFile || labels.downloading}</span>
            <span className="tabular-nums flex-shrink-0">{downloadPercent}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300 rounded-full"
              style={{ width: `${downloadPercent}%` }}
            />
          </div>
          {downloadDetail && (
            <div className="text-caption font-mono tabular-nums text-fg-muted text-right">{downloadDetail}</div>
          )}
          <Button variant="ghost" size="sm" className="w-full h-7 text-caption" onClick={onCancel}>
            {labels.cancel}
          </Button>
        </div>
      ) : state === 'not-downloaded' ? (
        <Button variant="secondary" size="sm" className="w-full" onClick={onDownload}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {labels.download}
        </Button>
      ) : isActive ? (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'flex-1 text-primary-hover',
              onDeselect ? 'hover:text-primary-hover' : 'cursor-default hover:text-primary-hover hover:bg-transparent',
            )}
            disabled={!onDeselect}
            onClick={onDeselect}
          >
            <Check className="h-3.5 w-3.5 mr-1.5" />
            {labels.selected}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-fg-disabled hover:text-destructive-soft"
            onClick={onDelete}
            title={labels.deleteTitle}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="flex-1" onClick={onSelect}>
            <Target className="h-3.5 w-3.5 mr-1.5" />
            {labels.useThis}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-fg-disabled hover:text-destructive-soft"
            onClick={onDelete}
            title={labels.deleteTitle}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

export function ManagedModelCardSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-surface-0 p-4 space-y-3 animate-pulse">
      <div className="h-4 w-16 bg-surface-2 rounded" />
      <div className="h-3 w-full bg-surface-2 rounded" />
      <div className="h-8 w-full bg-surface-2 rounded-md" />
    </div>
  )
}

export interface ManagedModelDiskFooterProps {
  totalUsedBytes: number | null
  diskDrive: string
  diskFreeBytes: number
  /** Optional tailwind color class for the free-space label (disk-low warning). */
  diskWarnColor?: string
  onOpenFolder: () => void
  labels: { totalUsed: string; diskFree: string; openFolder: string }
}

/** The "used capacity / free / open folder" footer shared by both sections. */
export function ManagedModelDiskFooter({
  totalUsedBytes,
  diskDrive,
  diskFreeBytes,
  diskWarnColor,
  onOpenFolder,
  labels,
}: ManagedModelDiskFooterProps) {
  return (
    <div className="rounded-lg border border-line px-4 py-2.5 flex items-center justify-between mx-auto max-w-[38rem]">
      <div className="flex items-center gap-5 text-body-sm">
        <span className="flex items-center gap-1.5 text-fg-tertiary">
          <Database className="h-3.5 w-3.5 flex-shrink-0" />
          {labels.totalUsed}: {totalUsedBytes !== null ? formatBytes(totalUsedBytes) : '—'}
        </span>
        <span className={cn('flex items-center gap-1.5', diskWarnColor)}>
          <HardDrive className="h-3.5 w-3.5 flex-shrink-0" />
          {diskDrive} {labels.diskFree}: {diskFreeBytes > 0 ? formatBytes(diskFreeBytes) : '—'}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-caption text-fg-muted hover:text-fg-secondary"
        onClick={(e) => {
          e.stopPropagation()
          onOpenFolder()
        }}
      >
        <FolderOpen className="h-3 w-3 mr-1" />
        {labels.openFolder}
      </Button>
    </div>
  )
}
