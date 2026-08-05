import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, FileText, AlertTriangle, Lock, DownloadCloud, Trash2 } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useAppEnvStore } from '@/stores/app-env-store'
import { useStoreUpsellStore } from '@/stores/store-upsell-store'
import { canDownloadFontInTier, isFamilyTierLocked } from '@/lib/font-tier'
import {
  listFonts,
  setActiveFont,
  downloadFont,
  recordFontSetVersion,
  uninstallAllFonts,
} from '@/services/font'
import type { FontDownloadRun } from '@/services/font'
import { ensureFontLoaded, evictFont } from '@/lib/font-registry'
import { evictSubtitleFont, loadSubtitleFontFor } from '@/lib/font-metrics'
import { useUiStore } from '@/stores/ui-store'
import {
  FONT_SET_VERSION,
  FONT_REGISTRY,
  getFontFamilies,
  getFontMeta,
  stripFamilyNamespacePrefix,
  deriveFamilyStatus,
  type FontId,
  type FontsState,
  type FontFamily,
  type FamilyStatus,
} from '../../../shared/fonts'
import { FontLangBadge } from '@/components/font-lang-badge/font-lang-badge'
import { FontFamilyBadges } from '@/components/font-lang-badge/font-family-badges'
import { FamilyWeightSelector } from '@/components/subtitle-table/family-weight-selector'

interface FontPickerProps {
  /** Optional callback fired when the active font changes or the set is
   *  installed / uninstalled, so parents can re-render preview surfaces
   *  tied to the active font. */
  onChange?: () => void
}

/**
 * REQ-0281 §2 / §3 / §4 — split into two clearly-labelled sections:
 *
 *   1. "Select default subtitle font"
 *      – short description
 *      – the shared FamilyWeightSelector (family dropdown + weight dropdown)
 *
 *   2. "Font list"
 *      – short description ("Adding and downloading fonts is a paid feature")
 *      – EN / JA badge legend + batch DL button + Uninstall-all button
 *      – family-level list (one row per family; NOT per-weight)
 *      – tofu / upgrade warning notes
 *
 * The list is family-level (REQ-0281 §3) so the visible count matches
 * the marketing claim of "12 additional fonts" (owner-approved: Noto is
 * shown as one family row too, so the list has 13 rows total — 12
 * additional + Noto).  Weight selection lives in the section-1
 * FamilyWeightSelector, the inspector, and the bulk-edit bar.
 *
 * Download flow (REQ-0281 §4):
 *   – Binary set state: `fontSetInstalledVersion === FONT_SET_VERSION`
 *     means "the additional font set is installed"; anything else means
 *     "not installed".  No partial state is exposed.
 *   – One overall progress line during batch DL (no per-family bars).
 *   – Cancel OR failure sweeps every downloaded non-bundled font off
 *     disk via `fontUninstallAll` so the next batch starts from a clean
 *     slate.
 *   – Individual per-row Trash was removed (REQ-0281 §4-5); a single
 *     "Uninstall all additional fonts" button replaces it.  Bundled
 *     Noto weights are never touched by uninstall — they live in the
 *     installer payload.
 */
