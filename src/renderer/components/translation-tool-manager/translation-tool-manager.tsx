import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages, ChevronDown, ChevronUp, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { OptionalBadge } from '@/components/ui/optional-badge'
import { AccordionCollapse } from '@/components/ui/accordion-collapse'
import { ManagedModelCard, ManagedModelDiskFooter } from '@/components/ui/managed-model-card'
import { HelpIcon } from '@/components/help-icon'
import { formatBytes } from '@/lib/format'
import { toast } from 'sonner'
import {
  TRANSLATION_TOOLS,
  getTranslationTool,
  type TranslationToolId,
  type TranslationToolsState,
  type TranslationToolInfo,
} from '../../../shared/translation-tools'
import {
  listTranslationTools,
  uninstallTranslationTool,
  setActiveTranslationTool,
  startTranslationToolDownload,
  openTranslationToolsFolder,
  TranslationToolDownloadError,
  type TranslationToolDownloadRun,
} from '@/services/translation-tool'

/**
 * REQ-0405 / REQ-0407 — translation-tool management section (download / enable /
 * delete).  Sits directly under the "処理デバイス" section in STEP 1 and mirrors
 * the Whisper model manager's accordion + row layout.
 *
 * REQ-0407 wired the real streaming download (2 tools, MADLAD-400 3B/7B, pinned
 * Nextcloud-AI CT2 int8 repos).  The in-flight "downloading NN%" + Cancel state
 * is tracked locally (the list IPC only reflects disk state); enable / delete
 * work against disk + settings.  No network traffic except an explicit download.
 */
