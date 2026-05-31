import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Video, Mic, Type, ShieldCheck, Square, Loader2, Settings2 } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AppShell } from '@/components/app-shell/app-shell'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { HelpIcon } from '@/components/help-icon'
import { WhisperModelManager } from '@/components/whisper-model-manager/whisper-model-manager'
import { StyleSamplePreview } from '@/components/step1/style-sample-preview'
import { TranscriptionAdvancedDialog } from '@/components/step1/transcription-advanced-dialog'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { probeVideo, extractThumbnail } from '@/services/video'
import { openVideoDialog } from '@/services/dialog'
import { runTranscription } from '@/services/transcription'
import type { TranscriptionRun } from '@/services/transcription'
import { formatDuration } from '@/lib/time'
import { formatBytes } from '@/lib/format'
import type { SubtitleEntry as SubtitleEntryType, WhisperModelId } from '../../shared/types'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../shared/constants'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { loadSubtitleFont } from '@/lib/font-metrics'

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[12px] text-foreground font-mono tabular-nums">{value}</span>
    </div>
  )
}

interface Step1RouteProps {
  appVersion: string
}

export default function Step1Route({ appVersion }: Step1RouteProps) {
  const { t } = useTranslation(['step1', 'common'])
  const navigate = useNavigate()

  const video = useProjectStore((s) => s.video)
  const videoLoadingState = useProjectStore((s) => s.videoLoadingState)
  const setVideo = useProjectStore((s) => s.setVideo)
  const setVideoLoadingState = useProjectStore((s) => s.setVideoLoadingState)
  const setEntries = useProjectStore((s) => s.setEntries)
  const selectedTrack = useProjectStore((s) => s.selectedTrackIndex)
  const setSelectedTrack = useProjectStore((s) => s.setSelectedTrackIndex)
  const defaults = useProjectStore((s) => s.defaults)
  const setDefaults = useProjectStore((s) => s.setDefaults)
  const defaultAudioTrackIndex = useSettingsStore((s) => s.defaultAudioTrackIndex)
  // transcriptionAdvanced is needed in handleStartTranscription to feed the
  // Whisper sidecar with the user's tweaked VAD / beam-size / language; the
  // dialog now owns reads + writes for editing those fields, but step1
  // still needs the value at run-time.
  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  // autoLineBreak is consumed in two places: the post-transcription
  // line-break pass below, and the StyleSamplePreview's live wrap render
  // (so the user can verify the wrap before paying the Whisper cost).
  // The toggle UI itself lives in the Subtitle defaults card — autoLineBreak
  // is a subtitle-formatting choice, not a Whisper engine parameter.
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const setAutoLineBreak = useSettingsStore((s) => s.setAutoLineBreak)
  const resetStep3Settings = useSettingsStore((s) => s.resetStep3Settings)

  const isLoading = videoLoadingState === 'loading'

  const [activeModelId, setActiveModelId] = useState<WhisperModelId | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [fontSizeOutOfRange, setFontSizeOutOfRange] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState(0)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [advancedDialogOpen, setAdvancedDialogOpen] = useState(false)
  const transcriptionRunRef = useRef<TranscriptionRun | null>(null)

  useHotkeys('enter', () => { if (canStart && !isTranscribing) handleStartTranscription() }, { enableOnFormTags: false })

  // Preload subtitle font so applyAutoLineBreak can use accurate glyph metrics
  // when transcription completes (instead of falling back to character estimates).
  useEffect(() => { loadSubtitleFont().catch(() => {}) }, [])

  // Reset Step 3 UI state (burnin position, subtitle background, audio mode)
  // on every navigation to Step 1.  This is intentionally NOT done on Step 2
  // mount so that Step 2 ⇔ Step 3 round-trips preserve the working values.
  useEffect(() => {
    resetStep3Settings()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore thumbnail when navigating back to Step 1 with a pre-existing video
  useEffect(() => {
    if (!video) return
    extractThumbnail(video.path, 1).then((result) => {
      if (result.ok) setThumbnail(result.data)
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleBrowse() {
    const lastDir = video?.path ? video.path.replace(/[\\/][^\\/]+$/, '') : undefined
    const filePath = await openVideoDialog(lastDir)
    if (!filePath) return

    setVideoLoadingState('loading')
    setThumbnail(null)

    const result = await probeVideo(filePath)
    if (!result.ok) {
      setVideoLoadingState('idle')
      toast.error(t('toast.probeError', { error: result.error.message }))
      return
    }

    const info = result.data
    setVideo(info)

    // Extract thumbnail as part of the loading sequence
    try {
      const thumbResult = await extractThumbnail(info.path, 1)
      if (thumbResult.ok) setThumbnail(thumbResult.data)
    } catch {
      // thumbnail is optional
    }

    setVideoLoadingState('loaded')
    toast.success(t('toast.videoLoaded'))

    // Auto-select default audio track if available
    const defaultTrack = info.audioTracks.find((a) => a.index === defaultAudioTrackIndex)
    if (defaultTrack) {
      setSelectedTrack(defaultTrack.index)
    } else if (info.audioTracks.length > 0) {
      setSelectedTrack(info.audioTracks[0].index)
    }
  }

  async function handleStartTranscription() {
    if (!video || !activeModelId) return
    setIsTranscribing(true)
    setTranscribeProgress(0)
    window.electronAPI.menuSetTranscribing(true)

    const segments: { startSec: number; endSec: number; text: string }[] = []

    const run = runTranscription(
      {
        videoPath: video.path,
        trackIndex: selectedTrack,
        modelId: activeModelId,
        defaults: {
          fontSizePx: defaults.fontSizePx,
          textColorHex: defaults.textColorHex,
          outlineColorHex: defaults.outlineColorHex,
          outlineThicknessPx: defaults.outlineThicknessPx,
          fadeEnabled: defaults.fadeEnabled
        },
        advanced: transcriptionAdvanced
      },
      (evt) => {
        if (evt.event === 'progress') {
          setTranscribeProgress(Math.round(evt.percent))
        } else if (evt.event === 'segment') {
          segments.push(evt.segment)
        } else if (evt.event === 'needsDownload') {
          toast.warning(t('toast.modelNotInstalled', { model: evt.model }))
        }
      }
    )
    transcriptionRunRef.current = run

    let cancelled = false
    try {
      await run.promise
    } catch (err) {
      const msg = String(err)
      if (msg.includes('Cancelled')) {
        cancelled = true
        toast.info(t('toast.transcriptionCancelled'))
      } else {
        toast.error(t('toast.transcriptionError', { error: msg }))
      }
    } finally {
      setIsTranscribing(false)
      transcriptionRunRef.current = null
      window.electronAPI.menuSetTranscribing(false)
    }

    if (cancelled) return

    // Build SubtitleEntry array from collected segments
    const entries: SubtitleEntryType[] = segments.map((seg, i) => {
      const base = {
        startSec: seg.startSec,
        endSec: seg.endSec,
        text: seg.text,
        fontSizePx: defaults.fontSizePx,
        textColorHex: defaults.textColorHex,
        outlineColorHex: defaults.outlineColorHex,
        outlineThicknessPx: defaults.outlineThicknessPx,
        fadeEnabled: defaults.fadeEnabled
      }
      return {
        id: `t-${i}-${Date.now()}`,
        ...base,
        isDeleted: false,
        isEdited: false,
        original: { ...base }
      }
    })

    // Apply \N line breaks to entries that exceed the video width.
    // Both `text` and `original.text` receive the same treatment so that
    // the "Reset row" button restores to the auto-broken version.
    //
    // We await loadSubtitleFont() here (rather than reading the cache via
    // getSubtitleFont()) so applyAutoLineBreak is guaranteed to use the
    // glyph-accurate width pipeline.  Synchronous getSubtitleFont() can
    // legitimately return null when Whisper finishes faster than the font
    // fetch (small model + short clip + slow disk), and the fallback
    // character-class estimate over-counts wide-glyph widths by ~45 %
    // vs libass — so without the await, the burn-in line breaks would
    // land ~8+ chars earlier than the preview promised.  loadSubtitleFont
    // de-dupes via its module-level cache + in-flight promise, so this
    // resolves immediately whenever the Step 1 mount preload (line ~93)
    // has completed.  On load failure we fall through with null and
    // accept the degraded fallback, matching prior behaviour.
    const font = await loadSubtitleFont().catch(() => null)
    const finalEntries = autoLineBreak
      ? entries.map((entry) => {
          const brokenText = applyAutoLineBreak(
            entry.text,
            entry.fontSizePx,
            entry.outlineThicknessPx,
            video.widthPx,
            font
          )
          return {
            ...entry,
            text: brokenText,
            original: { ...entry.original, text: brokenText }
          }
        })
      : entries

    setEntries(finalEntries)
    toast.success(t('toast.transcriptionComplete', { count: finalEntries.length }))
    navigate('/step2')
  }

  function handleCancelClick() {
    setShowCancelDialog(true)
  }

  function handleConfirmCancel() {
    setShowCancelDialog(false)
    transcriptionRunRef.current?.cancel()
  }

  const canStart = !isLoading && video !== null && (video.audioTracks?.length ?? 0) > 0 && activeModelId !== null
  const audioTracks = video?.audioTracks ?? []

  const footerCenter = (
    <div className="flex items-center gap-4">
      <span className="text-[12px] text-zinc-500">
        {activeModelId
          ? t('footer.modelStatus', { model: activeModelId })
          : t('footer.modelNotDownloaded', { model: '—' })}
      </span>
      <span className="w-px h-3 bg-zinc-700 flex-shrink-0" />
      <span className="flex items-center gap-1.5 text-[12px] text-zinc-500">
        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0" />
        {t('footer.privacyNote')}
      </span>
    </div>
  )

  const footerRight = (
    <Button
      variant="primary"
      size="md"
      disabled={!isTranscribing && !canStart}
      onClick={isTranscribing ? handleCancelClick : handleStartTranscription}
    >
      {isTranscribing ? (
        transcribeProgress === 0 ? (
          <>
            <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            {t('action.transcribingWaiting')}
          </>
        ) : (
          <>
            <Square className="h-3.5 w-3.5 mr-1.5 fill-current" />
            {t('action.transcribing', { percent: transcribeProgress })}
          </>
        )
      ) : (
        t('action.startTranscription')
      )}
    </Button>
  )

  return (
    <AppShell
      currentStep={1}
      appVersion={appVersion}
      footerCenter={footerCenter}
      footerRight={footerRight}
    >
      <div className="space-y-4">
        {/* Page header */}
        <div>
          <h1 className="text-[18px] font-semibold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{t('guidance')}</p>
        </div>

        {/* Whisper model + Advanced trigger.  Full-width card.  The
            Advanced dialog opens via the trigger on the right edge so
            the panel stays discoverable without claiming primary screen
            space — the dialog content is identical to the former inline
            accordion, just relocated. */}
        <div className={cn(
          'rounded-xl border border-border bg-card p-4 transition-opacity duration-200',
          (isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
        )}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <WhisperModelManager onActiveModelChange={setActiveModelId} disabled={isLoading || isTranscribing} />
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAdvancedDialogOpen(true)}
              className="flex-shrink-0"
            >
              <Settings2 className="h-4 w-4 mr-1.5" />
              {t('advanced.openButton')}
            </Button>
          </div>
        </div>

        {/* 2-column body.  Left = "what to transcribe" (video + audio
            tracks), right = "how it will look" (seed style + live
            preview).  Below the lg breakpoint the grid collapses to a
            single column and AppShell's outer scroll handles the
            overflow — step 1 is settings-heavy and a small amount of
            scrolling is preferable to cramming everything in. */}
        <div className="grid gap-4 lg:grid-cols-2 items-start">
          {/* ── Left column ──────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Input video — path + inline metadata when loaded.  The
                old dedicated "thumbnail + info 2-col" card is gone: the
                thumbnail now lives behind the live preview on the right,
                and the four metadata fields collapse into this card. */}
            <div className={cn(
              'rounded-xl border border-border bg-card p-4 space-y-2 transition-opacity duration-200',
              isTranscribing && 'opacity-50 pointer-events-none'
            )}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Video className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <Label className="uppercase tracking-wider text-[10px]">{t('inputVideo.label')}</Label>
                  <HelpIcon content={t('inputVideo.help')} />
                </div>
                <span className="text-[11px] text-muted-foreground/60">{t('inputVideo.hint')}</span>
              </div>
              {isLoading ? (
                <div className="flex items-center gap-2.5 h-9 px-1">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
                  <span className="text-[13px] text-muted-foreground">{t('inputVideo.loading')}</span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-9 rounded-md border border-border bg-input px-3.5 flex items-center min-w-0">
                    <span className={cn(
                      'text-[13px] truncate',
                      video ? 'text-foreground' : 'text-muted-foreground/60'
                    )}>
                      {video?.path ?? t('inputVideo.placeholder')}
                    </span>
                  </div>
                  <Button variant="secondary" size="md" onClick={handleBrowse}>
                    <FolderOpen className="h-4 w-4 mr-1.5" />
                    {t('inputVideo.chooseVideo')}
                  </Button>
                </div>
              )}
              {video && (
                <div className="divide-y divide-border/50 pt-1">
                  <InfoRow label={t('inputVideo.infoResolution')} value={`${video.widthPx}×${video.heightPx}`} />
                  <InfoRow label={t('inputVideo.infoDuration')} value={formatDuration(video.durationSec)} />
                  <InfoRow label={t('inputVideo.infoFormat')} value={`${video.container.toUpperCase()} / ${video.videoCodec} / ${video.fps}fps`} />
                  <InfoRow label={t('inputVideo.infoFileSize')} value={formatBytes(video.fileSizeBytes)} />
                </div>
              )}
            </div>

            {/* Audio tracks */}
            <div className={cn(
              'rounded-xl border border-border bg-card p-4 space-y-3 transition-opacity duration-200',
              (!video || isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
            )}>
              <div className="flex items-center gap-1.5">
                <Mic className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <Label className="uppercase tracking-wider text-[10px]">{t('audioTracks.label')}</Label>
                <HelpIcon content={t('audioTracks.help')} />
                {audioTracks.length > 0 && (
                  <Badge variant="muted">{t('audioTracks.tracksCount', { count: audioTracks.length })}</Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('audioTracks.description')}</p>
              <div className="grid grid-cols-2 gap-2">
                {audioTracks.map((track) => (
                  <button
                    key={track.index}
                    type="button"
                    onClick={() => setSelectedTrack(track.index)}
                    className={cn(
                      'relative rounded-md border p-3 text-left transition-colors duration-150',
                      selectedTrack === track.index
                        ? 'border-primary/50 bg-primary/5'
                        : 'border-border hover:bg-accent/40'
                    )}
                  >
                    {selectedTrack === track.index && (
                      <div className="absolute top-2 right-2">
                        <Badge variant="success">{t('audioTracks.transcriptionTarget')}</Badge>
                      </div>
                    )}
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full flex-shrink-0 bg-primary" />
                      <span className={cn(
                        'text-[13px] font-medium',
                        selectedTrack === track.index ? 'text-primary' : 'text-foreground'
                      )}>
                        {t('audioTracks.trackLabel', { index: track.index })}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground pl-4">
                      {`${track.channels} · ${track.sampleRateHz / 1000}kHz · ${track.codec}`}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* ── Right column ─────────────────────────────────────────── */}
          <div className="space-y-4">
            {/* Subtitle defaults — seed values for every row at
                transcription time.  Any change here re-renders the live
                preview below on the next tick, so the user can verify
                "this is what gets burned in" before paying the Whisper
                cost. */}

            {/* Card: Subtitle defaults */}
            <div className={cn(
              'rounded-xl border border-border bg-card p-4 space-y-3 transition-opacity duration-200',
              (isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
            )}>
              <div className="flex items-center gap-1.5">
                <Type className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <Label className="uppercase tracking-wider text-[10px]">{t('subtitleDefaults.label')}</Label>
                <span className="text-[11px] text-muted-foreground/60">{t('subtitleDefaults.hint')}</span>
              </div>
              {/* Top row: size / textColor / outlineColor / fade.  The
                  outline-thickness slider gets its own row below because
                  its natural width (96 px slider + 24 px readout) does
                  not fit comfortably alongside four other controls in a
                  narrow right column once lg compresses. */}
              <div className="grid grid-cols-4 gap-3">
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label>{t('subtitleDefaults.size')}</Label>
                    <HelpIcon content={t('subtitleDefaults.helpSize')} />
                  </div>
                  <input
                    key={defaults.fontSizePx}
                    type="number"
                    min={FONT_SIZE_MIN_PX}
                    max={FONT_SIZE_MAX_PX}
                    defaultValue={defaults.fontSizePx}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      setFontSizeOutOfRange(!isNaN(v) && (v < FONT_SIZE_MIN_PX || v > FONT_SIZE_MAX_PX))
                    }}
                    onBlur={(e) => {
                      setFontSizeOutOfRange(false)
                      const v = parseInt(e.target.value, 10)
                      if (isNaN(v)) return
                      setDefaults({ fontSizePx: Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, v)) })
                    }}
                    className={cn(
                      'h-9 w-full rounded-md border bg-input px-2 text-center text-[13px] text-foreground focus:outline-none focus:ring-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                      fontSizeOutOfRange
                        ? 'border-[hsl(var(--warning)/0.6)] focus:ring-[hsl(var(--warning)/0.3)]'
                        : 'border-border focus:ring-ring/30'
                    )}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label>{t('subtitleDefaults.textColor')}</Label>
                    <HelpIcon content={t('subtitleDefaults.helpTextColor')} />
                  </div>
                  <ColorPicker value={defaults.textColorHex} onChange={(hex) => setDefaults({ textColorHex: hex })} />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label>{t('subtitleDefaults.outlineColor')}</Label>
                    <HelpIcon content={t('subtitleDefaults.helpOutlineColor')} />
                  </div>
                  <ColorPicker value={defaults.outlineColorHex} onChange={(hex) => setDefaults({ outlineColorHex: hex })} />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center gap-1">
                    <Label>{t('subtitleDefaults.fade')}</Label>
                    <HelpIcon content={t('subtitleDefaults.helpFade')} />
                  </div>
                  <div className="flex items-center gap-2 h-9">
                    <Switch checked={defaults.fadeEnabled} onCheckedChange={(v) => setDefaults({ fadeEnabled: v })} />
                    <span className="text-[12px] text-muted-foreground">
                      {defaults.fadeEnabled ? t('subtitleDefaults.fadeOn') : t('subtitleDefaults.fadeOff')}
                    </span>
                  </div>
                </div>
              </div>
              {/* Outline thickness — shared slider component (same one
                  Step 2 uses for per-row + bulk-edit) so the look and
                  commit semantics stay aligned across surfaces. */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <Label>{t('subtitleDefaults.stroke')}</Label>
                  <HelpIcon content={t('subtitleDefaults.helpStroke')} />
                </div>
                <OutlineThicknessSlider
                  value={defaults.outlineThicknessPx}
                  onCommit={(v) => setDefaults({ outlineThicknessPx: v })}
                  ariaLabel={t('subtitleDefaults.stroke')}
                />
              </div>
              {/* Auto line break — subtitle-formatting decision, lives here
                  rather than the Advanced (engine) dialog.  Toggling this
                  immediately re-wraps the StyleSamplePreview below so the
                  user can verify the choice before transcribing. */}
              <div className="space-y-1.5">
                <div className="flex items-center gap-1">
                  <Label>{t('advanced.autoLineBreak')}</Label>
                  <HelpIcon content={t('advanced.autoLineBreakHelp')} />
                </div>
                <div className="flex items-center gap-2 h-9">
                  <Switch
                    checked={autoLineBreak}
                    onCheckedChange={(v) => setAutoLineBreak(v)}
                  />
                  <span className="text-[12px] text-muted-foreground">
                    {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
                  </span>
                </div>
              </div>
            </div>

            {/* Live preview — recomputes on every defaults change.  See
                feature/ui-redesign commit 199e3ce for the contract. */}
            <StyleSamplePreview
              defaults={defaults}
              thumbnail={thumbnail}
              video={video}
              autoLineBreak={autoLineBreak}
            />
          </div>
        </div>

      </div>

      {/* Advanced transcription parameters live in their own dialog rather
          than an inline accordion now — Step 1 stays compact and the
          deep VAD / recognition knobs are one click away when needed. */}
      <TranscriptionAdvancedDialog
        open={advancedDialogOpen}
        onOpenChange={setAdvancedDialogOpen}
      />

      {/* Cancel transcription dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('dialog.cancelTitle')}</DialogTitle>
            <DialogDescription>{t('dialog.cancelBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setShowCancelDialog(false)}>
              {t('dialog.cancelDeny')}
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-500 text-white"
              onClick={handleConfirmCancel}
            >
              {t('dialog.cancelConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
