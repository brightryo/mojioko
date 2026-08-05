import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AccordionCollapse } from '@/components/ui/accordion-collapse'
import {
  ManagedModelCard,
  ManagedModelCardSkeleton,
  ManagedModelDiskFooter,
} from '@/components/ui/managed-model-card'
import {
  Sparkles,
  Download,
  Check,
  Circle,
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
import { useSettingsStore } from '@/stores/settings-store'
import {
  useDownloadActiveStore,
  selectActiveKeys,
} from '@/stores/download-active-store'
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
  // REQ-0245 — per-model progress + run maps.  Was single-value
  // `downloadingId` / `downloadPercent` / `downloadFile` / `downloadRunRef`
  // which broke under REQ-0244's parallel semantics: starting turbo
  // while large-v3 was downloading overwrote each value → large-v3's
  // `isDownloading={downloadingId === model.id}` flipped false → its
  // row reverted to a "Download" button while main still held the
  // slot → a re-click hit `DOWNLOAD_BUSY`.  Per-model Maps + a store
  // selector for `isDownloading` keep every row honest even with
  // several DLs running.
  const [progress, setProgress] = useState<Map<WhisperModelId, { percent: number; file: string }>>(
    () => new Map(),
  )
  const runsRef = useRef<Map<WhisperModelId, DownloadRun>>(new Map())
  // Optimistic pending set: covers the ~ms window between the user
  // clicking Install and main's `acquire()` broadcast reaching us.
  // Cleared as soon as the store confirms (or the promise settles).
  const [pendingIds, setPendingIds] = useState<Set<WhisperModelId>>(() => new Set())
  const [dialog, setDialog] = useState<DialogKind | null>(null)

  // Store-derived active set — reflects main's slot map, immune to
  // local state clobbering from a second concurrent DL.
  const activeArray = useDownloadActiveStore((s) => s.active)
  const activeModelKeys = useMemo(
    () => selectActiveKeys(activeArray, 'model'),
    [activeArray],
  )

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
    // REQ-0245 — per-model progress + optimistic pending flag.
    // Immutable Map/Set updates so React sees a new reference and
    // re-renders every row that reads them.
    setProgress((prev) => {
      const next = new Map(prev)
      next.set(model.id, { percent: 0, file: '' })
      return next
    })
    setPendingIds((prev) => {
      const next = new Set(prev)
      next.add(model.id)
      return next
    })

    const run = downloadModel(model.id, (evt) => {
      if (evt.event === 'progress') {
        setProgress((prev) => {
          const next = new Map(prev)
          next.set(model.id, { percent: evt.percent, file: evt.file })
          return next
        })
      }
    })
    runsRef.current.set(model.id, run)

    try {
      await run.promise
      // REQ-0246 — removed auto-select-if-none + accordion auto-close.
      // Under REQ-0245's parallel semantics the "which just-finished
      // DL should win the auto-select?" question spawns edge cases
      // (concurrent DLs completing in different orders, one being
      // uninstalled mid-flight, etc.) that add complexity and hide
      // bugs.  Owner directive: user always selects explicitly via
      // the "Use this" button.  This applies to first-time downloads
      // too — a fresh install leaves the model DL'd but not active
      // until the user picks it.
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
      runsRef.current.delete(model.id)
      // REQ-0245 — clean up ONLY this model's entries, not the whole
      // state map.  Under the old single-value design, a second DL
      // completing would clobber the first's state; here each key
      // manages its own lifecycle.
      setProgress((prev) => {
        if (!prev.has(model.id)) return prev
        const next = new Map(prev)
        next.delete(model.id)
        return next
      })
      setPendingIds((prev) => {
        if (!prev.has(model.id)) return prev
        const next = new Set(prev)
        next.delete(model.id)
        return next
      })
    }
  }

  function handleCancelDownload(modelId: WhisperModelId) {
    // REQ-0245 — cancel the specific model's run, not "whatever ref
    // currently points at" (the old single-ref design would target
    // whichever DL started last).  Local state cleanup happens in
    // the awaiting promise's `finally` block; nothing to clear here.
    runsRef.current.get(modelId)?.cancel()
  }

  /**
   * REQ-0315 §3 — mirror main's write of `transcriptionDefaults.whisperModel`
   * back into the renderer store.
   *
   * `transcription.ts` (`setActiveModel` / `uninstallModel`) writes BOTH
   * `activeModelId` and `transcriptionDefaults.whisperModel` to settings.json.
   * Nothing used to write `whisperModel` back into the Zustand store, so it
   * stayed at its boot-hydrated value; App.tsx's debounced save then sent that
   * stale `transcriptionDefaults` object and — because the field merges as
   * `incoming-wins` at whole-object granularity — reverted the on-disk value.
   *
   * That was NOT a race (RES-0314 §3): no timing was required, any later
   * settings change at all reproduced it, and the value stayed reverted until
   * the next restart.  Making the store the truth is the smallest fix that
   * removes the cause rather than compensating for it in the merge.
   *
   * `activeModelId` needs no equivalent — the renderer sends `null` for it and
   * the merge rule is `incoming-else-existing`, so main's value already
   * survives.
   */
  function syncWhisperModelToStore(activeModelId: WhisperModelId | null): void {
    if (!activeModelId) return
    useSettingsStore.getState().updateTranscriptionDefaults({ whisperModel: activeModelId })
  }

  // --- Activate ---

  async function handleActivate(model: ModelInfo) {
    const result = await setActiveModel(model.id)
    if (result.ok) {
      setState(result.data)
      syncWhisperModelToStore(result.data.activeModelId)
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
      syncWhisperModelToStore(result.data.activeModelId)
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
        <span className="text-body font-semibold text-fg-secondary uppercase tracking-wider">
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
      <AccordionCollapse open={isOpen}>
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
                  ? state.models.map((model) => {
                      // REQ-0408 — the card is now the shared presentational
                      // `ManagedModelCard`; map the Whisper model status onto its
                      // three-state prop.  Behaviour is unchanged.
                      const cardState =
                        model.status === 'active'
                          ? 'active'
                          : model.status === 'installed'
                            ? 'downloaded'
                            : 'not-downloaded'
                      return (
                        <ManagedModelCard
                          key={model.id}
                          title={model.displayName}
                          sizeLabel={formatBytes(model.expectedSizeBytes)}
                          description={t(DESC_KEY[model.id] ?? 'whisperModel.descMedium')}
                          state={cardState}
                          recommended={model.id === 'large-v3'}
                          // REQ-0245 — derive isDownloading from the store-mirrored
                          // slot map (or optimistic pending), NOT a shared local id.
                          isDownloading={activeModelKeys.has(model.id) || pendingIds.has(model.id)}
                          downloadPercent={progress.get(model.id)?.percent ?? 0}
                          downloadFile={progress.get(model.id)?.file ?? ''}
                          onDownload={() => handleInstallClick(model)}
                          onSelect={() => handleActivate(model)}
                          onDelete={() => handleUninstallClick(model)}
                          onCancel={() => handleCancelDownload(model.id)}
                          labels={{
                            download: t('model.install'),
                            downloading: t('model.downloading'),
                            cancel: t('model.cancelDownload'),
                            useThis: t('model.useThis'),
                            selected: t('model.selected'),
                            installedBadge: t('model.installed'),
                            activeBadge: t('model.active'),
                            recommended: t('whisperModel.recommended'),
                            deleteTitle: t('model.uninstall_confirm_title'),
                          }}
                        />
                      )
                    })
                  : [0, 1].map((i) => <ManagedModelCardSkeleton key={i} />)}
              </div>

              {/* REQ-20260615-065 S-5 — standing note explaining that
                  the model line-up can shift between releases.  Lives
                  inside the accordion so it appears next to the
                  picker without using up vertical space in the
                  collapsed header. */}
              <p className="text-caption text-fg-muted leading-relaxed text-center">
                {t('whisperModel.updateNote')}
              </p>

              {/* Bottom status bar.

                  REQ-0206 — the row previously stretched full-width and
                  read like a section heading, which encouraged users to
                  click the "Open folder" button on the right without
                  reading the disk-usage labels on the left.  Cap the
                  width to the SAME `max-w-[38rem]` the model-grid
                  container above uses (L373), and centre with
                  `mx-auto`, so the row's left / right edges land under
                  the outermost card edges.

                  Card-count independence: the 38rem cap is a fixed
                  literal, not a computation over `state.models.length`.
                  Changing `grid-cols-2` to `grid-cols-3` or back only
                  affects the interior column count -- the outer width
                  stays 38rem in both the grid and this row.  Under 1
                  card the grid keeps its 38rem width (card occupies
                  one column of two) and this row keeps 38rem too.  See
                  RES-0206 §2 for the full rationale. */}
              <ManagedModelDiskFooter
                totalUsedBytes={state ? state.totalUsedBytes : null}
                diskDrive={state?.diskDrive ?? 'C:\\'}
                diskFreeBytes={state?.diskFreeBytes ?? 0}
                diskWarnColor={diskWarnColor}
                onOpenFolder={() => { openModelsFolder().catch(() => {}) }}
                labels={{
                  totalUsed: t('model.totalUsed'),
                  diskFree: t('model.diskFree'),
                  openFolder: t('model.openFolder'),
                }}
              />
            </div>
      </AccordionCollapse>

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

