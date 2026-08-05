import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages, ChevronDown, ChevronUp, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { OptionalBadge } from '@/components/ui/optional-badge'
import { AccordionCollapse } from '@/components/ui/accordion-collapse'
import { ManagedModelCard, ManagedModelDiskFooter } from '@/components/ui/managed-model-card'
import { HelpIcon } from '@/components/help-icon'
import { formatBytes, formatBytesPerSec, formatEtaSeconds } from '@/lib/format'
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
  // REQ-0407/0409 — PER-TOOL in-flight download state so 3B and 7B (and the
  // Whisper models) run in PARALLEL, each with its own progress % + MB/s · ETA
  // detail + cancel.  A key present in this record means that tool is
  // downloading; the runs ref holds each tool's cancel handle.
  const [downloads, setDownloads] = useState<Record<string, { percent: number; detail: string }>>({})
  const runsRef = useRef<Map<TranslationToolId, TranslationToolDownloadRun>>(new Map())

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

  const setToolProgress = useCallback((id: TranslationToolId, percent: number, detail: string) => {
    setDownloads((d) => ({ ...d, [id]: { percent, detail } }))
  }, [])

  const clearToolDownload = useCallback((id: TranslationToolId) => {
    runsRef.current.delete(id)
    setDownloads((d) => {
      const next = { ...d }
      delete next[id]
      return next
    })
  }, [])

  const handleDownload = useCallback(
    async (id: TranslationToolId) => {
      if (runsRef.current.has(id)) return // this tool is already downloading
      setToolProgress(id, 0, '')
      const run = startTranslationToolDownload(id, (evt) => {
        if (evt.event !== 'progress') return
        const mbps = formatBytesPerSec(evt.bytesPerSec ?? 0)
        const eta =
          evt.receivedBytes !== undefined && evt.totalBytes !== undefined
            ? formatEtaSeconds(evt.totalBytes - evt.receivedBytes, evt.bytesPerSec ?? 0)
            : ''
        const detail = [mbps, eta ? t('translationTool.eta', { time: eta }) : ''].filter(Boolean).join(' · ')
        setToolProgress(id, evt.percent, detail)
      })
      runsRef.current.set(id, run)
      try {
        await run.promise
        await refresh()
        toast.success(t('translationTool.downloaded'))
      } catch (err) {
        // User cancel resolves as an 'aborted' error — silent (Whisper/GPU UX).
        if (!(err instanceof TranslationToolDownloadError && err.errorCode === 'aborted')) {
          toast.error(t('translationTool.downloadFailed'))
        }
      } finally {
        clearToolDownload(id)
      }
    },
    [t, refresh, setToolProgress, clearToolDownload],
  )

  function handleCancelDownload(id: TranslationToolId) {
    runsRef.current.get(id)?.cancel()
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
        {/* REQ-0425 — dropped `uppercase` (see whisper-model-manager) for
            consistent, as-authored section headers across STEP1. */}
        <span className="text-body font-semibold text-fg-secondary tracking-wider">
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
              const dl = downloads[def.id]
              const isDownloading = dl !== undefined
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
                  downloadPercent={dl?.percent ?? 0}
                  downloadDetail={dl?.detail ?? ''}
                  onDownload={() => handleDownload(def.id)}
                  onSelect={() => handleToggleActive(def.id, false)}
                  onDeselect={() => handleToggleActive(def.id, true)}
                  onDelete={() => handleDelete(def.id)}
                  onCancel={() => handleCancelDownload(def.id)}
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
