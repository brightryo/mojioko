import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Camera } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { saveFileDialog } from '@/services/dialog'
import { exportFrame as ipcExportFrame } from '@/services/video'
import { BURNIN_DEFAULTS } from '../../../shared/burnin-defaults'

/**
 * REQ-20260615-022: STEP2 footer's "image export" entry — opens a small
 * popover with the include-subtitles checkbox + PNG/JPG toggle + Save
 * button, then routes to the main-process frame exporter.  Previously
 * lived as a Camera icon in the video-preview panel header (REQ-021);
 * relocated to the footer so the three export affordances (text /
 * image / video) sit together.
 *
 * The current preview time is read from `useUiStore.videoCurrentTimeSec`
 * which the VideoPreviewPanel's `handleTimeUpdate` keeps synchronised
 * with `<video>.currentTime`.  This is the source / original axis, so
 * ffmpeg can seek the raw input directly.
 */
export function ExportFrameButton() {
  const { t } = useTranslation(['step2'])
  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  // REQ-20260615-050 — fade lives per-entry; the still uses each entry's
  // own `fadeDurationSec`, no global slice is read here.
  const currentTimeSec = useUiStore((s) => s.videoCurrentTimeSec)

  const [open, setOpen] = useState(false)
  const [includeSubtitles, setIncludeSubtitles] = useState(true)
  const [format, setFormat] = useState<'png' | 'jpg'>('png')
  const [busy, setBusy] = useState(false)

  const disabled = !video

  function formatTimecode(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '00-00-00'
    const total = Math.floor(sec)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return `${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}-${String(s).padStart(2, '0')}`
  }

  async function handleSave() {
    if (!video) return
    if (busy) return

    const stem = video.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'frame'
    const timecode = formatTimecode(currentTimeSec)
    const ext = format === 'jpg' ? 'jpg' : 'png'
    const defaultName = `${stem}_${timecode}.${ext}`

    const savePath = await saveFileDialog(
      defaultName,
      undefined,
      format === 'jpg'
        ? [{ name: 'JPEG image', extensions: ['jpg', 'jpeg'] }, { name: 'All Files', extensions: ['*'] }]
        : [{ name: 'PNG image', extensions: ['png'] }, { name: 'All Files', extensions: ['*'] }]
    )
    if (!savePath) return

    setBusy(true)
    setOpen(false)
    try {
      const result = await ipcExportFrame({
        inputPath: video.path,
        outputPath: savePath,
        timeSec: currentTimeSec,
        video,
        format,
        includeSubtitles,
        entries: includeSubtitles ? entries : undefined,
        subtitleBackground: {
          enabled: BURNIN_DEFAULTS.subtitleBackground.enabled,
          color: BURNIN_DEFAULTS.subtitleBackground.color,
          opacityPercent: BURNIN_DEFAULTS.subtitleBackground.opacityPercent
        },
        fontId: activeFontId
      })
      if (result.ok) {
        toast.success(t('videoPreview.exportFrame.success', { path: result.data.outputPath }))
      } else {
        toast.error(t('videoPreview.exportFrame.error', { error: result.error.message }))
      }
    } catch (err) {
      toast.error(t('videoPreview.exportFrame.error', { error: String(err) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="md" disabled={disabled || busy}>
          <Camera className="h-4 w-4 mr-1.5" />
          {t('action.exportImageLabel')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-64">
        <div className="flex flex-col gap-3">
          <div className="text-body-sm font-semibold text-fg-primary">
            {t('videoPreview.exportFrame.title')}
          </div>
          <label className="flex items-center gap-2 text-body-sm text-fg-secondary cursor-pointer">
            <Checkbox
              checked={includeSubtitles}
              onCheckedChange={(v) => setIncludeSubtitles(v === true)}
            />
            <span>{t('videoPreview.exportFrame.includeSubtitles')}</span>
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="text-body-sm text-fg-secondary">
              {t('videoPreview.exportFrame.format')}
            </span>
            <div
              role="radiogroup"
              aria-label={t('videoPreview.exportFrame.format')}
              className="flex h-7 items-stretch gap-0.5 rounded-md border border-line-strong bg-surface-0 p-0.5"
            >
              {(['png', 'jpg'] as const).map((f) => {
                const selected = format === f
                return (
                  <button
                    key={f}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setFormat(f)}
                    className={cn(
                      'inline-flex items-center justify-center rounded-[3px] px-3 text-caption font-medium transition-colors duration-150',
                      'focus:outline-none focus-visible:outline-none',
                      selected
                        ? 'bg-primary text-fg-inverse'
                        : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-2'
                    )}
                  >
                    {f.toUpperCase()}
                  </button>
                )
              })}
            </div>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className={cn(
              'h-8 inline-flex items-center justify-center rounded-md px-3 text-body-sm font-medium',
              'bg-primary text-fg-inverse hover:bg-primary-hover active:bg-primary-active',
              'transition-colors duration-150',
              'focus:outline-none focus-visible:outline-none',
              'disabled:opacity-40 disabled:cursor-not-allowed'
            )}
          >
            {busy
              ? t('videoPreview.exportFrame.saving')
              : t('videoPreview.exportFrame.save')}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
