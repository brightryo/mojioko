import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sparkles,
  Download,
  Trash2,
  Check,
  Circle,
  Target,
  Database,
  HardDrive,
  FolderOpen,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
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
import { DownloadFailedError, type DownloadRun } from '@/services/transcription'
import type { ModelInfo, ModelsState, WhisperModelId } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// REQ-20260615-065 S-5 — display strings keyed by the v1.3.0 ship
// model IDs only.  Pre-1.3 IDs (`small` / `medium`) cannot reach
// here because the settings hydrate pass migrates them to
// `large-v3-turbo` before the renderer ever sees the model list.
const MODEL_INSTALL_TIME: Record<string, Record<string, string>> = {
  ja: { 'large-v3-turbo': '約5〜30分', 'large-v3': '約10〜60分' },
  en: { 'large-v3-turbo': '~5–30 min', 'large-v3': '~10–60 min' }
}

const DESC_KEY: Record<string, string> = {
  'large-v3-turbo': 'whisperModel.descLargeV3Turbo',
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
  // REQ-20260615-055 — `onOpenAdvanced` prop retired.  Whisper Advanced
  // moved out of an inline gear-icon dialog and into the new
  // TranscriptionDrawer (step1 route), so this component no longer
  // surfaces the trigger.
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
    } else {
      // REQ-20260615-072 — fire the callback with `null` so STEP1 can
      // still make its initial-open decision (treat unknown state as
      // "no model installed" → open the Whisper accordion, which is
      // the correct action anyway when something is wrong with the
      // model registry).  Pre-REQ-072 we silently dropped the failure
      // and the parent never heard back, leaving STEP1's mutual-
      // exclusion accordion in its null-pending state and both panels
      // collapsed.
      onActiveModelChange?.(null)
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
      // REQ-20260615-081 — pick the localized toast off the typed
      // error code carried on `DownloadFailedError`.  `aborted` =
      // user cancelled → no toast (info-level cancel UX lives on the
      // Cancel button itself).  `network` = transient connectivity
      // failure → "ネットワークが切れた…接続を確認して再試行" so the
      // user knows the cause is recoverable.  Pre-REQ-081 every
      // failure produced "Error: TypeError: terminated" verbatim.
      if (err instanceof DownloadFailedError) {
        if (err.errorCode === 'aborted') {
          // No toast — Cancel UX is owned by the button.
        } else if (err.errorCode === 'network') {
          toast.error(t('toast.modelDownloadFailedNetwork'))
        } else {
          toast.error(t('toast.modelDownloadFailed', { error: err.message }))
        }
      } else {
        // Older shapes (no typed code, plain Error) — preserve the
        // pre-REQ-081 behaviour: filter the "Cancelled" string and
        // toast the rest generically.
        const msg = String(err)
        if (!msg.includes('Cancelled')) {
          toast.error(t('toast.modelDownloadFailed', { error: msg }))
        }
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

        {/* REQ-20260615-055 — gear-icon trigger retired here.
            Advanced settings now live inside the TranscriptionDrawer
            opened from the footer Start button. */}

        {/*
          REQ-0181 — symmetric marker.  Pre-0181 the header only rendered
          the green Check when a model was active; the "not yet ready"
          state was silent, so the user had no per-section signal of what
          was blocking the transcribe start.  Now we render a neutral
          Circle in the unmet case so all three step1 sections (Whisper /
          GPU / Input Video) carry a symmetric ✓ / ○ indicator.  The
          tooltip / toast on the disabled Start button carries the
          textual reason (REQ-0181 Shape C).
        */}
        {isModelReady ? (
          <Check className="h-4 w-4 text-primary flex-shrink-0" aria-label={t('model.active')} />
        ) : (
          <Circle className="h-3.5 w-3.5 text-fg-tertiary flex-shrink-0" aria-label={t('guard.pending')} />
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

              {/* REQ-20260615-065 S-5 — grid collapses from 3 columns
                  to 2 (turbo + large-v3 only).  Width cap pulled in
                  proportionally so each card stays ~296 px wide
                  matching the pre-S-5 visible size; `mx-auto` keeps
                  the pair centred within the section card. */}
              <div className="grid grid-cols-2 gap-3 mx-auto max-w-[38rem]">
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
                  : [0, 1].map((i) => <ModelCardSkeleton key={i} />)}
              </div>

              {/* REQ-20260615-065 S-5 — standing note explaining that
                  the model line-up can shift between releases.  Lives
                  inside the accordion so it appears next to the
                  picker without using up vertical space in the
                  collapsed header. */}
              <p className="text-caption text-fg-muted leading-relaxed text-center">
                {t('whisperModel.updateNote')}
              </p>

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
                  {/* REQ-20260615-079 — the "ローカルのみ・通信なし"
                      badge was retired here.  It contradicted itself
                      during model downloads (we ARE talking to HF in
                      that moment) and the footer privacyNote in
                      step1.tsx covers the local-only commitment for
                      the whole route. */}
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
          <DialogContent
            className="max-w-[460px]"
            // REQ-0138 §2.1 — Enter starts the install.
            onEnterConfirm={() => handleConfirmInstall(dialog.model)}
          >
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
          <DialogContent
            className="max-w-[400px]"
            // REQ-0139 §3 — REQ-0138's `onEnterConfirm` was removed
            // because this is a destructive confirmation (removes
            // multi-GB Whisper model from disk).  Owner must click.
          >
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
        // REQ-0182 chrome — dropped rounded-xl to rounded-md so the
        // model picker cards read as consistent-density chrome with
        // the tighter tokens introduced in REQ-0177 Phase A (radius
        // scale halved).  The active-state subtle green tint is
        // preserved (this is a picker choice, not a drawer selection
        // — cf. the REQ-0182 drawer commit for the "border only" case).
        'rounded-md border p-4 flex flex-col gap-3 transition-colors duration-150',
        isActive ? 'border-primary bg-primary/5' : 'border-line bg-surface-0'
      )}
    >
      {/* Top: name + status badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-headline font-semibold text-fg-primary leading-tight">
            {model.displayName}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className={cn('text-body-sm', isActive ? 'text-primary-hover' : 'text-fg-disabled')}>
              {formatBytes(model.expectedSizeBytes)}
            </p>
            {/* REQ-20260615-066 — "Recommended" / "推奨" chip moves
                from turbo to large-v3.  Real-world Japanese
                transcriptions on turbo had more spurious errors
                than the synthetic Phase-0 benchmark suggested, so
                the user-facing recommendation lands on large-v3.
                turbo stays available as a fast-path option but
                without the badge.  Same placement as before (next
                to the size readout, out of the Active / Installed
                badge corner). */}
            {model.id === 'large-v3' && (
              <span className="flex-shrink-0 inline-flex items-center text-caption font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary-hover whitespace-nowrap">
                {t('whisperModel.recommended')}
              </span>
            )}
          </div>
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
