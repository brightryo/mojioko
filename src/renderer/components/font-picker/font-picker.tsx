import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2, X, FileText, AlertCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { HelpIcon } from '@/components/help-icon'
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
import {
  listFonts,
  uninstallFont,
  setActiveFont,
  downloadFont
} from '@/services/font'
import type { FontDownloadRun } from '@/services/font'
import { ensureFontLoaded, evictFont } from '@/lib/font-registry'
import { evictSubtitleFont } from '@/lib/font-metrics'
import { useUiStore } from '@/stores/ui-store'
import { FONT_REGISTRY, type FontId, type FontsState, type FontInfo, type FontMeta, getFontMeta } from '../../../shared/fonts'

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
 *     refresh + register the font with FontFace API + auto-select it.
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

  const [state, setState] = useState<FontsState | null>(null)
  const [downloadingId, setDownloadingId] = useState<FontId | null>(null)
  const [downloadPercent, setDownloadPercent] = useState(0)
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
      await ensureFontLoaded(meta.id).catch(() => {})
      toast.success(t('fontPicker.toast.downloadComplete', { name: meta.displayName }))
      // Notify every other useInstalledFontIds subscriber so per-row /
      // bulk pickers immediately include the new font in their popover
      // lists.  REQ-025 (iv).
      bumpFontInventoryVersion()
      // Auto-select the freshly downloaded font so the user does not have
      // to take a second action.  This matches the Subtitle Style dialog's
      // long-standing behaviour and is now the single behaviour for every
      // FontPicker call site (REQ-020).
      const r = await setActiveFont(meta.id)
      if (r.ok) {
        setActiveFontInStore(meta.id)
        onChange?.()
      }
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
    await ensureFontLoaded(meta.id).catch(() => {})
    const r = await setActiveFont(meta.id)
    if (r.ok) {
      setActiveFontInStore(meta.id)
      setState(r.data)
      toast.success(t('fontPicker.toast.activated', { name: meta.displayName }))
      onChange?.()
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1">
        <span className="text-sm font-medium text-foreground">{t('fontPicker.title')}</span>
        <HelpIcon content={t('fontPicker.help')} />
      </div>
      <div className="rounded-md border border-border bg-card divide-y divide-border max-h-[300px] overflow-y-auto">
        {FONT_REGISTRY.map((meta) => {
          const info: FontInfo | undefined = state?.fonts.find((f) => f.id === meta.id)
          const status = info?.status ?? (meta.bundled ? 'bundled' : 'not-installed')
          const isActive = activeFontId === meta.id
          const isDownloading = downloadingId === meta.id
          // Row click activates the font when the font is available
          // (bundled or installed) and not already active.
          const canSelect = (status === 'bundled' || status === 'installed') && !isActive
          // The currently-active font cannot be uninstalled — the picker
          // is the only place to switch active, so allowing uninstall
          // here would orphan the selection.  User must pick another font
          // first.
          const canUninstall = status === 'installed' && !isActive
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
              onSelect={() => handleSelect(meta)}
              onDownload={() => handleDownload(meta)}
              onCancelDownload={handleCancelDownload}
              onUninstall={() => handleUninstall(meta)}
            />
          )
        })}
      </div>

      {/* REQ-025 (ii) confirm dialog — only renders while a uninstall
          target is pending.  Same shape as step3.tsx's overwrite dialog
          so the visual language stays consistent. */}
      <Dialog
        open={pendingUninstall !== null}
        onOpenChange={(o) => { if (!o) cancelPendingUninstall() }}
      >
        <DialogContent className="max-w-[480px]">
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
  onSelect: () => void
  onDownload: () => void
  onCancelDownload: () => void
  onUninstall: () => void
}

function FontRow({
  meta,
  isActive,
  status,
  isDownloading,
  downloadPercent,
  canSelect,
  canUninstall,
  onSelect,
  onDownload,
  onCancelDownload,
  onUninstall
}: FontRowProps) {
  const { t } = useTranslation('step1')

  // Render the displayName in the font's own face when the font is loaded
  // (bundled or installed).  Falls back to the system stack otherwise.
  const labelStyle: React.CSSProperties = (status === 'bundled' || status === 'installed')
    ? { fontFamily: `'${meta.cssFontFamily}'`, fontWeight: meta.weight }
    : {}

  // Whole-row click → select.  Action buttons inside stopPropagation so
  // they don't double-trigger.  Keyboard: Enter / Space mirror the click
  // when the row is focusable (canSelect).
  function handleRowClick() {
    if (canSelect) onSelect()
  }
  function handleRowKey(e: React.KeyboardEvent) {
    if (!canSelect) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect()
    }
  }

  return (
    <div
      role={canSelect ? 'button' : undefined}
      tabIndex={canSelect ? 0 : undefined}
      onClick={canSelect ? handleRowClick : undefined}
      onKeyDown={canSelect ? handleRowKey : undefined}
      aria-pressed={canSelect ? isActive : undefined}
      className={cn(
        'flex items-center justify-between gap-3 px-3 py-2 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/30 focus-visible:ring-inset',
        isActive && 'bg-primary/10',
        canSelect && !isActive && 'cursor-pointer hover:bg-accent/30',
        !canSelect && !isActive && 'cursor-default'
      )}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        {/* Single indicator: gray = inactive, green = active.  Replaces
            the old checkmark + 「選択中」 badge double-up (REQ-019 #3b). */}
        <span
          className={cn(
            'h-2.5 w-2.5 rounded-full shrink-0 transition-colors',
            isActive ? 'bg-primary' : 'bg-zinc-600'
          )}
          aria-hidden="true"
        />
        <span className="text-[14px] text-foreground truncate" style={labelStyle}>
          {meta.displayName}
        </span>
        {/* Rare-kanji-missing note (REQ-022 step 5).  Only renders for
            fonts flagged in the registry (Hachi Maru Pop / Potta One).
            Compact amber pill + hover help so the warning is visible
            without crowding the row. */}
        {meta.lacksRareKanji && (
          <span
            className="inline-flex items-center gap-1 shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300/90 border border-amber-400/30 bg-amber-400/10"
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
            <span className="text-[11px] text-muted-foreground tabular-nums w-9 text-right">
              {downloadPercent}%
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={(e) => { e.stopPropagation(); onCancelDownload() }}
              aria-label={t('fontPicker.action.cancel')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <>
            {/* DL / Trash swap based on install state.  Bundled fonts get
                neither — the absence of both icons is the visual signal
                that a row is read-only-bundled. */}
            {status === 'not-installed' && !meta.bundled && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); onDownload() }}
                aria-label={t('fontPicker.action.download')}
                title={t('fontPicker.action.download')}
              >
                <Download className="h-4 w-4" />
              </Button>
            )}
            {canUninstall && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                onClick={(e) => { e.stopPropagation(); onUninstall() }}
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
