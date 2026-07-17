import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Zap,
  Cpu,
  Download,
  Trash2,
  Check,
  Target,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { HelpIcon } from '@/components/help-icon'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format'
import {
  getGpuToolState,
  startGpuToolDownload,
  deleteGpuTool,
  selectAccelerator,
  GpuToolDownloadError,
  type GpuToolDownloadRun,
} from '@/services/gpu-tool'
import { GPU_TOOL_RELEASE_TAG, type GpuToolState } from '../../../shared/gpu-tool'
import { useDownloadActiveStore } from '@/stores/download-active-store'

/**
 * REQ-0150 — 2-card accelerator picker replacing the REQ-0149 single-
 * download-button UI.  Sits between `<WhisperModelManager>` and the
 * input-video card in step1 as an independent accordion (does not
 * participate in whisper ↔ input mutual exclusion).
 *
 * Three surface states:
 *
 *   (1) `detection.category === 'nvidia'` — open the accordion to show
 *       both cards.  CPU always selectable; GPU DL button when
 *       tools missing, Delete + Selected when installed.
 *   (2) `detection.category === 'other-only'` — collapsed + disabled,
 *       inline hint `Your GPU (X) is not supported…` (REQ-0150 §2 (2)).
 *   (3) `detection.category === 'none'` — collapsed + disabled, inline
 *       hint `No GPU detected` (REQ-0150 §2 (3)).
 *
 * Mirrors the Whisper model accordion's collapse animation and card
 * treatment (rounded-xl border, `border-primary bg-primary/5` when
 * selected, green Check chip).
 */
/**
 * REQ-0152 §2 — the accordion now participates in step1's single-open
 * exclusion group.  Callers pass `isOpen` + `onOpenChange` to control
 * the open state from a shared parent; when both are omitted the
 * component falls back to internal state (uncontrolled) for callers
 * that predate the mutual-exclusion wiring.  Matches the controlled/
 * uncontrolled hybrid pattern already in `WhisperModelManager`.
 */
