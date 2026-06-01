import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, Trash2, Check, X, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { HelpIcon } from '@/components/help-icon'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settings-store'
import {
  listFonts,
  uninstallFont,
  setActiveFont,
  downloadFont
} from '@/services/font'
import type { FontDownloadRun } from '@/services/font'
import { ensureFontLoaded, evictFont } from '@/lib/font-registry'
import { FONT_REGISTRY, type FontId, type FontsState, type FontInfo, type FontMeta, getFontMeta } from '../../../shared/fonts'

interface FontPickerProps {
  /** Optional callback fired when a font is downloaded or activated, so the
   *  parent can re-render the preview surfaces tied to the active font. */
  onChange?: () => void
}

/**
 * Subtitle font picker — surfaces every font in the registry as a one-row
 * card with download / select / uninstall actions.  Mirrors the spirit of
 * WhisperModelManager but stays compact enough to drop into a column of
 * SubtitleStyleDialog without taking over the layout.
 *
 * Loading flow:
 *  1. On mount: listFonts() to get install state from main.
 *  2. For installed (or bundled) fonts, ensureFontLoaded() is fired so the
 *     row label can render in the font's own face.
 *  3. When the user clicks Download: downloadFont() streams progress events;
 *     on completion we refresh state + register the font with FontFace API.
 *  4. When the user clicks Uninstall: uninstallFont() then evictFont() so
 *     the renderer-side cache drops the now-deleted bytes.
 *  5. When the user clicks Select: setActiveFont() updates AppSettings and
 *     useSettingsStore.activeFontId; SubtitleOverlay + previews react.
 */
export function FontPicker({ onChange }: FontPickerProps) {
  const { t } = useTranslation('step1')
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const setActiveFontInStore = useSettingsStore((s) => s.setActiveFontId)

  const [state, setState] = useState<FontsState | null>(null)
  const [downloadingId, setDownloadingId] = useState<FontId | null>(null)
  const [downloadPercent, setDownloadPercent] = useState(0)
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
      // Auto-select the freshly downloaded font.
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

  async function handleUninstall(meta: FontMeta) {
    if (meta.bundled) return
    const r = await uninstallFont(meta.id)
    if (r.ok) {
      evictFont(meta.id)
      // The main side already falls back to default for active; mirror that
      // in the local store so React reads stay consistent.
      if (activeFontId === meta.id) setActiveFontInStore(r.data.activeFontId)
      setState(r.data)
      toast.success(t('fontPicker.toast.uninstalled', { name: meta.displayName }))
      onChange?.()
    }
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
          const canSelect = (status === 'bundled' || status === 'installed') && !isActive
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

  const showActions = !isDownloading

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 px-3 py-2 transition-colors',
        isActive ? 'bg-accent/40' : 'hover:bg-accent/20'
      )}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {isActive ? (
          <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        ) : (
          <span className="h-4 w-4 shrink-0" aria-hidden="true" />
        )}
        <span className="text-[14px] text-foreground truncate" style={labelStyle}>
          {meta.displayName}
        </span>
        <StatusBadge status={status} isActive={isActive} />
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
              onClick={onCancelDownload}
              aria-label={t('fontPicker.action.cancel')}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          showActions && (
            <>
              {status === 'not-installed' && !meta.bundled && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2"
                  onClick={onDownload}
                >
                  <Download className="h-3.5 w-3.5 mr-1" />
                  {t('fontPicker.action.download')}
                </Button>
              )}
              {canSelect && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[12px]"
                  onClick={onSelect}
                >
                  {t('fontPicker.action.select')}
                </Button>
              )}
              {canUninstall && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={onUninstall}
                  aria-label={t('fontPicker.action.uninstall')}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
              {(status === 'installed' || meta.bundled) && (
                <a
                  href={meta.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/40 transition-colors"
                  title={t('fontPicker.action.viewLicense')}
                  onClick={(e) => {
                    e.preventDefault()
                    window.electronAPI?.shellOpenExternal(meta.sourceUrl).catch(() => {})
                  }}
                >
                  <FileText className="h-3.5 w-3.5" />
                </a>
              )}
            </>
          )
        )}
      </div>
    </div>
  )
}

function StatusBadge({ status, isActive }: { status: FontRowProps['status']; isActive: boolean }) {
  const { t } = useTranslation('step1')
  if (isActive) {
    return (
      <span className="text-[10px] uppercase tracking-wide text-primary font-medium px-1.5 py-0.5 rounded bg-primary/10 border border-primary/30">
        {t('fontPicker.status.active')}
      </span>
    )
  }
  if (status === 'bundled') {
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground px-1.5 py-0.5 rounded bg-muted/40 border border-border">
        {t('fontPicker.status.bundled')}
      </span>
    )
  }
  if (status === 'installed') {
    return (
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground px-1.5 py-0.5 rounded bg-muted/30 border border-border">
        {t('fontPicker.status.installed')}
      </span>
    )
  }
  return null
}

// Re-export getFontMeta for callers that want to read meta inline alongside
// the picker.  Avoids forcing them to add an import from a deep path.
export { getFontMeta }
