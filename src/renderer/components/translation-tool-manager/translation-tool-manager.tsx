import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Languages, ChevronDown, ChevronUp, Check, Trash2, Download } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { OptionalBadge } from '@/components/ui/optional-badge'
import { AccordionCollapse } from '@/components/ui/accordion-collapse'
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
} from '@/services/translation-tool'

/**
 * REQ-0405 — translation-tool management section (Phase 1: download / enable /
 * delete).  Sits directly under the "処理デバイス" section in STEP 1 and mirrors
 * the Whisper model manager's accordion + row layout.
 *
 * Phase 1 tools are placeholders (no download source), so clicking Download
 * shows a "coming soon" message WITHOUT touching the network — the whole UI
 * stays offline (REQ-0405 §6).  Enable / delete work against disk + settings so
 * they light up the moment a real model is present (or wired in a later REQ).
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
  const [busyId, setBusyId] = useState<TranslationToolId | null>(null)

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

  function handleDownload(id: TranslationToolId) {
    // Phase 1 — every tool is a placeholder (no repo).  Show a "coming soon"
    // message and make NO network call, keeping the app fully offline.
    if (getTranslationTool(id).repo === null) {
      toast.info(t('translationTool.comingSoon'))
      return
    }
    // (When a real repo is wired, the streaming download starts here.)
  }

  const handleToggleActive = useCallback(
    async (id: TranslationToolId, currentlyActive: boolean) => {
      setBusyId(id)
      const res = await setActiveTranslationTool(currentlyActive ? null : id)
      setBusyId(null)
      if (res.ok) setState(res.data)
      else toast.error(t('translationTool.actionFailed'))
    },
    [t],
  )

  const handleDelete = useCallback(
    async (id: TranslationToolId) => {
      setBusyId(id)
      const res = await uninstallTranslationTool(id)
      setBusyId(null)
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
          <p className="text-body-sm text-fg-muted leading-relaxed">
            {t('translationTool.descriptionLong')}
          </p>
          <div className="space-y-2">
            {TRANSLATION_TOOLS.map((def) => {
              const info = toolInfo(def.id)
              const status = info?.status ?? 'not-downloaded'
              const active = info?.active ?? false
              const sizeLabel =
                status === 'downloaded' && info && info.sizeBytes > 0
                  ? formatBytes(info.sizeBytes)
                  : t('translationTool.approx', { size: formatBytes(def.expectedSizeBytes) })
              const isBusy = busyId === def.id
              return (
                <div
                  key={def.id}
                  className="flex items-center gap-3 rounded-md border border-line bg-surface-1 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-body-sm font-medium text-fg-primary truncate">
                      {t(`translationTool.${def.labelKey}`)}
                    </div>
                    <div className="text-caption font-mono tabular-nums text-fg-muted">{sizeLabel}</div>
                  </div>

                  {status === 'not-downloaded' && (
                    <Button variant="secondary" size="sm" onClick={() => handleDownload(def.id)} className="flex-shrink-0 gap-1.5">
                      <Download className="h-3.5 w-3.5" />
                      {t('translationTool.download')}
                    </Button>
                  )}

                  {status === 'downloading' && (
                    <span className="text-caption text-fg-muted flex-shrink-0">{t('translationTool.downloading')}</span>
                  )}

                  {status === 'downloaded' && (
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Button
                        variant={active ? 'primary' : 'secondary'}
                        size="sm"
                        disabled={isBusy}
                        onClick={() => handleToggleActive(def.id, active)}
                        className="gap-1.5"
                      >
                        {active && <Check className="h-3.5 w-3.5" />}
                        {active ? t('translationTool.enabled') : t('translationTool.enable')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isBusy}
                        onClick={() => handleDelete(def.id)}
                        aria-label={t('translationTool.delete')}
                        title={t('translationTool.delete')}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-fg-tertiary" />
                      </Button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </AccordionCollapse>
    </div>
  )
}