export function FontPicker({ onChange }: FontPickerProps) {
  const { t } = useTranslation('step1')
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const setActiveFontInStore = useSettingsStore((s) => s.setActiveFontId)
  const bumpFontInventoryVersion = useUiStore((s) => s.bumpFontInventoryVersion)
  // REQ-088 #4 — tier signal.  `null` for the brief pre-IPC window
  // treats the build as the more restrictive NSIS (free) so the user
  // never briefly sees enabled rows that then collapse to disabled.
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false
  // REQ-091 — surface the free-tier upsell when a user clicks a row
  // whose family is tier-locked (paid-tier only).
  const openUpsell = useStoreUpsellStore((s) => s.openUpsell)

  const [state, setState] = useState<FontsState | null>(null)
  /**
   * REQ-0281 §4-1 — batch download progress (single overall).  Non-null
   * exactly while `handleBatchDownload` is running.  The pre-REQ-0281
   * per-font progress Map + per-row progress bar were removed; a
   * single overall progress line + Cancel button live in the section
   * header now.  `completed` counts weights (not families) so the
   * progress bar tracks byte-heavy Noto downloads faithfully, but the
   * user-facing label formats it in a family-agnostic percentage.
   */
  const [batchState, setBatchState] = useState<{
    total: number
    completed: number
  } | null>(null)
  /**
   * REQ-0161 — cancel signal.  Ref (not state) so the batch loop reads
   * the freshest value without closure capture.  Cleared before every
   * fresh batch run.
   */
  const batchAbortRef = useRef(false)
  /** Handle to the current per-weight DL run inside the batch loop. */
  const batchRunRef = useRef<FontDownloadRun | null>(null)
  /**
   * REQ-0281 §4-5 — confirmation dialog for the "Uninstall all
   * additional fonts" button.  Only rendered when at least one row
   * currently references a downloadable weight (project data would
   * lose its explicit font on uninstall).  Shape: `null` when idle,
   * `{ affectedRowCount }` when a confirmation is pending.  We DON'T
   * carry the FontMeta any more because the operation is set-wide.
   */
  const [pendingUninstallAll, setPendingUninstallAll] = useState<{
    affectedRowCount: number
  } | null>(null)

  const refresh = useCallback(async () => {
    const r = await listFonts()
    if (r.ok) setState(r.data)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Pre-warm FontFace registration for every already-installed weight so
  // the FamilyWeightSelector labels render in their own face on first
  // paint instead of swapping a few hundred ms later.
  useEffect(() => {
    if (!state) return
    for (const f of state.fonts) {
      if (f.status === 'bundled' || f.status === 'installed') {
        ensureFontLoaded(f.id).catch(() => {})
      }
    }
  }, [state])

  // REQ-0281 §3 — memoised family view of the registry.  Constant across
  // renders (the registry is static); the useMemo just avoids re-
  // walking on every state change.  `families` is what section 2's list
  // iterates over.
  const families = useMemo(() => getFontFamilies(), [])

  // Fast lookup: "is this fontId reported as `installed` by main?"
  // Derived from FontsState.fonts (which builds from disk + version
  // stamp on the main side).  Used by `deriveFamilyStatus` below AND
  // by the family-level render so a family is treated as installed
  // only when EVERY weight is present AND the version stamp matches.
  const isInstalledOnDisk = useCallback(
    (fontId: FontId) => state?.fonts.find((f) => f.id === fontId)?.status === 'installed',
    [state],
  )
  const setIsCurrent = state?.fontSetInstalledVersion === FONT_SET_VERSION

  // REQ-0281 §4 — precompute the current binary state so both the
  // "Download set" and "Uninstall all" buttons key off the same source
  // of truth.  Bundled Noto is not counted here (it can never be
  // uninstalled and is always installed by definition).
  const nonBundledFamilies = useMemo(
    () => families.filter((f) => !f.hasBundledWeight),
    [families],
  )
  const isSetInstalled = setIsCurrent && nonBundledFamilies.every(
    (fam) => fam.weights.every((w) => isInstalledOnDisk(w.fontId)),
  )

  // REQ-0281 §4-1 — batch download running?
  const isBatchRunning = batchState !== null

  // REQ-0281 §4 — every non-bundled weight IS a batch target every time
  // (no per-weight cherry-picking any more).  In NSIS the free tier
  // has no downloadable weights that pass `canDownloadFontInTier`, so
  // the resulting list is empty and every download-related affordance
  // stays hidden.
  const batchTargets = useMemo(() => {
    return FONT_REGISTRY.filter(
      (meta) => !meta.bundled && canDownloadFontInTier(isMsix, meta.id),
    )
  }, [isMsix])

  /**
   * REQ-0281 §4-1 through §4-3 — download the full additional-font
   * set as one binary operation.  Every non-bundled weight in the
   * registry is fetched (paid tier only, gated by `canDownloadFontInTier`);
   * the `fontSetInstalledVersion` stamp is written to disk on success;
   * any cancel OR failure triggers `uninstallAllFonts()` so the disk
   * is wiped and the state pins back to 0.
   */
  async function handleBatchDownload() {
    if (batchTargets.length === 0) return

    batchAbortRef.current = false
    setBatchState({ total: batchTargets.length, completed: 0 })
    let completed = 0
    let failed = false

    try {
      for (const meta of batchTargets) {
        if (batchAbortRef.current) break

        // REQ-0281 §4-1 — no per-font `setProgress`.  We only track
        // completion count for the overall percentage; per-file byte
        // progress is intentionally discarded to keep the visual
        // simple (one bar for the whole set).
        const run = downloadFont(meta.id, () => { /* no per-file progress */ })
        batchRunRef.current = run

        try {
          await run.promise
          // Register the fresh font with BOTH loaders (FontFace + opentype.js
          // cmap coverage) so preview + burn-in start rendering the new
          // weight immediately, without waiting for the next app launch.
          await Promise.all([
            ensureFontLoaded(meta.id).catch(() => {}),
            loadSubtitleFontFor(meta.id).catch(() => {}),
          ])
          completed++
        } catch (err) {
          // User-cancel and network / 404 both land here.  Only mark
          // `failed` when the abort ref is NOT set (real failure);
          // otherwise the batch is being torn down cleanly.
          const msg = err instanceof Error ? err.message : String(err)
          if (
            !batchAbortRef.current
            && !msg.toLowerCase().includes('abort')
            && !msg.toLowerCase().includes('cancel')
          ) {
            failed = true
            batchAbortRef.current = true  // stop trying subsequent weights
          }
        } finally {
          batchRunRef.current = null
        }

        setBatchState({ total: batchTargets.length, completed })
      }

      const wasCancelled = batchAbortRef.current && !failed
      const wasSuccessful = !batchAbortRef.current && !failed && completed === batchTargets.length

      if (wasSuccessful) {
        // REQ-0275 §3 — write the version stamp only on complete success.
        // A partial batch would leave the set inconsistent, so any other
        // path falls through to the cleanup below.
        try { await recordFontSetVersion() }
        catch { /* best-effort; disk state is still coherent */ }
      } else {
        // REQ-0281 §4-3 — cancel OR failure sweeps every downloaded
        // non-bundled font off disk AND clears `fontSetInstalledVersion`,
        // so the next batch always starts from the clean 0 state.
        // Errors here are logged main-side and non-fatal to this flow.
        try { await uninstallAllFonts() } catch { /* best-effort */ }
        // Also drop the renderer-side caches for every weight so the
        // FamilyWeightSelector's popover stops offering weights whose
        // bytes just vanished.  Iterate the registry (small, static)
        // rather than tracking which specific IDs completed.
        for (const meta of FONT_REGISTRY) {
          if (meta.bundled) continue
          evictFont(meta.id)
          evictSubtitleFont(meta.id)
        }
      }

      await refresh()
      // REQ-025 (iv) — one bump per batch so every useInstalledFontIds
      // subscriber (inspector / bulk-edit / RowFontSelector) picks up
      // the new inventory in a single re-render.
      bumpFontInventoryVersion()

      if (wasCancelled) {
        toast.info(t('fontPicker.batchDownload.toast.cancelled'))
      } else if (failed) {
        toast.warning(t('fontPicker.batchDownload.toast.failed'))
      } else if (wasSuccessful) {
        toast.success(t('fontPicker.batchDownload.toast.done'))
      }
      onChange?.()
    } finally {
      // Guaranteed reset so the section-2 button UI comes back to idle.
      batchAbortRef.current = false
      batchRunRef.current = null
      setBatchState(null)
    }
  }

  function handleCancelBatch() {
    // Set abort ref FIRST so the loop guard sees `true` before the
    // in-flight run's cancel resolves.  The cascade (in-flight promise
    // rejects → catch → finally → guard) then routes into the cleanup
    // path in `handleBatchDownload`'s try-block.
    batchAbortRef.current = true
    batchRunRef.current?.cancel()
  }

  /**
   * REQ-0281 §4-5 — click handler for the "Uninstall all additional
   * fonts" button.  Counts rows in the current project that reference
   * ANY non-bundled font; if any exist, defers the actual sweep to the
   * confirmation dialog.  Otherwise proceeds directly.
   */
  function handleUninstallAllClick() {
    const entries = useProjectStore.getState().entries
    const nonBundledIds = new Set(
      FONT_REGISTRY.filter((m) => !m.bundled).map((m) => m.id),
    )
    const affectedRowCount = entries.reduce(
      (n, e) => n + (!e.isDeleted && e.fontId !== undefined && nonBundledIds.has(e.fontId) ? 1 : 0),
      0,
    )
    if (affectedRowCount > 0) {
      setPendingUninstallAll({ affectedRowCount })
      return
    }
    void performUninstallAll()
  }

  function cancelPendingUninstallAll() {
    setPendingUninstallAll(null)
  }

  async function confirmPendingUninstallAll() {
    setPendingUninstallAll(null)
    await performUninstallAll()
  }

  /**
   * REQ-0281 §4-5 — actual uninstall-all flow.  Sweeps disk via
   * `uninstallAllFonts()`, evicts every renderer-side cache, writes
   * back `fontId: undefined` on every affected row (so a subsequent
   * project save doesn't retain a dangling reference), and toasts a
   * count.
   */
  async function performUninstallAll() {
    const r = await uninstallAllFonts()
    if (!r.ok) {
      toast.error(t('fontPicker.uninstallAll.toast.failed'))
      return
    }

    // Evict every non-bundled weight from both renderer caches.  The
    // main-side handler already fell the active font back to
    // DEFAULT_FONT_ID if it was one of the removed weights; mirror
    // that in the store so React reads stay consistent.
    for (const meta of FONT_REGISTRY) {
      if (meta.bundled) continue
      evictFont(meta.id)
      evictSubtitleFont(meta.id)
    }
    if (r.data.activeFontId !== activeFontId) {
      setActiveFontInStore(r.data.activeFontId)
    }
    setState(r.data)

    // REQ-025 (i) — every project row that pointed at a now-removed
    // weight has its `fontId` (AND `original.fontId`) written back to
    // undefined so a Reset row doesn't restore a dangling reference.
    const nonBundledIds = new Set(
      FONT_REGISTRY.filter((m) => !m.bundled).map((m) => m.id),
    )
    const proj = useProjectStore.getState()
    let affected = 0
    for (const e of proj.entries) {
      const liveNeedsClear = e.fontId !== undefined && nonBundledIds.has(e.fontId)
      const originalNeedsClear = e.original.fontId !== undefined && nonBundledIds.has(e.original.fontId)
      if (liveNeedsClear || originalNeedsClear) {
        proj.updateEntry(e.id, {
          fontId: liveNeedsClear ? undefined : e.fontId,
          original: originalNeedsClear
            ? { ...e.original, fontId: undefined }
            : e.original,
        })
        affected++
      }
    }

    toast.success(
      t('fontPicker.uninstallAll.toast.done', {
        count: r.data.removedIds.length,
        rows: affected,
      }),
    )

    // Broadcast so every useInstalledFontIds subscriber (inspector /
    // bulk-edit / RowFontSelector) refreshes its popover in one pass.
    bumpFontInventoryVersion()
    onChange?.()
  }

  // Section-1 selector uses the family+weight FontId; route it through
  // the same activate path as a direct row click.
  async function handleSelectById(id: FontId) {
    const meta = getFontMeta(id)
    if (meta.id === activeFontId) return
    // REQ-0162 — preload both the CSS FontFace AND the opentype.js
    // cmap coverage so the subsequent activeFontId flip lands in a
    // fully-loaded state (no first-render tofu fallback).
    await Promise.all([
      ensureFontLoaded(meta.id).catch(() => {}),
      loadSubtitleFontFor(meta.id).catch(() => {}),
    ])
    const r = await setActiveFont(meta.id)
    if (r.ok) {
      setActiveFontInStore(meta.id)
      setState(r.data)
      toast.success(t('fontPicker.toast.activated', { name: meta.displayName }))
      onChange?.()
    }
  }

  // REQ-0281 §2 — visibility rules for the download / uninstall-all
  // buttons.  Both are MSIX-only (free tier gets neither), and both
  // are hidden entirely when the picker is used by a build that
  // hasn't reported tier yet (`isMsix === null` in the app-env
  // store, coerced to false at the top so we treat unknown as
  // restrictive).
  const showBatchButton = isMsix && batchTargets.length > 0
  const showUninstallAllButton = isMsix && isSetInstalled

  return (
    <div className="space-y-6">
      {/* ============================================================== */}
      {/* Section 1 — Select default subtitle font (REQ-0281 §2)         */}
      {/* ============================================================== */}
      <section className="space-y-1.5">
        <h3 className="text-body font-medium text-fg-primary">
          {t('fontPicker.title')}
        </h3>
        <p className="text-body-sm text-fg-secondary leading-relaxed">
          {t('fontPicker.section1Description')}
        </p>
        <div className="pt-1">
          <FamilyWeightSelector
            value={activeFontId}
            onChange={(nextId) => { void handleSelectById(nextId) }}
            // REQ-0348 §1 — Settings ▸ Fonts keeps the chips.  This selector
            // sits directly above the family list that explains them, on the
            // screen where fonts are compared rather than picked mid-edit, and
            // the owner kept this screen as it was.  Reached from both the
            // settings dialog and STEP 1's subtitle-style dialog, which render
            // the same `<FontPicker />`.
            showCoverageBadges
          />
        </div>
      </section>

      {/* ============================================================== */}
      {/* Section 2 — Font list (REQ-0281 §2 / §3 / §4)                  */}
      {/* ============================================================== */}
      <section className="space-y-1.5">
        <h3 className="text-body font-medium text-fg-primary">
          {t('fontPicker.listSectionTitle')}
        </h3>
        <p className="text-body-sm text-fg-secondary leading-relaxed">
          {t('fontPicker.listSectionDescription')}
        </p>

        {/* Legend + batch DL + uninstall-all controls */}
        <div className="flex items-center justify-between gap-x-4 gap-y-1 flex-wrap text-caption text-fg-secondary">
          <div className="flex items-center gap-x-4 gap-y-1 flex-wrap">
            <span className="inline-flex items-center gap-1.5">
              <FontLangBadge language="en" />
              <span>… {t('fontPicker.langLegend.en')}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <FontLangBadge language="ja" />
              <span>… {t('fontPicker.langLegend.ja')}</span>
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isBatchRunning && batchState && (
              <span className="text-caption text-fg-secondary tabular-nums">
                {/* REQ-0281 §4-1 — percent, not "N of M", because the
                    binary model treats the set as a single unit; users
                    just want to know how far along the whole download is. */}
                {batchState.total > 0
                  ? `${Math.floor((batchState.completed / batchState.total) * 100)}%`
                  : ''}
              </span>
            )}
            {isBatchRunning && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancelBatch}
                aria-label={t('fontPicker.batchDownload.cancel')}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {t('fontPicker.batchDownload.cancel')}
              </Button>
            )}
            {!isBatchRunning && showUninstallAllButton && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleUninstallAllClick}
                aria-label={t('fontPicker.uninstallAll.button')}
                title={t('fontPicker.uninstallAll.buttonTooltip')}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                {t('fontPicker.uninstallAll.button')}
              </Button>
            )}
            {!isBatchRunning && showBatchButton && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void handleBatchDownload() }}
                aria-label={t('fontPicker.batchDownload.button')}
                title={t('fontPicker.batchDownload.buttonTooltip')}
              >
                <DownloadCloud className="h-3.5 w-3.5 mr-1" />
                {isSetInstalled
                  ? t('fontPicker.batchDownload.buttonReinstall')
                  : t('fontPicker.batchDownload.button')}
              </Button>
            )}
          </div>
        </div>

        {/* Overall progress bar — only during batch DL.  Single unit,
            no per-family segments. */}
        {isBatchRunning && batchState && (
          <div className="h-1.5 w-full rounded-full bg-border overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{
                width: `${batchState.total > 0
                  ? Math.min(100, (batchState.completed / batchState.total) * 100)
                  : 0}%`,
              }}
            />
          </div>
        )}

        {/* Family list — one row per family (REQ-0281 §3) */}
        <div className="rounded-md border border-line bg-surface-1 divide-y divide-border max-h-[300px] overflow-y-auto">
          {families.map((family) => {
            const status = deriveFamilyStatus(family, isInstalledOnDisk, setIsCurrent ?? false)
            // A family is "active" when the currently-selected FontId
            // belongs to any of its weights (family-level indicator).
            const isFamilyActive = family.weights.some((w) => w.fontId === activeFontId)
            // Tier gate: the family is tier-locked (paid-only in free
            // build) when none of its weights are selectable AND none
            // are downloadable in the current tier.  Bundled Noto is
            // never tier-locked.  REQ-0356 lifted this out to
            // `isFamilyTierLocked` so the editing surfaces decide it the
            // same way — when it lived only here, they did not.
            const isTierLocked = isFamilyTierLocked(isMsix, family)
            return (
              <FontFamilyRow
                key={family.cssFontFamily}
                family={family}
                status={status}
                isFamilyActive={isFamilyActive}
                isTierLocked={isTierLocked}
                isBatchRunning={isBatchRunning}
                onUpsell={openUpsell}
                onViewLicense={() => useUiStore.getState().setFontLicensesDialogOpen(true)}
              />
            )
          })}
        </div>

        {/* REQ-0163 §1 — tofu note pinned below the list. */}
        <p className="inline-flex items-start gap-1.5 text-caption text-warning-soft leading-relaxed">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-[1px]" aria-hidden="true" />
          <span>{t('fontPicker.tofuNote')}</span>
        </p>
        {/* REQ-0276 §3 — post-upgrade re-download notice (paid tier only,
            when an older-version stamp is on disk). */}
        {isMsix
          && state?.fontSetInstalledVersion !== undefined
          && state.fontSetInstalledVersion < FONT_SET_VERSION && (
          <p className="inline-flex items-start gap-1.5 text-caption text-warning-soft leading-relaxed">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-[1px]" aria-hidden="true" />
            <span>{t('fontPicker.upgradeNotice')}</span>
          </p>
        )}
      </section>

      {/* REQ-0281 §4-5 — confirmation dialog for "Uninstall all
          additional fonts" when any project row references a
          downloadable weight (so the user knows their per-row font
          choices will be cleared). */}
      <Dialog
        open={pendingUninstallAll !== null}
        onOpenChange={(o) => { if (!o) cancelPendingUninstallAll() }}
      >
        <DialogContent
          className="max-w-[480px]"
          // REQ-0139 §3 — destructive confirmation, no Enter=confirm.
        >
          <DialogHeader>
            <DialogTitle>
              {t('fontPicker.uninstallAll.confirm.title')}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {t('fontPicker.uninstallAll.confirm.body', {
                count: pendingUninstallAll?.affectedRowCount ?? 0,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="md" onClick={cancelPendingUninstallAll}>
              {t('fontPicker.uninstallAll.confirm.cancel')}
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => { void confirmPendingUninstallAll() }}
            >
              {t('fontPicker.uninstallAll.confirm.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * REQ-0281 §3 — single row for a whole font family.  No per-weight
 * rendering, no per-row DL / Trash controls.  Left side: dot indicator
 * (green when the active FontId belongs to any weight in this family),
 * family name (rendered in the family's own face when available),
 * language badges, and rare-kanji note if any weight in the family
 * carries the flag.  Right side: license-view icon (bundled or
 * installed) OR Lock icon (tier-locked) OR nothing (not-installed +
 * paid tier — the batch DL button handles inventory).
 */
interface FontFamilyRowProps {
  family: FontFamily
  status: FamilyStatus
  isFamilyActive: boolean
  isTierLocked: boolean
  isBatchRunning: boolean
  onUpsell: () => void
  onViewLicense: () => void
}

function FontFamilyRow({
  family,
  status,
  isFamilyActive,
  isTierLocked,
  isBatchRunning,
  onUpsell,
  onViewLicense,
}: FontFamilyRowProps) {
  const { t } = useTranslation('step1')

  // Render the family label in its own face when at least one weight
  // is available (bundled or installed).  Weight for the label is the
  // family's default weight so multi-weight families like Noto and
  // Poppins show at a natural body style.
  const canRenderInFamilyFace = status === 'bundled' || status === 'installed'
  const labelStyle: React.CSSProperties = canRenderInFamilyFace
    ? { fontFamily: `'${family.cssFontFamily}'`, fontWeight: 400 }
    : {}

  // Tier-locked rows open the upsell dialog on click; non-tier-locked
  // rows are non-interactive at family-level (weight selection happens
  // via the section-1 FamilyWeightSelector).
  const handleRowClick = isTierLocked ? onUpsell : undefined
  const rowInteractive = handleRowClick !== undefined

  const familyLabel = stripFamilyNamespacePrefix(family.cssFontFamily)

  return (
    <div
      role={rowInteractive ? 'button' : undefined}
      tabIndex={rowInteractive ? 0 : undefined}
      onClick={handleRowClick}
      className={cn(
        'flex items-center justify-between gap-3 px-3 py-2 transition-colors',
        'focus:outline-none focus-visible:outline-none',
        isFamilyActive && 'bg-primary/10',
        rowInteractive && 'cursor-pointer hover:bg-accent/30',
        !rowInteractive && 'cursor-default',
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span
          className={cn(
            'h-2.5 w-2.5 rounded-full shrink-0 transition-colors',
            isFamilyActive ? 'bg-primary' : 'bg-surface-4',
          )}
          aria-hidden="true"
        />
        <span className="text-body text-fg-primary truncate" style={labelStyle}>
          {familyLabel}
        </span>
        {/* REQ-0341 §1 — the chip markup moved into `FontFamilyBadges` so this
            row and `FamilyWeightSelector` cannot drift apart.  Both read the
            same two fields off the same `getFontFamilies()` object. */}
        <FontFamilyBadges languages={family.languages} lacksRareKanji={family.lacksRareKanji} />
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {/* Lock chip for tier-locked families (paid-only in free build). */}
        {isTierLocked && !isBatchRunning && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onUpsell() }}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-fg-secondary/60 hover:text-fg-primary hover:bg-accent/40 transition-colors focus:outline-none focus-visible:outline-none"
            aria-label={t('fontPicker.action.lockedPaidOnly')}
            title={t('fontPicker.action.lockedPaidOnly')}
          >
            <Lock className="h-3.5 w-3.5" />
          </button>
        )}
        {/* License-view icon for bundled / installed families. */}
        {(status === 'bundled' || status === 'installed') && (
          <button
            type="button"
            className="inline-flex items-center justify-center h-7 w-7 rounded-md text-fg-secondary hover:text-fg-primary hover:bg-accent/40 transition-colors"
            title={t('fontPicker.action.viewLicense')}
            aria-label={t('fontPicker.action.viewLicense')}
            onClick={(e) => { e.stopPropagation(); onViewLicense() }}
          >
            <FileText className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

// Re-export getFontMeta for callers that want to read meta inline alongside
// the picker.  Avoids forcing them to add an import from a deep path.
export { getFontMeta }