export interface TranslationToolManagerProps {
  disabled?: boolean
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function TranslationToolManager({ disabled, isOpen: controlledIsOpen, onOpenChange }: TranslationToolManagerProps) {
  const { t } = useTranslation(['step1'])
  const [internalIsOpen, setInternalIsOpen] = useState(false)
  const isControlled = controlledIsOpen !== undefined
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen
  const setIsOpen = (next: boolean) => {
    if (!isControlled) setInternalIsOpen(next)
    onOpenChange?.(next)
  }

  const [state, setState] = useState<TranslationToolsState | null>(null)
  // REQ-0407 — local in-flight download state (the list IPC only knows disk
  // state, so the "downloading" UI is tracked here like the Whisper/GPU managers).
  const [downloadingId, setDownloadingId] = useState<TranslationToolId | null>(null)
  const [downloadPercent, setDownloadPercent] = useState(0)
  const runRef = useRef<TranslationToolDownloadRun | null>(null)

  const refresh = useCallback(async () => {
    const res = await listTranslationTools()
    if (res.ok) setState(res.data)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  function handleHeaderClick() {
    if (disabled) return
    setIsOpen(!isOpen)
  }

  async function handleDownload(id: TranslationToolId) {
    if (downloadingId !== null) return // one at a time from the UI
    setDownloadingId(id)
    setDownloadPercent(0)
    const run = startTranslationToolDownload(id, (evt) => {
      if (evt.event === 'progress') setDownloadPercent(evt.percent)
    })
    runRef.current = run
    try {
      await run.promise
      await refresh()
      toast.success(t('translationTool.downloaded'))
    } catch (err) {
      // User cancel resolves as an 'aborted' error — silent, matching the
      // Whisper/GPU download UX.
      if (!(err instanceof TranslationToolDownloadError && err.errorCode === 'aborted')) {
        toast.error(t('translationTool.downloadFailed'))
      }
    } finally {
      runRef.current = null
      setDownloadingId(null)
      setDownloadPercent(0)
    }
  }

  function handleCancelDownload() {
    runRef.current?.cancel()
  }

  const handleToggleActive = useCallback(
    async (id: TranslationToolId, currentlyActive: boolean) => {
      const res = await setActiveTranslationTool(currentlyActive ? null : id)
      if (res.ok) setState(res.data)
      else toast.error(t('translationTool.actionFailed'))
    },
    [t],
  )

  const handleDelete = useCallback(
    async (id: TranslationToolId) => {
      const res = await uninstallTranslationTool(id)
      if (res.ok) setState(res.data)
      else toast.error(t('translationTool.actionFailed'))
    },
    [t],
  )

  const toolInfo = (id: TranslationToolId): TranslationToolInfo | undefined =>
    state?.tools.find((x) => x.id === id)

  return (
    <div className={cn(disabled && 'opacity-50 pointer-events-none')}>
      {/* Accordion header — mirrors GpuToolManager / WhisperModelManager. */}
      <div
        role="button"
        aria-expanded={isOpen}
        tabIndex={0}
        onClick={handleHeaderClick}
        className="flex items-center gap-2 w-full select-none cursor-pointer hover:opacity-90 transition-opacity duration-150"
      >
        <Languages className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
        <span className="text-headline font-semibold text-fg-secondary uppercase tracking-wider">
          {t('translationTool.label')}
        </span>
        <OptionalBadge />
        <span onClick={(e) => e.stopPropagation()}>
          <HelpIcon content={t('translationTool.tooltip')} />
        </span>

        <div className="flex-1" />

        {state?.activeId && (
          <>
            <span className="text-body-sm font-mono text-fg-secondary flex-shrink-0">
              {t(`translationTool.${getTranslationTool(state.activeId).labelKey}`)}
            </span>
            <Check className="h-4 w-4 text-primary flex-shrink-0" aria-label={t('translationTool.enabledBadge')} />
          </>
        )}
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-fg-muted flex-shrink-0 ml-1" />
        ) : (
          <ChevronDown className="h-4 w-4 text-fg-muted flex-shrink-0 ml-1" />
        )}
      </div>

      <AccordionCollapse open={isOpen}>
        <div className="space-y-3 pt-3">
          {/* MADLAD explanation + "translation coming later" note (kept). */}
          <p className="text-body-sm text-fg-muted leading-relaxed">
            {t('translationTool.descriptionLong')}
          </p>
          {/* REQ-0408 — same 2-column card grid + disk footer as the Whisper
              model picker, via the shared ManagedModelCard. */}
          <div className="grid grid-cols-2 gap-3 mx-auto max-w-[38rem]">
            {TRANSLATION_TOOLS.map((def) => {
              const info = toolInfo(def.id)
              const isDownloading = downloadingId === def.id
              const status = info?.status ?? 'not-downloaded'
              const active = info?.active ?? false
              const cardState = active ? 'active' : status === 'downloaded' ? 'downloaded' : 'not-downloaded'
              const sizeLabel =
                status === 'downloaded' && info && info.sizeBytes > 0
                  ? formatBytes(info.sizeBytes)
                  : t('translationTool.approx', { size: formatBytes(def.expectedSizeBytes) })
              return (
                <ManagedModelCard
                  key={def.id}
                  title={t(`translationTool.${def.labelKey}`)}
                  sizeLabel={sizeLabel}
                  description={t(def.id === 'madlad400-3b' ? 'translationTool.desc3b' : 'translationTool.desc7b')}
                  state={cardState}
                  isDownloading={isDownloading}
                  downloadPercent={downloadPercent}
                  onDownload={() => handleDownload(def.id)}
                  onSelect={() => handleToggleActive(def.id, false)}
                  onDeselect={() => handleToggleActive(def.id, true)}
                  onDelete={() => handleDelete(def.id)}
                  onCancel={handleCancelDownload}
                  labels={{
                    download: t('translationTool.download'),
                    downloading: t('model.downloading'),
                    cancel: t('model.cancelDownload'),
                    useThis: t('translationTool.useThis'),
                    selected: t('translationTool.inUse'),
                    installedBadge: t('translationTool.installedBadge'),
                    activeBadge: t('translationTool.inUse'),
                    deleteTitle: t('translationTool.delete'),
                  }}
                />
              )
            })}
          </div>
          <ManagedModelDiskFooter
            totalUsedBytes={state ? state.totalUsedBytes : null}
            diskDrive={state?.diskDrive || 'C:\\'}
            diskFreeBytes={state?.diskFreeBytes ?? 0}
            onOpenFolder={() => { openTranslationToolsFolder().catch(() => {}) }}
            labels={{
              totalUsed: t('model.totalUsed'),
              diskFree: t('model.diskFree'),
              openFolder: t('model.openFolder'),
            }}
          />
        </div>
      </AccordionCollapse>
    </div>
  )
}
