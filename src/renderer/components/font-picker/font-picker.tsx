import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2, X, FileText, AlertCircle, AlertTriangle, Lock, DownloadCloud } from 'lucide-react'
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
import { canSelectFontInTier, canDownloadFontInTier } from '@/lib/font-tier'
import {
  listFonts,
  uninstallFont,
  setActiveFont,
  downloadFont
} from '@/services/font'
import type { FontDownloadRun } from '@/services/font'
import { ensureFontLoaded, evictFont } from '@/lib/font-registry'
import { evictSubtitleFont, loadSubtitleFontFor } from '@/lib/font-metrics'
import { useUiStore } from '@/stores/ui-store'
import { selectBatchDownloadTargets } from '@/lib/batch-font-download'
import { getSortedFontRegistry, type FontId, type FontsState, type FontInfo, type FontMeta, getFontMeta } from '../../../shared/fonts'
import { FontLangBadge, FontLangBadges } from '@/components/font-lang-badge/font-lang-badge'

interface FontPickerProps {
  /** Optional callback fired when a font is downloaded or activated, so the
   *  parent can re-render the preview surfaces tied to the active font. */
  onChange?: () => void
}

/**
 * Subtitle font picker.  One list, one interaction: clicking a row makes
 * that font the active default (dot turns green); the right-side icon
 * (Download / Trash) handles inventory.  Used identically by the Subtitle
 * Style dialog and the Settings ▸ Fonts tab (REQ-020 unified the two).
 *
 * Loading flow:
 *  1. On mount: listFonts() to get install state from main.
 *  2. For installed (or bundled) fonts, ensureFontLoaded() is fired so the
 *     row label can render in the font's own face.
 *  3. Download: downloadFont() streams progress events; on completion we
 *     refresh + register the font with FontFace API.  Active selection
 *     does NOT change — the user must explicitly click the row to
 *     activate the new font (REQ-026).
 *  4. Uninstall: uninstallFont() then evictFont() so the renderer-side
 *     cache drops the now-deleted bytes.
 *  5. Select: setActiveFont() updates AppSettings and useSettingsStore.
 *     activeFontId; SubtitleOverlay + previews react.
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
  // or Lock chip whose font is tier-locked.
  const openUpsell = useStoreUpsellStore((s) => s.openUpsell)

  const [state, setState] = useState<FontsState | null>(null)
  const [downloadingId, setDownloadingId] = useState<FontId | null>(null)
  const [downloadPercent, setDownloadPercent] = useState(0)
  /**
   * REQ-0161 — batch download progress.  Non-null exactly while a
   * `handleBatchDownload` iteration is in flight; used both by the
   * batch button (label swaps to "Cancel") and by every FontRow (all
   * DL / Trash / per-row Cancel-X buttons are greyed out during
   * batch to avoid mid-run interference).  `completed` counts fonts
   * that reached the `promise` resolve — fonts skipped by user cancel
   * do NOT increment it; fonts that failed for network / 404 reasons
   * also do not, so the "downloaded X of N" toast is exact.
   */
  const [batchState, setBatchState] = useState<{
    total: number
    completed: number
    currentId: FontId | null
  } | null>(null)
  /**
   * REQ-0161 — Cancel-batch signal.  Ref (not state) so the loop
   * body can read the freshest value without re-rendering + closure
   * capture.  Reset to false before every fresh batch run.
   */
  const batchAbortRef = useRef(false)
  /**
   * REQ-025 (ii): when the user clicks Uninstall on a font that is
   * currently referenced by one or more rows (`entry.fontId === meta.id`),
   * the actual removal is deferred and a confirmation dialog rendered.
   * Null when no confirmation is pending; otherwise carries the target
   * font + the count of affected rows so the dialog body can show
   * "△行で使用されています".
   */
  const [pendingUninstall, setPendingUninstall] = useState<{
    meta: FontMeta
    affectedRowCount: number
  } | null>(null)
  const downloadRunRef = useRef<FontDownloadRun | null>(null)

  const refresh = useCallback(async () => {
    const r = await listFonts()
    if (r.ok) setState(r.data)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Pre-warm FontFace registration for every already-installed font so the
  // row labels render in their own face on first paint instead of swapping
  // a few hundred ms later.
  useEffect(() => {
    if (!state) return
    for (const f of state.fonts) {
      if (f.status === 'bundled' || f.status === 'installed') {
        ensureFontLoaded(f.id).catch(() => {})
      }
    }
  }, [state])

  async function handleDownload(meta: FontMeta) {
    if (meta.bundled) return
    setDownloadingId(meta.id)
    setDownloadPercent(0)
    const run = downloadFont(meta.id, (evt) => {
      if (evt.event === 'progress') {
        setDownloadPercent(evt.percent)
      }
    })
    downloadRunRef.current = run
    try {
      await run.promise
      await refresh()
      // REQ-0162 — kick BOTH loaders once the bytes are on disk:
      //   - `ensureFontLoaded` registers the FontFace with document.fonts
      //     so CSS `font-family: '<name>'` starts rendering in the new face.
      //   - `loadSubtitleFontFor` parses the TTF via opentype.js and
      //     populates the cmap coverage cache that REQ-0160's tofu
      //     substitution reads.  Without this second call a freshly
      //     downloaded font would render Japanese as system-font
      //     fallback (bug REQ-0162 fixed) until the NEXT app launch
      //     where App.tsx's startup loop finally catches it.
      await Promise.all([
        ensureFontLoaded(meta.id).catch(() => {}),
        loadSubtitleFontFor(meta.id).catch(() => {}),
      ])
      toast.success(t('fontPicker.toast.downloadComplete', { name: meta.displayName }))
      // Notify every other useInstalledFontIds subscriber so per-row /
      // bulk pickers immediately include the new font in their popover
      // lists.  REQ-025 (iv).
      bumpFontInventoryVersion()
      // REQ-026: do NOT auto-select the freshly downloaded font.  A
      // download is "add to inventory"; selection is a separate, explicit
      // user action.  The user perceived "row font changed" too because
      // SubtitleOverlay + RowFontSelector resolve fontId-less rows
      // through activeFontId — auto-flipping activeFontId visually
      // repainted every default-following row in one go.  Keeping
      // activeFontId untouched keeps preview + row dropdown + data
      // aligned with what the user actually chose.
      onChange?.()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('HTTP 404')) {
        toast.error(t('fontPicker.toast.downloadUnavailable', { name: meta.displayName }))
      } else if (!msg.toLowerCase().includes('abort')) {
        toast.error(t('fontPicker.toast.downloadFailed', { error: msg }))
      }
    } finally {
      downloadRunRef.current = null
      setDownloadingId(null)
      setDownloadPercent(0)
    }
  }

  function handleCancelDownload() {
    downloadRunRef.current?.cancel()
    downloadRunRef.current = null
    setDownloadingId(null)
    setDownloadPercent(0)
  }

  /**
   * REQ-0161 — sequentially download every font eligible per
   * `selectBatchDownloadTargets`.  Design choices:
   *
   *  - **Serial, not parallel.**  Font downloads hit the same GitHub
   *    Releases bucket, and the existing individual DL flow already
   *    exercises the main-side singleton write path — starting many
   *    concurrent runs would race on the same install directory and
   *    invite disk / cache corruption for negligible time savings on
   *    a ~5 MB × N payload.
   *  - **`downloadingId` still set per-iteration.**  Reusing the
   *    existing per-row progress bar keeps the visual language
   *    consistent — the row of the current font shows a progress
   *    bar the same way an individual DL does.  Other rows get their
   *    action buttons greyed out via `disableActions` (see below).
   *  - **Cancel via `batchAbortRef`.**  The button label swaps to
   *    "Cancel" during batch.  Clicking it (a) aborts the in-flight
   *    `downloadFont` promise (rejects with an "abort"-substring
   *    message), and (b) sets `batchAbortRef` so the loop stops
   *    before starting the next iteration.  Already-downloaded fonts
   *    stay on disk — the REQ explicitly asks for no rollback.
   *  - **Failure isolation.**  If a single font's download 404s or
   *    fails mid-stream, we continue to the next one.  The tally at
   *    the end distinguishes `completed` / `failed` / `cancelled`
   *    so the toast is accurate.
   */
  async function handleBatchDownload() {
    const targets = selectBatchDownloadTargets(state, isMsix)
    if (targets.length === 0) return

    batchAbortRef.current = false
    setBatchState({ total: targets.length, completed: 0, currentId: null })
    let completed = 0
    let failed = 0

    for (const meta of targets) {
      if (batchAbortRef.current) break

      setBatchState((prev) => (prev ? { ...prev, currentId: meta.id } : prev))
      setDownloadingId(meta.id)
      setDownloadPercent(0)

      const run = downloadFont(meta.id, (evt) => {
        if (evt.event === 'progress') setDownloadPercent(evt.percent)
      })
      downloadRunRef.current = run

      try {
        await run.promise
        // Refresh the font cache eagerly so that if the user is watching
        // the picker while the batch runs, the row visibly flips to
        // "installed" as each font completes.  Errors here are
        // best-effort (the file is on disk regardless).
        //
        // REQ-0162 — same both-loader pattern the individual DL now
        // uses: FontFace (CSS) + opentype.js parse (cmap coverage for
        // tofu substitution).  Without the second loader, batched
        // downloads left the fresh fonts renderable via CSS but
        // invisible to REQ-0160's tofu path, so an EN-only font
        // downloaded via "Download all" would still fall back for
        // Japanese until app restart.
        await Promise.all([
          ensureFontLoaded(meta.id).catch(() => {}),
          loadSubtitleFontFor(meta.id).catch(() => {}),
        ])
        completed++
      } catch (err) {
        // A user cancel and a network / 404 both land in this branch.
        // Only count it as `failed` when we did NOT ask for it.  When
        // `batchAbortRef.current` is true the loop will exit at the
        // next iteration's guard; we still let the finally-block clear
        // per-row progress state so the row doesn't stay stuck at
        // "downloading…" if the user cancelled mid-DL.
        const msg = err instanceof Error ? err.message : String(err)
        if (!batchAbortRef.current && !msg.toLowerCase().includes('abort')) {
          failed++
        }
      } finally {
        downloadRunRef.current = null
      }
      setBatchState((prev) => (prev ? { ...prev, completed } : prev))
    }

    await refresh()
    // Re-notify the font-inventory subscribers once, at the end of the
    // batch — better than N notifications while the batch is running.
    bumpFontInventoryVersion()

    const wasCancelled = batchAbortRef.current
    batchAbortRef.current = false
    setDownloadingId(null)
    setDownloadPercent(0)
    setBatchState(null)

    if (wasCancelled) {
      toast.info(
        t('fontPicker.batchDownload.toast.cancelled', {
          completed,
          total: targets.length,
        }),
      )
    } else if (failed > 0) {
      toast.warning(
        t('fontPicker.batchDownload.toast.partial', {
          completed,
          total: targets.length,
          failed,
        }),
      )
    } else if (completed > 0) {
      toast.success(t('fontPicker.batchDownload.toast.done', { count: completed }))
    }
    onChange?.()
  }

  function handleCancelBatch() {
    // Set the abort ref FIRST so the loop's next-iteration guard sees
    // the truthy value even if the current DL's cancel resolves
    // asynchronously.  The in-flight promise itself is aborted via the
    // shared downloadRun reference used by individual DL as well.
    batchAbortRef.current = true
    downloadRunRef.current?.cancel()
  }

  /**
   * Click handler on the per-row Trash icon.  Counts active rows that
   * reference `meta.id` via `entry.fontId`; if any exist, defers the
   * actual removal to the confirmation dialog (REQ-025 (ii)).  Otherwise
   * proceeds directly to performUninstall().
   */
  function handleUninstall(meta: FontMeta) {
    if (meta.bundled) return
    const entries = useProjectStore.getState().entries
    const affectedRowCount = entries.reduce(
      (n, e) => n + (!e.isDeleted && e.fontId === meta.id ? 1 : 0),
      0
    )
    if (affectedRowCount > 0) {
      setPendingUninstall({ meta, affectedRowCount })
      return
    }
    void performUninstall(meta)
  }

  /**
   * Actual uninstall flow — IPC + cache eviction + REQ-025 (i) row
   * write-back.  Extracted from handleUninstall so the dialog confirm
   * button can call it without re-running the affected-row count.
   *
   * Writes `entry.fontId` AND `entry.original.fontId` back to undefined
   * for every row that referenced the removed font.  Both halves are
   * needed: clearing only the live `fontId` leaves a stale reference
   * inside `original.fontId` that Reset row would later restore (REQ-022
   * step 7 lifts whatever is on original.fontId verbatim).
   *
   * History is intentionally not touched.  An automatic data-repair
   * action triggered by the font disappearing from disk is not something
   * the user should be able to "undo" — the font is gone either way.
   */
  async function performUninstall(meta: FontMeta) {
    const r = await uninstallFont(meta.id)
    if (!r.ok) return

    evictFont(meta.id)
    evictSubtitleFont(meta.id)

    // The main side already falls back to default for active; mirror that
    // in the local store so React reads stay consistent.
    if (activeFontId === meta.id) setActiveFontInStore(r.data.activeFontId)
    setState(r.data)
    toast.success(t('fontPicker.toast.uninstalled', { name: meta.displayName }))

    // REQ-025 (i): write back any rows still referencing the removed font.
    // Reads entries through getState() rather than subscribing because we
    // only need the snapshot at this instant; subsequent edits via React
    // patches are no concern.
    const proj = useProjectStore.getState()
    let affected = 0
    for (const e of proj.entries) {
      if (e.fontId === meta.id || e.original.fontId === meta.id) {
        proj.updateEntry(e.id, {
          fontId: undefined,
          original: { ...e.original, fontId: undefined }
        })
        affected++
      }
    }
    if (affected > 0) {
      toast.info(
        t('fontPicker.toast.uninstalledFallback', {
          name: meta.displayName,
          count: affected
        })
      )
    }

    // Force every useInstalledFontIds subscriber to refetch so popovers
    // open elsewhere stop offering the now-deleted font (REQ-025 (iv)).
    bumpFontInventoryVersion()

    onChange?.()
  }

  function cancelPendingUninstall() {
    setPendingUninstall(null)
  }

  async function confirmPendingUninstall() {
    if (!pendingUninstall) return
    const { meta } = pendingUninstall
    setPendingUninstall(null)
    await performUninstall(meta)
  }

  async function handleSelect(meta: FontMeta) {
    if (meta.id === activeFontId) return
    // Preload before flipping the active selection so the FontFace is ready
    // by the time the preview re-renders.
    // REQ-0162 — parallel-load both the CSS FontFace AND the opentype.js
    // cmap coverage.  Selecting a font that hasn't yet been parsed
    // by opentype.js used to leave REQ-0160's tofu substitution
    // in a "cmap is null → skip" state for the first render (and
    // for burn-in, which without REQ-0162's `services/burnin.ts`
    // await would also see null), producing the same fallback
    // symptom the bug fixes.  Awaiting here guarantees the
    // subsequent activeFontId flip lands in a fully-loaded state.
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

  // REQ-0161 — batch download eligibility.  The button is only rendered
  // in the paid (MSIX) tier because the free build cannot download
  // any non-default font; `selectBatchDownloadTargets` also returns
  // an empty list in the free tier, so the visibility check is safe
  // even if the tier ever gets more granular.
  const batchTargets = selectBatchDownloadTargets(state, isMsix)
  const showBatchButton = isMsix && (batchState !== null || batchTargets.length > 0)
  const isBatchRunning = batchState !== null
  // Individual DL (invoked via a per-row Download button) and batch DL
  // are mutually exclusive: while either is running, the other's UI
  // entry point is greyed out.  We derive both flags from the same
  // state pair so an accidental race can't leave the two disagreeing.
  const isIndividualDownloading = downloadingId !== null && batchState === null
  // During batch, every row's action buttons (DL, Trash, per-row
  // Cancel-X) are disabled — cancellation happens via the batch
  // Cancel button.  During an individual DL, OTHER rows keep their
  // buttons; only the batch button is disabled.  When idle both are
  // fully interactive.
  const perRowActionsDisabled = isBatchRunning

  return (
    <div className="space-y-1.5">
      {/* REQ-0164 §2 — heading reads "デフォルト字幕フォントの選択" /
          "Select default subtitle font".  The pre-REQ-0164 `?`
          HelpIcon + its `fontPicker.help` tooltip (a paragraph
          covering "project-wide default…STEP 2 override…%APPDATA%
          storage path") was removed: the owner flagged the tooltip
          as misleading, and the fresh description `<p>` below the
          header (former `settings:fonts.hint`) now carries the
          guidance the user actually needs.
          REQ-0165 — the "batch download" button that used to share
          this header row moved into the legend row directly above
          the list.  The header is now heading-only so the title
          reads cleanly at 100 % width; the batch action sits closer
          to the list it operates on. */}
      <span className="block text-body font-medium text-foreground">
        {t('fontPicker.title')}
      </span>
      {/* REQ-0164 §2 — description previously lived above the header
          in the settings tab (as `settings:fonts.hint`).  Moved into
          the FontPicker itself and repositioned BELOW the header so
          the visual order matches "title → what to do → mechanics
          (badges → list → warning)".  Owner flagged the pre-REQ-0164
          "hint above heading" order as unnatural in the same session
          that removed the `?` tooltip.  Rendering here (not in the
          settings dialog) also gives the Subtitle Style dialog the
          same guidance for free — that dialog reuses `<FontPicker>`
          and now inherits the description without a separate
          integration point. */}
      <p className="text-body-sm text-muted-foreground leading-relaxed">
        {t('fontPicker.description')}
      </p>
      {/* REQ-0163 §3 / REQ-0165 — EN / JA badge legend + batch DL
          button on the same row.  Rationale for the row placement
          (REQ-0165): the batch action operates on the list directly
          below, so co-locating it with the list's immediate
          predecessor tightens the "what am I about to affect"
          affordance.  The legend uses the same shared
          `<FontLangBadge>` component the list rows use, so a future
          palette change propagates automatically.  Button uses
          `size="sm"` (Button.tsx: `h-6 px-2 text-caption`) so its
          height matches the caption-tone legend to its left — the
          two sides of the row baseline-align without extra
          alignment tweaks. */}
      <div className="flex items-center justify-between gap-x-4 gap-y-1 flex-wrap text-caption text-muted-foreground">
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
        {showBatchButton && (
          <div className="flex items-center gap-2 shrink-0">
            {isBatchRunning && batchState && (
              <span className="text-caption text-muted-foreground tabular-nums">
                {t('fontPicker.batchDownload.progress', {
                  completed: batchState.completed,
                  total: batchState.total,
                })}
              </span>
            )}
            {isBatchRunning ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancelBatch}
                aria-label={t('fontPicker.batchDownload.cancel')}
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {t('fontPicker.batchDownload.cancel')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { void handleBatchDownload() }}
                disabled={isIndividualDownloading || batchTargets.length === 0}
                aria-label={t('fontPicker.batchDownload.button')}
                title={t('fontPicker.batchDownload.buttonTooltip')}
              >
                <DownloadCloud className="h-3.5 w-3.5 mr-1" />
                {t('fontPicker.batchDownload.button')}
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="rounded-md border border-border bg-card divide-y divide-border max-h-[300px] overflow-y-auto">
        {/* REQ-0153 §2 — display in alphabetical order (all fonts, no
            "default first" pin) so the enlarged registry is easy to
            scan.  Selectability / tier-lock policy unchanged. */}
        {getSortedFontRegistry().map((meta) => {
          const info: FontInfo | undefined = state?.fonts.find((f) => f.id === meta.id)
          const status = info?.status ?? (meta.bundled ? 'bundled' : 'not-installed')
          const isActive = activeFontId === meta.id
          const isDownloading = downloadingId === meta.id
          // REQ-088 #4 — NSIS (free) restricts selection / download to
          // the bundled default.  The row still renders, but its
          // download chip is swapped for a Lock icon and clicking the
          // body is inert.  The uninstall chip stays available so a
          // user who downgraded from MSIX (or downloaded a font under
          // an older free build that hadn't tier-gated yet) can still
          // free disk space.
          const tierAllowsSelect = canSelectFontInTier(isMsix, meta.id)
          const tierAllowsDownload = canDownloadFontInTier(isMsix, meta.id)
          // Row click activates the font when the font is available
          // (bundled or installed), not already active, AND the tier
          // permits it.
          const canSelect =
            (status === 'bundled' || status === 'installed') &&
            !isActive &&
            tierAllowsSelect
          // The currently-active font cannot be uninstalled — the picker
          // is the only place to switch active, so allowing uninstall
          // here would orphan the selection.  User must pick another font
          // first.
          const canUninstall = status === 'installed' && !isActive
          // REQ-091 — a row is "tier-locked" when this build's tier
          // forbids both selecting AND downloading it (= free build,
          // non-default font).  Clicks on a tier-locked row OR its
          // Lock chip surface the upsell dialog instead of being
          // inert.  The bundled default and any tier-allowed row
          // stay non-upsell (false).
          const isTierLocked =
            !meta.bundled && !tierAllowsSelect && !tierAllowsDownload
          return (
            <FontRow
              key={meta.id}
              meta={meta}
              isActive={isActive}
              status={status}
              isDownloading={isDownloading}
              downloadPercent={isDownloading ? downloadPercent : 0}
              canSelect={canSelect}
              canUninstall={canUninstall}
              tierAllowsDownload={tierAllowsDownload}
              isTierLocked={isTierLocked}
              // REQ-0161 — grey out DL / Trash / per-row Cancel-X during
              // a batch run.  The batch's own Cancel button in the
              // header owns cancellation while it's active.
              actionsDisabled={perRowActionsDisabled}
              onSelect={() => handleSelect(meta)}
              onDownload={() => handleDownload(meta)}
              onCancelDownload={handleCancelDownload}
              onUninstall={() => handleUninstall(meta)}
              onUpsell={openUpsell}
            />
          )
        })}
      </div>
      {/* REQ-0161 / REQ-0163 §1 — tofu note.  Placed BELOW the list so
          it sits in the peripheral vision without pulling attention
          away from the picker itself.  REQ-0163 §1 promoted the tone
          from muted-foreground to a warning-soft amber pill so the
          missing-glyph consequence lands as a genuine notice, not
          fine print — and pairs a `<AlertTriangle>` (same icon the
          gpu-tool-manager uses for its own warnings) so screen readers
          and glance-scanners both catch the signal.  Amber is now
          reserved for this note: REQ-0163 §2 moved the `ja` badge
          off amber to keep the two channels distinct. */}
      <p className="inline-flex items-start gap-1.5 text-caption text-warning-soft leading-relaxed">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-[1px]" aria-hidden="true" />
        <span>{t('fontPicker.tofuNote')}</span>
      </p>

      {/* REQ-025 (ii) confirm dialog — only renders while a uninstall
          target is pending.  Same shape as step3.tsx's overwrite dialog
          so the visual language stays consistent. */}
      <Dialog
        open={pendingUninstall !== null}
        onOpenChange={(o) => { if (!o) cancelPendingUninstall() }}
      >
        <DialogContent
          className="max-w-[480px]"
          // REQ-0139 §3 — REQ-0138's `onEnterConfirm` was removed
          // because this is a destructive confirmation (removes the
          // font's TTF from disk).  Owner must click.
        >
          <DialogHeader>
            <DialogTitle>
              {t('fontPicker.uninstallConfirm.title', {
                name: pendingUninstall?.meta.displayName ?? ''
              })}
            </DialogTitle>
            <DialogDescription className="whitespace-pre-line">
              {t('fontPicker.uninstallConfirm.body', {
                name: pendingUninstall?.meta.displayName ?? '',
                count: pendingUninstall?.affectedRowCount ?? 0
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="md" onClick={cancelPendingUninstall}>
              {t('fontPicker.uninstallConfirm.cancel')}
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => { void confirmPendingUninstall() }}
            >
              {t('fontPicker.uninstallConfirm.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

interface FontRowProps {
  meta: FontMeta
  isActive: boolean
  status: 'bundled' | 'installed' | 'not-installed' | 'unavailable' | 'downloading'
  isDownloading: boolean
  downloadPercent: number
  canSelect: boolean
  canUninstall: boolean
  /**
   * REQ-088 #4 — when false (= NSIS free build, non-default font), the
   * download chip is replaced by a non-interactive Lock icon so the
   * paywall is visible without obscuring the row.  Default font and
   * MSIX paid build leave this true.
   */
  tierAllowsDownload: boolean
  /**
   * REQ-091 — true when the row is locked behind the paid tier.  Both
   * the row body and the Lock chip become click targets that surface
   * the upsell dialog instead of being inert.
   */
  isTierLocked: boolean
  /**
   * REQ-0161 — true while a batch download is running.  Greys out and
   * disables the per-row Download / Uninstall / Cancel-X buttons so
   * the user can't create a nested individual DL / uninstall race
   * mid-batch.  The row's progress bar (when this row is the
   * currently in-flight batch target) still renders — only the
   * action buttons are gated.  Row-click selection is intentionally
   * kept enabled so the user can still switch the active font while
   * the batch runs (matches the "grey out DL only" scoping in the
   * REQ).
   */
  actionsDisabled: boolean
  onSelect: () => void
  onDownload: () => void
  onCancelDownload: () => void
  onUninstall: () => void
  onUpsell: () => void
}

function FontRow({
  meta,
  isActive,
  status,
  isDownloading,
  downloadPercent,
  canSelect,
  canUninstall,
  tierAllowsDownload,
  isTierLocked,
  actionsDisabled,
  onSelect,
  onDownload,
  onCancelDownload,
  onUninstall,
  onUpsell
}: FontRowProps) {
  const { t } = useTranslation('step1')

  // Render the displayName in the font's own face when the font is loaded
  // (bundled or installed).  Falls back to the system stack otherwise.
  const labelStyle: React.CSSProperties = (status === 'bundled' || status === 'installed')
    ? { fontFamily: `'${meta.cssFontFamily}'`, fontWeight: meta.weight }
    : {}

  // Whole-row click — REQ-091 routes tier-locked rows to the upsell
  // dialog instead of being inert.  Precedence: real-select wins over
  // upsell so an active row never accidentally fires the upsell, and
  // bundled / already-active / tier-allowed-but-uninstalled rows
  // remain non-interactive (no falsey trigger).
  function handleRowClick() {
    if (canSelect) onSelect()
    else if (isTierLocked) onUpsell()
  }
  const isRowInteractive = canSelect || isTierLocked

  return (
    <div
      role={isRowInteractive ? 'button' : undefined}
      tabIndex={isRowInteractive ? 0 : undefined}
      onClick={isRowInteractive ? handleRowClick : undefined}
      aria-pressed={canSelect ? isActive : undefined}
      className={cn(
        'flex items-center justify-between gap-3 px-3 py-2 transition-colors',
        'focus:outline-none focus-visible:outline-none',
        isActive && 'bg-primary/10',
        canSelect && !isActive && 'cursor-pointer hover:bg-accent/30',
        // REQ-091 — tier-locked rows get the same hover affordance so
        // the upsell trigger is discoverable, but no aria-pressed
        // semantic (they aren't toggle buttons, they're a marketing
        // prompt).
        isTierLocked && !isActive && 'cursor-pointer hover:bg-accent/30',
        !isRowInteractive && !isActive && 'cursor-default'
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {/* Single indicator: gray = inactive, green = active.  Replaces
            the old checkmark + 「選択中」 badge double-up (REQ-019 #3b). */}
        <span
          className={cn(
            'h-2.5 w-2.5 rounded-full shrink-0 transition-colors',
            isActive ? 'bg-primary' : 'bg-surface-4'
          )}
          aria-hidden="true"
        />
        <span className="text-body text-foreground truncate" style={labelStyle}>
          {meta.displayName}
        </span>
        <FontLangBadges languages={meta.languages} />
        {/* Rare-kanji-missing note (REQ-022 step 5).  Only renders for
            fonts flagged in the registry (Hachi Maru Pop / Potta One).
            Compact amber pill + hover help so the warning is visible
            without crowding the row. */}
        {meta.lacksRareKanji && (
          <span
            className="inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-caption uppercase tracking-wide text-warning-faint/90 border border-warning-soft/30 bg-warning-soft/10"
            title={t('fontPicker.note.missingRareKanjiHelp')}
          >
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            {t('fontPicker.note.missingRareKanji')}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {isDownloading ? (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-24 rounded-full bg-border overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.min(100, downloadPercent)}%` }}
              />
            </div>
            <span className="text-caption text-muted-foreground tabular-nums w-9 text-right">
              {downloadPercent}%
            </span>
            {/* REQ-0161 — the per-row Cancel-X is hidden while the batch
                DL owns the run (`actionsDisabled` is true then).  During
                a batch, cancel goes through the batch's own Cancel
                button in the header so the two surfaces don't disagree
                about which layer of the run is being aborted. */}
            {!actionsDisabled && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={(e) => { e.stopPropagation(); onCancelDownload() }}
                aria-label={t('fontPicker.action.cancel')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ) : (
          <>
            {/* DL / Trash swap based on install state.  Bundled fonts get
                neither — the absence of both icons is the visual signal
                that a row is read-only-bundled.
                REQ-088 #4 — in the free (NSIS) tier the Download chip is
                replaced by an inert Lock chip to signal that adding fonts
                is a paid-version feature.  Tooltip carries the exact
                wording the user sees in the tab's hint copy so the two
                surfaces tell the same story. */}
            {status === 'not-installed' && !meta.bundled && tierAllowsDownload && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); onDownload() }}
                disabled={actionsDisabled}
                aria-label={t('fontPicker.action.download')}
                title={t('fontPicker.action.download')}
              >
                <Download className="h-4 w-4" />
              </Button>
            )}
            {status === 'not-installed' && !meta.bundled && !tierAllowsDownload && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onUpsell() }}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent/40 transition-colors focus:outline-none focus-visible:outline-none"
                aria-label={t('fontPicker.action.lockedPaidOnly')}
                title={t('fontPicker.action.lockedPaidOnly')}
              >
                <Lock className="h-3.5 w-3.5" />
              </button>
            )}
            {/* REQ-088 #4 — edge case: the user is on the free tier but
                somehow has a non-default font already installed (e.g.
                downgraded from MSIX, or downloaded under an older free
                build).  Mark the row locked so the click-doesn't-
                activate behaviour is visible, while leaving the Trash
                chip available so they can reclaim disk space.
                REQ-091 — same Lock chip click → upsell as the
                not-installed branch above. */}
            {status === 'installed' && !meta.bundled && !canSelect && !isActive && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onUpsell() }}
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent/40 transition-colors focus:outline-none focus-visible:outline-none"
                aria-label={t('fontPicker.action.lockedPaidOnly')}
                title={t('fontPicker.action.lockedPaidOnly')}
              >
                <Lock className="h-3.5 w-3.5" />
              </button>
            )}
            {canUninstall && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); onUninstall() }}
                disabled={actionsDisabled}
                aria-label={t('fontPicker.action.uninstall')}
                title={t('fontPicker.action.uninstall')}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
            {(status === 'installed' || meta.bundled) && (
              <button
                type="button"
                className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                title={t('fontPicker.action.viewLicense')}
                aria-label={t('fontPicker.action.viewLicense')}
                onClick={(e) => { e.stopPropagation(); useUiStore.getState().setFontLicensesDialogOpen(true) }}
              >
                <FileText className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// Re-export getFontMeta for callers that want to read meta inline alongside
// the picker.  Avoids forcing them to add an import from a deep path.
export { getFontMeta }