export interface GpuToolManagerProps {
  disabled?: boolean
  isOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

export function GpuToolManager({ disabled, isOpen: controlledIsOpen, onOpenChange }: GpuToolManagerProps) {
  const { t } = useTranslation('step1')

  const [state, setState] = useState<GpuToolState | null>(null)
  const [internalIsOpen, setInternalIsOpen] = useState(false)
  const isControlled = controlledIsOpen !== undefined
  const isOpen = isControlled ? controlledIsOpen : internalIsOpen
  function setIsOpen(next: boolean) {
    if (!isControlled) setInternalIsOpen(next)
    onOpenChange?.(next)
  }
  const [downloadPercent, setDownloadPercent] = useState(0)
  const [localDownloading, setLocalDownloading] = useState(false)
  const [isExtracting, setIsExtracting] = useState(false)
  const [dialogKind, setDialogKind] = useState<'install' | 'delete' | null>(null)
  const runRef = useRef<GpuToolDownloadRun | null>(null)

  // REQ-0245 — GPU tool has only one target ever (`cuda-v1`), so a
  // single boolean is fine.  But we OR the local flag with the
  // store-mirrored slot check so the button stays "Downloading" even
  // if this component was mounted mid-DL (e.g. the settings drawer
  // was closed and reopened while cuda-v1.zip was still downloading).
  const isRemoteDownloading = useDownloadActiveStore((s) =>
    s.active.some((a) => a.kind === 'gpu-tool' && a.targetId === GPU_TOOL_RELEASE_TAG),
  )
  const isDownloading = localDownloading || isRemoteDownloading

  async function refresh() {
    setState(await getGpuToolState())
  }

  useEffect(() => {
    refresh().catch(() => {})
  }, [])

  const category = state?.detection.category
  const hasNvidia = category === 'nvidia'
  const isInstalled = state?.installStatus === 'installed'
  const active = state?.activeAccelerator ?? 'cpu'
  const isGpuActive = hasNvidia && isInstalled && active === 'gpu'
  const isCpuActive = !isGpuActive
  const canOpen = hasNvidia
  // REQ-0151 §2 — always paint the green check next to the device name
  // when the NVIDIA branch is live (the accelerator is always CPU or
  // GPU — never null), so fresh installs also read as "CPU ✓" per the
  // REQ-0151 confirmed spec.  The whisper-model-manager pattern shows
  // ✓ only when a model is truly active on disk; the accelerator is
  // subtly different because CPU is always "installed" and is always
  // a valid pick, so a fresh install has an active selection to
  // indicate visually.
  const showSelectedChip = hasNvidia

  function handleHeaderClick() {
    // REQ-0150 §4 hard guard — never open when NVIDIA isn't detected.
    // This defence layer stays even after REQ-0152's move to controlled
    // props, so a parent that (buggily) passes `isOpen={true}` on a
    // non-NVIDIA machine still can't force the body to render (the
    // body itself is also `isOpen && canOpen` gated).
    if (!canOpen || disabled) return
    setIsOpen(!isOpen)
  }

  async function handleConfirmInstall() {
    setDialogKind(null)
    setLocalDownloading(true)
    setDownloadPercent(0)
    setIsExtracting(false)

    const run = startGpuToolDownload((evt) => {
      if (evt.event === 'progress') {
        setIsExtracting(false)
        setDownloadPercent(evt.percent)
      } else if (evt.event === 'extract') {
        setIsExtracting(true)
        setDownloadPercent(evt.percent)
      }
    })
    runRef.current = run

    try {
      await run.promise
      // REQ-0246 — removed the auto-switch-to-GPU that used to fire
      // here (`selectAccelerator('gpu')`).  Rationale matches the
      // Whisper model manager: the "GPU tools were just downloaded,
      // so the user must want to use GPU" heuristic breaks down as
      // soon as concurrent DLs, partial cancels, or re-downloads
      // enter the picture.  The user now picks GPU explicitly via
      // the accelerator card (`handleSelectGpu`) — CPU stays the
      // active accelerator until they do.  Note: the accordion did
      // NOT auto-close in this path even before REQ-0246 (unlike the
      // model side), so nothing to remove for §0.3 here.
      await refresh()
      toast.success(t('gpuTool.download_success'))
    } catch (err) {
      if (err instanceof GpuToolDownloadError) {
        if (err.errorCode === 'aborted') {
          // Cancel UX is on the button — no toast.
        } else if (err.errorCode === 'network') {
          toast.error(t('gpuTool.toast_download_failed_network'))
        } else if (err.errorCode === 'checksum') {
          toast.error(t('gpuTool.toast_download_failed_checksum'))
        } else if (err.errorCode === 'extract') {
          toast.error(t('gpuTool.toast_download_failed_extract'))
        } else {
          toast.error(t('gpuTool.toast_download_failed', { error: err.message }))
        }
      } else {
        toast.error(t('gpuTool.toast_download_failed', { error: String(err) }))
      }
      await refresh()
    } finally {
      setLocalDownloading(false)
      setIsExtracting(false)
      setDownloadPercent(0)
      runRef.current = null
    }
  }

  function handleCancelDownload() {
    runRef.current?.cancel()
  }

  async function handleConfirmDelete() {
    setDialogKind(null)
    const next = await deleteGpuTool()
    if (next) {
      setState(next)
      toast.success(t('gpuTool.delete_success'))
    }
  }

  async function handleSelectCpu() {
    const next = await selectAccelerator('cpu')
    if (next) {
      setState(next)
      toast.success(t('gpuTool.select_cpu_success'))
    }
  }

  async function handleSelectGpu() {
    const next = await selectAccelerator('gpu')
    if (next) {
      setState(next)
      toast.success(t('gpuTool.select_gpu_success'))
    }
  }

  return (
    <div className={cn(disabled && 'opacity-50 pointer-events-none')}>
      {/* Accordion header */}
      <div
        role="button"
        aria-expanded={isOpen && canOpen}
        aria-disabled={!canOpen}
        tabIndex={canOpen ? 0 : -1}
        onClick={handleHeaderClick}
        className={cn(
          'flex items-center gap-2 w-full select-none transition-opacity duration-150',
          canOpen ? 'cursor-pointer hover:opacity-90' : 'cursor-not-allowed opacity-70',
        )}
      >
        <Zap className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
        <span className="text-headline font-semibold text-fg-secondary uppercase tracking-wider">
          {t('gpuTool.label')}
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <HelpIcon content={t('gpuTool.tooltip')} />
        </span>

        <div className="flex-1" />

        {/* Right-aligned cluster: current active label + green check when selected */}
        {state && hasNvidia && (
          <span className="text-body-sm font-mono text-fg-secondary flex-shrink-0">
            {isGpuActive ? t('gpuTool.gpu.name') : t('gpuTool.cpu.name')}
          </span>
        )}
        {showSelectedChip && (
          <Check className="h-4 w-4 text-primary flex-shrink-0" aria-label={t('gpuTool.gpu.activeBadge')} />
        )}
        {canOpen && (
          isOpen ? (
            <ChevronUp className="h-4 w-4 text-fg-muted flex-shrink-0 ml-1" />
          ) : (
            <ChevronDown className="h-4 w-4 text-fg-muted flex-shrink-0 ml-1" />
          )
        )}
      </div>

      {/* Inline hint for non-NVIDIA / no-GPU cases (accordion stays closed). */}
      {state && category === 'other-only' && (
        <p className="mt-1.5 text-body-sm text-fg-muted leading-relaxed pl-6">
          {t('gpuTool.unsupportedGpu', {
            name: state.detection.otherAdapters[0] ?? '?',
          })}
        </p>
      )}
      {state && category === 'none' && (
        <p className="mt-1.5 text-body-sm text-fg-muted leading-relaxed pl-6">
          {t('gpuTool.noGpu')}
        </p>
      )}

      {/* Accordion body — 2 cards side-by-side.  Grid mirrors the
          Whisper model accordion's `grid grid-cols-2 gap-3` + width
          cap so the pair sits centred in the section. */}
      <AnimatePresence initial={false}>
        {isOpen && canOpen && state && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="pt-3">
              <div className="grid grid-cols-2 gap-3 mx-auto max-w-[38rem]">
                <CpuCard
                  isActive={isCpuActive}
                  onSelect={handleSelectCpu}
                  t={t}
                />
                <GpuCard
                  state={state}
                  isActive={isGpuActive}
                  isDownloading={isDownloading}
                  isExtracting={isExtracting}
                  downloadPercent={downloadPercent}
                  onInstall={() => setDialogKind('install')}
                  onSelect={handleSelectGpu}
                  onDelete={() => setDialogKind('delete')}
                  onCancelDownload={handleCancelDownload}
                  t={t}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Install-confirm dialog */}
      {dialogKind === 'install' && state && (
        <Dialog open onOpenChange={() => setDialogKind(null)}>
          <DialogContent
            className="max-w-[460px]"
            onEnterConfirm={handleConfirmInstall}
          >
            <DialogHeader>
              <DialogTitle>{t('gpuTool.install_confirm_title')}</DialogTitle>
              <DialogDescription>
                {t('gpuTool.install_confirm_body', { size: formatBytes(state.expectedSizeBytes) })}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg bg-surface-1/60 border border-line px-3 py-2.5 space-y-1.5">
              <InstallInfoRow
                label={t('gpuTool.install_info_source')}
                value={t('gpuTool.install_source_value')}
              />
              <InstallInfoRow
                label={t('gpuTool.install_info_license')}
                value={t('gpuTool.install_license_value')}
              />
              <InstallInfoRow
                label={t('gpuTool.install_info_path')}
                value={state.dir}
                mono
              />
            </div>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDialogKind(null)}>
                {t('common:action.cancel')}
              </Button>
              <Button variant="primary" onClick={handleConfirmInstall}>
                <Download className="h-3.5 w-3.5 mr-1.5" />
                {t('gpuTool.install_confirm_ok')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Delete-confirm dialog — destructive, no onEnterConfirm per REQ-0139 §3. */}
      {dialogKind === 'delete' && state && (
        <Dialog open onOpenChange={() => setDialogKind(null)}>
          <DialogContent className="max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning-soft" />
                {t('gpuTool.delete_confirm_title')}
              </DialogTitle>
              <DialogDescription>
                {t('gpuTool.delete_confirm_body', { size: formatBytes(state.sizeBytes) })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => setDialogKind(null)}>
                {t('common:action.cancel')}
              </Button>
              <Button
                className="bg-destructive-hover hover:bg-destructive text-white"
                onClick={handleConfirmDelete}
              >
                {t('gpuTool.delete_confirm_ok')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CpuCard
// ---------------------------------------------------------------------------

function CpuCard({
  isActive,
  onSelect,
  t,
}: {
  isActive: boolean
  onSelect: () => void
  t: ReturnType<typeof useTranslation<'step1'>>['t']
}) {
  return (
    <div
      className={cn(
        'rounded-md border p-4 flex flex-col gap-3 transition-colors duration-150',
        isActive ? 'border-primary bg-primary/5' : 'border-line bg-surface-0',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <Cpu className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
          <p className="text-headline font-semibold text-fg-primary leading-tight">
            {t('gpuTool.cpu.name')}
          </p>
        </div>
        {isActive && (
          <span className="flex-shrink-0 flex items-center gap-1 text-caption font-medium px-2 py-0.5 rounded-full whitespace-nowrap bg-primary text-fg-inverse">
            <Check className="h-2.5 w-2.5" />
            {t('gpuTool.cpu.activeBadge')}
          </span>
        )}
      </div>

      <p className="text-body-sm text-fg-muted leading-relaxed flex-1">
        {t('gpuTool.cpu.description')}
      </p>

      {isActive ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-full text-primary-hover cursor-default hover:text-primary-hover hover:bg-transparent"
          disabled
        >
          <Check className="h-3.5 w-3.5 mr-1.5" />
          {t('gpuTool.cpu.activeBadge')}
        </Button>
      ) : (
        <Button variant="secondary" size="sm" className="w-full" onClick={onSelect}>
          <Target className="h-3.5 w-3.5 mr-1.5" />
          {t('gpuTool.selectCpu')}
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// GpuCard
// ---------------------------------------------------------------------------

interface GpuCardProps {
  state: GpuToolState
  isActive: boolean
  isDownloading: boolean
  isExtracting: boolean
  downloadPercent: number
  onInstall: () => void
  onSelect: () => void
  onDelete: () => void
  onCancelDownload: () => void
  t: ReturnType<typeof useTranslation<'step1'>>['t']
}

function GpuCard({
  state,
  isActive,
  isDownloading,
  isExtracting,
  downloadPercent,
  onInstall,
  onSelect,
  onDelete,
  onCancelDownload,
  t,
}: GpuCardProps) {
  const isInstalled = state.installStatus === 'installed'
  const gpuName = state.detection.nvidiaName ?? t('gpuTool.gpu.name')

  return (
    <div
      className={cn(
        'rounded-md border p-4 flex flex-col gap-3 transition-colors duration-150',
        isActive ? 'border-primary bg-primary/5' : 'border-line bg-surface-0',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <Zap className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-headline font-semibold text-fg-primary leading-tight">
              {t('gpuTool.gpu.name')}
            </p>
            <p
              className={cn('text-body-sm mt-0.5 truncate', isActive ? 'text-primary-hover' : 'text-fg-disabled')}
              title={gpuName}
            >
              {gpuName}
            </p>
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
            {isActive ? t('gpuTool.gpu.activeBadge') : t('gpuTool.gpu.readyBadge')}
          </span>
        )}
      </div>

      <p className="text-body-sm text-fg-muted leading-relaxed flex-1">
        {t('gpuTool.gpu.description', { size: formatBytes(state.expectedSizeBytes) })}
      </p>

      {isDownloading ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-caption text-fg-muted">
            <span className="truncate mr-2">
              {isExtracting ? t('gpuTool.extracting') : t('gpuTool.downloading')}
            </span>
            {/* REQ-0221 — hide the percent readout during extract.
                `gpu-tool.ts:extractZipInto` uses PowerShell's
                `ZipFile.ExtractToDirectory` which only surfaces
                start / end, so the caller jumps 0 → 100 across a
                ~10-second sync call.  Showing "0%" during that
                window reads as "stuck" to users; the indeterminate
                stripe below signals "working" without a false
                number. */}
            {!isExtracting && (
              <span className="tabular-nums flex-shrink-0">{downloadPercent}%</span>
            )}
          </div>
          {/* REQ-0221 — same indeterminate treatment the
              transcription drawer uses for its pre-Whisper prep
              region (REQ-0142, `transcription-drawer.tsx:442`):
              a 33 %-wide primary-coloured stripe slides across
              the track on the shared `animate-progress-indeterminate`
              keyframe defined in `tailwind.config.ts`.  Reusing
              the existing token keeps the pace / colour / stripe
              width identical to that surface, so the two places
              a user meets an unknown-duration bar read as the
              same visual grammar. */}
          <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
            {isExtracting ? (
              <div className="h-full w-1/3 bg-primary rounded-full animate-progress-indeterminate" />
            ) : (
              <div
                className="h-full bg-primary transition-all duration-300 rounded-full"
                style={{ width: `${downloadPercent}%` }}
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-7 text-caption"
            onClick={onCancelDownload}
          >
            {t('gpuTool.cancelDownload')}
          </Button>
        </div>
      ) : !isInstalled ? (
        <Button variant="secondary" size="sm" className="w-full" onClick={onInstall}>
          <Download className="h-3.5 w-3.5 mr-1.5" />
          {t('gpuTool.download')}
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
            {t('gpuTool.gpu.activeBadge')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-fg-disabled hover:text-destructive-soft"
            onClick={onDelete}
            title={t('gpuTool.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" className="flex-1" onClick={onSelect}>
            <Target className="h-3.5 w-3.5 mr-1.5" />
            {t('gpuTool.selectGpu')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-fg-disabled hover:text-destructive-soft"
            onClick={onDelete}
            title={t('gpuTool.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  )
}

function InstallInfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 text-body-sm">
      <span className="text-fg-muted flex-shrink-0">{label}</span>
      <span
        className={cn(
          'text-fg-secondary text-right min-w-0 break-all',
          mono && 'font-mono text-body-sm',
        )}
        title={mono ? value : undefined}
      >
        {value}
      </span>
    </div>
  )
}
