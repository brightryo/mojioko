import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sparkles,
  Download,
  Trash2,
  Check,
  Target,
  Database,
  HardDrive,
  ShieldCheck,
  FolderOpen,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  Settings2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { HelpIcon } from '@/components/help-icon'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import {
  listModels,
  uninstallModel,
  setActiveModel,
  openModelsFolder,
  downloadModel
} from '@/services/transcription'
import type { DownloadRun } from '@/services/transcription'
import type { ModelInfo, ModelsState, WhisperModelId } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_INSTALL_TIME: Record<string, Record<string, string>> = {
  ja: { small: '約2〜10分', medium: '約5〜30分', 'large-v3': '約10〜60分' },
  en: { small: '~2–10 min', medium: '~5–30 min', 'large-v3': '~10–60 min' }
}

const DESC_KEY: Record<string, string> = {
  small: 'whisperModel.descSmall',
  medium: 'whisperModel.descMedium',
  'large-v3': 'whisperModel.descLargeV3'
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WhisperModelManagerProps {
  onActiveModelChange?: (modelId: WhisperModelId | null) => void
  disabled?: boolean
  /**
   * Optional controlled-mode props.  When `isOpen` is provided the
   * accordion stops managing its own open state and reflects the
   * parent's value, calling `onOpenChange` whenever the user clicks
   * the header.  Internal auto-open / auto-close transitions (e.g.,
   * collapsing after a model is auto-activated) also route through
   * `onOpenChange` so the parent stays in sync.  When `isOpen` is
   * omitted, the component falls back to its own state — matches the
   * prior uncontrolled behaviour for callers that don't need the
   * exclusion-with-siblings pattern Step 1 uses.
   */
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * REQ-20260615-020: when provided, the header renders a gear icon
   * button that calls this on click (with stopPropagation so the
   * accordion does not toggle).  step1 passes
   * `() => setAdvancedDialogOpen(true)` here, replacing the previous
   * absolutely-positioned Advanced text button.
   */
  onOpenAdvanced?: () => void
}

type DialogKind =
  | { kind: 'install-confirm'; model: ModelInfo }
  | { kind: 'disk-full'; model: ModelInfo; required: number; available: number }
  | { kind: 'uninstall-confirm'; model: ModelInfo }

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WhisperModelManager({
  onActiveModelChange,
  disabled,
  isOpen: controlledIsOpen,
  onOpenChange,
  onOpenAdvanced
}: WhisperModelManagerProps) {
  const { t, i18n } = useTranslation('step1')

  const [state, setState] = useState<ModelsState | null>(null)
  // Internal-mode open state.  Used as the source of truth only when the
  // parent did not pass a controlled `isOpen` prop; otherwise this is a
  // shadow value the controlled mode never reads.
  const [internalIsOpen, setInternalIsOpen] = useState(false)
  const isControlled = controlledIsOpen !== undefined
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen
  // setIsOpen routes through onOpenChange in controlled mode so the
  // parent receives every transition — including the internal auto-open /
  // auto-close ones below (e.g. collapsing after a model is auto-activated).
  function setIsOpen(next: boolean) {
    if (!isControlled) setInternalIsOpen(next)
    onOpenChange?.(next)
  }
  const initializedRef = useRef(false)
  const [downloadingId, setDownloadingId] = useState<WhisperModelId | null>(null)
  const [downloadPercent, setDownloadPercent] = useState(0)
  const [downloadFile, setDownloadFile] = useState('')
  const [dialog, setDialog] = useState<DialogKind | null>(null)
  const downloadRunRef = useRef<DownloadRun | null>(null)

  async function refresh() {
    const result = await listModels()
    if (result.ok) {
      setState(result.data)
      onActiveModelChange?.(result.data.activeModelId)
    }
  }

  useEffect(() => {
    refresh().catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // On first data load we used to auto-expand when no active model was set.
  // That guaranteed the user saw the model picker, but the expanded panel is
  // ~298 px tall and pushed the Step 1 layout over the 1280×820 viewport
  // budget — the entire route scrolled even on a fully maximised window.
  //
  // Now the accordion always starts collapsed.  The unselected state is
  // still surfaced through the existing amber AlertTriangle badge (see
  // `headerBadge` below, the `notInstalledBadge` / `noActiveBadge` branch)
  // plus a "click to select" hint added next to the chevron, so the user
  // can still tell at a glance that they need to pick a model.
  useEffect(() => {
    if (state && !initializedRef.current) {
      initializedRef.current = true
    }
  }, [state])

  // --- Install flow ---

  function handleInstallClick(model: ModelInfo) {
    if (!state) return
    const required = model.expectedSizeBytes * 1.5
    if (state.diskFreeBytes > 0 && state.diskFreeBytes < required) {
      setDialog({ kind: 'disk-full', model, required, available: state.diskFreeBytes })
      return
    }
    setDialog({ kind: 'install-confirm', model })
  }

  async function handleConfirmInstall(model: ModelInfo) {
    setDialog(null)
    setDownloadingId(model.id)
    setDownloadPercent(0)
    setDownloadFile('')

    const run = downloadModel(model.id, (evt) => {
      if (evt.event === 'progress') {
        setDownloadFile(evt.file)
        setDownloadPercent(evt.percent)
      }
    })
    downloadRunRef.current = run

    try {
      await run.promise
      const currentActive = state?.activeModelId
      if (!currentActive) {
        await setActiveModel(model.id)
        setIsOpen(false) // auto-activated → collapse so user can continue
      }
      toast.success(t('model.install_success', { modelName: model.displayName }))
      await refresh()
    } catch (err) {
      const msg = String(err)
      if (!msg.includes('Cancelled')) {
        toast.error(t('toast.modelDownloadFailed', { error: msg }))
      }
    } finally {
      setDownloadingId(null)
      downloadRunRef.current = null
    }
  }

  function handleCancelDownload() {
    downloadRunRef.current?.cancel()
    downloadRunRef.current = null
    setDownloadingId(null)
    setDownloadPercent(0)
    setDownloadFile('')
  }

  // --- Activate ---

  async function handleActivate(model: ModelInfo) {
    const result = await setActiveModel(model.id)
    if (result.ok) {
      setState(result.data)
      onActiveModelChange?.(result.data.activeModelId)
      toast.success(t('model.activate_success', { modelName: model.displayName }))
      setIsOpen(false) // switched active model → collapse
    } else {
      toast.error(result.error.message)
    }
  }

  // --- Uninstall flow ---

  function handleUninstallClick(model: ModelInfo) {
    setDialog({ kind: 'uninstall-confirm', model })
  }

  async function handleConfirmUninstall(model: ModelInfo) {
    setDialog(null)
    const result = await uninstallModel(model.id)
    if (result.ok) {
      setState(result.data)
      onActiveModelChange?.(result.data.activeModelId)
      toast.success(t('model.uninstall_success', { modelName: model.displayName }))
      if (!result.data.activeModelId) {
        setIsOpen(true) // no active model left → expand to prompt re-selection
      }
    } else {
      toast.error(result.error.message)
    }
  }

  // ---------------------------------------------------------------------------
  // Render helpers
  // ---------------------------------------------------------------------------

  const activeModel = state?.models.find((m) => m.id === state?.activeModelId) ?? null

  const diskWarnColor =
    state && state.diskFreeBytes > 0
      ? state.diskFreeBytes < 1_000_000_000
        ? 'text-destructive-soft'
        : state.diskFreeBytes < 5_000_000_000
        ? 'text-warning-soft'
        : 'text-fg-tertiary'
      : 'text-fg-disabled'

  // REQ-20260615-020: the header now reads "model name → gear → green
  // check → chevron" right-aligned, so the active / not-installed pill
  // and the "click to change" hint are gone.  Green check shows only
  // when a model is BOTH downloaded AND selected (= status === 'active').
  const isModelReady = activeModel?.status === 'active'

  return (
    <div className={cn(disabled && 'opacity-50 pointer-events-none')}>
      {/* ---- Accordion Header ---- */}
      {/* REQ-082: Enter / Space keyboard activation removed. */}
      {/* REQ-20260615-020: right-aligned cluster is "model name → gear
          → green check (conditional) → chevron".  Gear opens the
          Advanced dialog via onOpenAdvanced and uses stopPropagation so
          the click doesn't bubble to the row's toggle handler. */}
      <div
        role="button"
        aria-expanded={isOpen}
        tabIndex={0}
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 w-full cursor-pointer select-none hover:opacity-90 transition-opacity duration-150"
      >
        <Sparkles className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
        <span className="text-headline font-semibold text-fg-secondary uppercase tracking-wider">
          {t('whisperModel.label')}
        </span>
        {/* Stop propagation so tooltip interaction doesn't toggle accordion */}
        <span onClick={(e) => e.stopPropagation()}>
          <HelpIcon content={t('whisperModel.tooltip')} />
        </span>

        <div className="flex-1" />

        {/* Active model display name */}
        {activeModel && (
          <span className="text-body-sm font-mono text-fg-secondary flex-shrink-0">
            {activeModel.displayName}
          </span>
        )}

        {/* Gear icon button — opens Advanced dialog without toggling accordion. */}
        {onOpenAdvanced && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpenAdvanced()
            }}
            disabled={disabled}
            aria-label={t('advanced.openButton')}
            title={t('advanced.openButton')}
            className={cn(
              'inline-flex h-7 w-7 items-center justify-center rounded-md border border-line text-fg-muted',
              'hover:text-fg-secondary hover:border-line-strong hover:bg-surface-1 transition-colors duration-150',
              'focus:outline-none focus-visible:outline-none',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Green check — only when downloaded AND selected. */}
        {isModelReady && (
          <Check className="h-4 w-4 text-primary flex-shrink-0" aria-label={t('model.active')} />
        )}

        {/* Chevron */}
        {isOpen ? (
          <ChevronUp className="h-4 w-4 text-fg-muted flex-shrink-0 ml-1" />
        ) : (
          <ChevronDown className="h-4 w-4 text-fg-muted flex-shrink-0 ml-1" />
        )}
      </div>

      {/* ---- Accordion Content ---- */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-3 pt-3">
              {/* Long description */}
              <p className="text-body-sm text-fg-muted leading-relaxed">
                {t('whisperModel.descriptionLong')}
              </p>

              {/* 3-column model grid.  REQ-20260615-012: capped at 57rem
                  (912 px ≈ the un-capped grid width before REQ-20260615-012
                  pulled the Advanced button out of the flex row).  Combined
                  with `mx-auto` and the now-1018 px parent (= section card
                  inner), this yields ~53 px of equal left/right margin
                  while keeping each card at ~296 px — virtually identical
                  to the pre-REQ-011 visible size. */}
              <div className="grid grid-cols-3 gap-3 mx-auto max-w-[57rem]">
                {state
                  ? state.models.map((model) => (
                      <ModelCard
                        key={model.id}
                        model={model}
                        isDownloading={downloadingId === model.id}
                        downloadPercent={downloadPercent}
                        downloadFile={downloadFile}
                        onInstall={() => handleInstallClick(model)}
                        onActivate={() => handleActivate(model)}
                        onUninstall={() => handleUninstallClick(model)}
                        onCancelDownload={handleCancelDownload}
                        t={t}
                      />
                    ))
                  : [0, 1, 2].map((i) => <ModelCardSkeleton key={i} />)}
              </div>

              {/* Bottom status bar */}
              <div className="rounded-lg border border-line px-4 py-2.5 flex items-center justify-between">
                <div className="flex items-center gap-5 text-body-sm">
                  <span className="flex items-center gap-1.5 text-fg-tertiary">
                    <Database className="h-3.5 w-3.5 flex-shrink-0" />
                    {t('model.totalUsed')}: {state ? formatBytes(state.totalUsedBytes) : '—'}
                  </span>
                  <span className={cn('flex items-center gap-1.5', diskWarnColor)}>
                    <HardDrive className="h-3.5 w-3.5 flex-shrink-0" />
                    {state?.diskDrive ?? 'C:\\'} {t('model.diskFree')}:{' '}
                    {state && state.diskFreeBytes > 0 ? formatBytes(state.diskFreeBytes) : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {state && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-caption text-fg-muted hover:text-fg-secondary"
                      onClick={(e) => {
                        e.stopPropagation()
                        openModelsFolder().catch(() => {})
                      }}
                    >
                      <FolderOpen className="h-3 w-3 mr-1" />
                      {t('model.openFolder')}
                    </Button>
                  )}
                  <span className="flex items-center gap-1.5 text-caption text-primary-hover">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {t('model.localOnly')}
                  </span>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---- Dialogs ---- */}
      {dialog?.kind === 'disk-full' && (
        <Dialog open onOpenChange={() => setDialog(null)}>
          <DialogContent className="max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning-soft" />
                {t('model.diskFull_title')}
              </DialogTitle>
              <DialogDescription>
                {t('model.diskFull', {
                  required: formatBytes(dialog.required),
                  available: formatBytes(dialog.available)
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {t('common:action.close')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {dialog?.kind === 'install-confirm' && (
        <Dialog open onOpenChange={() => setDialog(null)}>
          <DialogContent className="max-w-[460px]">
            <DialogHeader>
              <DialogTitle>{t('model.install_confirm_title')}</DialogTitle>
              <DialogDescription>
                {t('model.install_confirm_body', {
                  model: dialog.model.displayName,
                  size: formatBytes(dialog.model.expectedSizeBytes)
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg bg-surface-1/60 border border-line px-3 py-2.5 space-y-1.5">
              <InstallInfoRow
                label={t('model.install_info_developer')}
                value={t('model.install_developer_value')}
              />
              <InstallInfoRow
                label={t('model.install_info_license')}
                value={t('model.install_license_value')}
              />
              <InstallInfoRow
                label={t('model.install_info_source')}
                value={t('model.install_source_value')}
              />
              <InstallInfoRow
                label={t('model.install_info_path')}
                value={state?.modelsDir ?? '—'}
                mono
              />
              <InstallInfoRow
                label={t('model.install_info_time')}
                value={
                  (MODEL_INSTALL_TIME[i18n.language] ?? MODEL_INSTALL_TIME.en)[
                    dialog.model.id
                  ] ?? '—'
                }
              />
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {t('common:action.cancel')}
              </Button>
              <Button variant="primary" onClick={() => handleConfirmInstall(dialog.model)}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                {t('model.install_confirm_ok')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {dialog?.kind === 'uninstall-confirm' && (
        <Dialog open onOpenChange={() => setDialog(null)}>
          <DialogContent className="max-w-[400px]">
            <DialogHeader>
              <DialogTitle>{t('model.uninstall_confirm_title')}</DialogTitle>
              <DialogDescription>
                {t('model.uninstall_confirm_body', {
                  modelName: dialog.model.displayName,
                  size: formatBytes(dialog.model.sizeBytes || dialog.model.expectedSizeBytes)
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDialog(null)}>
                {t('common:action.cancel')}
              </Button>
              <Button
                className="bg-destructive-hover hover:bg-destructive text-white"
                onClick={() => handleConfirmUninstall(dialog.model)}
              >
                {t('model.uninstall_confirm_ok')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// InstallInfoRow
// ---------------------------------------------------------------------------

function InstallInfoRow({
  label,
  value,
  mono
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-3 text-body-sm">
      <span className="text-fg-muted flex-shrink-0">{label}</span>
      <span
        className={cn('text-fg-secondary text-right min-w-0 break-all', mono && 'font-mono text-body-sm')}
        title={mono ? value : undefined}
      >
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ModelCard
// ---------------------------------------------------------------------------

interface ModelCardProps {
  model: ModelInfo
  isDownloading: boolean
  downloadPercent: number
  downloadFile: string
  onInstall: () => void
  onActivate: () => void
  onUninstall: () => void
  onCancelDownload: () => void
  t: ReturnType<typeof useTranslation<'step1'>>['t']
}

function ModelCard({
  model,
  isDownloading,
  downloadPercent,
  downloadFile,
  onInstall,
  onActivate,
  onUninstall,
  onCancelDownload,
  t
}: ModelCardProps) {
  const isActive = model.status === 'active'
  const isInstalled = model.status === 'installed' || isActive

  return (
    <div
      className={cn(
        'rounded-xl border p-4 flex flex-col gap-3 transition-colors duration-150',
        isActive ? 'border-primary bg-primary/5' : 'border-line bg-surface-0'
      )}
    >
      {/* Top: name + status badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-headline font-semibold text-fg-primary leading-tight">
            {model.displayName}
          </p>
          <p className={cn('text-body-sm mt-0.5', isActive ? 'text-primary-hover' : 'text-fg-disabled')}>
            {formatBytes(model.expectedSizeBytes)}
          </p>
        </div>
        {isInstalled && (
          <span
            className={cn(
              'flex-shrink-0 flex items-center gap-1 text-caption font-medium px-2 py-0.5 rounded-full whitespace-nowrap',
              // REQ-071 Phase 3.7-A: green-950 -> zinc-950 on the green
              // active branch — same hue-collision fix.
              isActive ? 'bg-primary text-fg-inverse' : 'bg-row-selected/15 text-info'
            )}
          >
            <Check className="h-2.5 w-2.5" />
            {isActive ? t('model.active') : t('model.installed')}
          </span>
        )}
      </div>

      {/* Description */}
      <p className="text-body-sm text-fg-muted leading-relaxed flex-1">
        {t(DESC_KEY[model.id] ?? 'whisperModel.descMedium')}
      </p>

      {/* Action area */}
      {isDownloading ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-caption text-fg-muted">
            <span className="truncate mr-2">{downloadFile || t('model.downloading')}</span>
            <span className="tabular-nums flex-shrink-0">{downloadPercent}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300 rounded-full"
              style={{ width: `${downloadPercent}%` }}
            />
          </div>
          <Button variant="ghost" size="sm" className="w-full h-7 text-caption" onClick={onCancelDownload}>
            {t('model.cancelDownload')}
          </Button>
        </div>
      ) : model.status === 'not-installed' ? (
        <Button variant="secondary" size="sm" className="w-full" onClick={onInstall}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {t('model.install')}
        </Button>
      ) : isActive ? (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 text-primary-hover cursor-default hover:text-primary-hover hover:bg-transparent"
            disabled
          >
            <Check className="h-3.5 w-3.5 mr-1.5" />
            {t('model.selected')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-fg-disabled hover:text-destructive-soft"
            onClick={onUninstall}
            title={t('model.uninstall_confirm_title')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="flex-1" onClick={onActivate}>
            <Target className="h-3.5 w-3.5 mr-1.5" />
            {t('model.useThis')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-fg-disabled hover:text-destructive-soft"
            onClick={onUninstall}
            title={t('model.uninstall_confirm_title')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

function ModelCardSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-surface-0 p-4 space-y-3 animate-pulse">
      <div className="h-4 w-16 bg-surface-2 rounded" />
      <div className="h-3 w-full bg-surface-2 rounded" />
      <div className="h-8 w-full bg-surface-2 rounded-md" />
    </div>
  )
}
