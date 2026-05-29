import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Video, Mic, Type, ShieldCheck, Square, Loader2, ChevronRight, ChevronDown, HelpCircle, RotateCcw } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AppShell } from '@/components/app-shell/app-shell'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { HelpIcon } from '@/components/help-icon'
import { WhisperModelManager } from '@/components/whisper-model-manager/whisper-model-manager'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { probeVideo, extractThumbnail } from '@/services/video'
import { openVideoDialog } from '@/services/dialog'
import { runTranscription } from '@/services/transcription'
import type { TranscriptionRun } from '@/services/transcription'
import { formatDuration } from '@/lib/time'
import { formatBytes } from '@/lib/format'
import type { SubtitleEntry as SubtitleEntryType, WhisperModelId } from '../../shared/types'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, OUTLINE_THICKNESS_MAX_PX, TRANSCRIPTION_DEFAULTS } from '../../shared/constants'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { getSubtitleFont, loadSubtitleFont } from '@/lib/font-metrics'

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-[12px] text-zinc-500">{label}</span>
      <span className="text-[12px] text-zinc-100 font-mono tabular-nums">{value}</span>
    </div>
  )
}

/**
 * Editable parameter row for the Advanced settings accordion.
 * - Label (amber when changed) + tooltip on the left (shrink-0, no truncation)
 * - Dashed leader fills the gap, visually connecting label → control
 * - Hover shows a subtle zinc-800/30 row highlight
 * - Max-width 520px keeps label–control distance compact
 */
function AdvancedParamRow({
  label, help, changed, children
}: {
  label: string; help: string; changed: boolean; children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 -mx-2 max-w-[520px] hover:bg-zinc-800/30 transition-colors duration-150">
      {/* label + tooltip — shrink-0 so label never gets truncated */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className={cn(
          'text-sm transition-colors duration-150',
          changed ? 'text-amber-400' : 'text-zinc-400'
        )}>
          {label}
        </span>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-help text-zinc-600 hover:text-zinc-400 transition-colors duration-150">
              <HelpCircle className="h-3.5 w-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px] bg-zinc-800 text-left">
            {help}
          </TooltipContent>
        </Tooltip>
      </div>
      {/* Dashed leader: stretches to fill space, visually connects label to control */}
      <div className="flex-1 border-t border-dashed border-zinc-700/50 min-w-[16px]" />
      {/* control */}
      <div className="shrink-0">
        {children}
      </div>
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
  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  const setTranscriptionAdvanced = useSettingsStore((s) => s.setTranscriptionAdvanced)
  const resetTranscriptionAdvanced = useSettingsStore((s) => s.resetTranscriptionAdvanced)
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const setAutoLineBreak = useSettingsStore((s) => s.setAutoLineBreak)
  const resetStep3Settings = useSettingsStore((s) => s.resetStep3Settings)

  const isAdvancedChanged =
    !autoLineBreak ||   // default is true
    transcriptionAdvanced.vadFilter !== TRANSCRIPTION_DEFAULTS.vadFilter ||
    transcriptionAdvanced.vadThreshold !== TRANSCRIPTION_DEFAULTS.vadThreshold ||
    transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs ||
    transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs ||
    transcriptionAdvanced.beamSize !== TRANSCRIPTION_DEFAULTS.beamSize ||
    transcriptionAdvanced.language !== TRANSCRIPTION_DEFAULTS.language

  const isLoading = videoLoadingState === 'loading'

  const [activeModelId, setActiveModelId] = useState<WhisperModelId | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [fontSizeOutOfRange, setFontSizeOutOfRange] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState(0)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
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
    const font = getSubtitleFont()
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
          <h1 className="text-[18px] font-semibold text-zinc-50">{t('title')}</h1>
          <p className="mt-1 text-[13px] text-zinc-400">{t('guidance')}</p>
        </div>

        {/* Card: Whisper model manager */}
        <div className={cn(
          'rounded-xl border border-zinc-800 bg-[#141414] p-4 transition-opacity duration-200',
          (isLoading || isTranscribing) && 'opacity-50'
        )}>
          <WhisperModelManager onActiveModelChange={setActiveModelId} disabled={isLoading || isTranscribing} />
        </div>

        {/* Card: Input video */}
        <div className={cn(
          'rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-2 transition-opacity duration-200',
          isTranscribing && 'opacity-50 pointer-events-none'
        )}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <Video className="h-4 w-4 text-zinc-500 flex-shrink-0" />
              <Label className="uppercase tracking-wider text-[10px]">{t('inputVideo.label')}</Label>
              <HelpIcon content={t('inputVideo.help')} />
            </div>
            <span className="text-[11px] text-zinc-600">{t('inputVideo.hint')}</span>
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2.5 h-9 px-1">
              <Loader2 className="h-4 w-4 animate-spin text-zinc-500 flex-shrink-0" />
              <span className="text-[13px] text-zinc-400">{t('inputVideo.loading')}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-9 rounded-md border border-zinc-800 bg-zinc-950 px-3.5 flex items-center min-w-0">
                <span className={`text-[13px] truncate ${video ? 'text-zinc-100' : 'text-zinc-600'}`}>
                  {video?.path ?? t('inputVideo.placeholder')}
                </span>
              </div>
              <Button variant="secondary" size="md" onClick={handleBrowse}>
                <FolderOpen className="h-4 w-4 mr-1.5" />
                {t('inputVideo.chooseVideo')}
              </Button>
            </div>
          )}
        </div>

        {/* Two-column: thumbnail + video info (only when video loaded) */}
        {video && (
          <div className="grid gap-4" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
            {/* Left: thumbnail card */}
            <div className="rounded-xl border border-zinc-800 bg-[#141414] p-4">
              <div
                className="rounded-md bg-zinc-950 border border-zinc-800 aspect-video w-full overflow-hidden"
                style={{ maxHeight: '240px' }}
              >
                {thumbnail ? (
                  <img src={thumbnail} alt="preview" className="w-full h-full object-contain" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Video className="h-8 w-8 text-zinc-700" />
                  </div>
                )}
              </div>
            </div>
            {/* Right: video info card */}
            <div className="rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-3">
              <Label className="uppercase tracking-wider text-[10px]">{t('inputVideo.infoLabel')}</Label>
              <div className="space-y-0 divide-y divide-zinc-800/50">
                <InfoRow label={t('inputVideo.infoResolution')} value={`${video.widthPx}×${video.heightPx}`} />
                <InfoRow label={t('inputVideo.infoDuration')} value={formatDuration(video.durationSec)} />
                <InfoRow label={t('inputVideo.infoFormat')} value={`${video.container.toUpperCase()} / ${video.videoCodec} / ${video.fps}fps`} />
                <InfoRow label={t('inputVideo.infoFileSize')} value={formatBytes(video.fileSizeBytes)} />
              </div>
            </div>
          </div>
        )}

        {/* Card: Audio tracks */}
        <div className={cn(
          'rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-3 transition-opacity duration-200',
          (!video || isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
        )}>
          <div className="flex items-center gap-1.5">
            <Mic className="h-4 w-4 text-zinc-500 flex-shrink-0" />
            <Label className="uppercase tracking-wider text-[10px]">{t('audioTracks.label')}</Label>
            <HelpIcon content={t('audioTracks.help')} />
            {audioTracks.length > 0 && (
              <Badge variant="muted">{t('audioTracks.tracksCount', { count: audioTracks.length })}</Badge>
            )}
          </div>
          <p className="text-xs text-zinc-400">{t('audioTracks.description')}</p>
          <div className="grid grid-cols-2 gap-2">
            {audioTracks.map((track) => (
              <button
                key={track.index}
                type="button"
                onClick={() => setSelectedTrack(track.index)}
                className={cn(
                  'relative rounded-md border p-3 text-left transition-colors duration-150',
                  selectedTrack === track.index
                    ? 'border-green-500/50 bg-green-500/5'
                    : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/20'
                )}
              >
                {selectedTrack === track.index && (
                  <div className="absolute top-2 right-2">
                    <Badge variant="success">{t('audioTracks.transcriptionTarget')}</Badge>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full flex-shrink-0 bg-green-500" />
                  <span className={cn(
                    'text-[13px] font-medium',
                    selectedTrack === track.index ? 'text-green-400' : 'text-zinc-200'
                  )}>
                    {t('audioTracks.trackLabel', { index: track.index })}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-zinc-500 pl-4">
                  {`${track.channels} · ${track.sampleRateHz / 1000}kHz · ${track.codec}`}
                </p>
              </button>
            ))}
          </div>
        </div>

        {/* Card: Subtitle defaults */}
        <div className={cn(
          'rounded-xl border border-zinc-800 bg-[#141414] p-4 space-y-3 transition-opacity duration-200',
          (!video || isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
        )}>
          <div className="flex items-center gap-1.5">
            <Type className="h-4 w-4 text-zinc-500 flex-shrink-0" />
            <Label className="uppercase tracking-wider text-[10px]">{t('subtitleDefaults.label')}</Label>
            <span className="text-[11px] text-zinc-600">{t('subtitleDefaults.hint')}</span>
          </div>
          <div className="grid grid-cols-5 gap-3">
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
                  'h-9 w-full rounded-md border bg-zinc-950 px-2 text-center text-[13px] text-zinc-100 focus:outline-none focus:ring-2 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                  fontSizeOutOfRange
                    ? 'border-amber-400/60 focus:ring-amber-400/30'
                    : 'border-zinc-800 focus:ring-green-500/30'
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
                <Label>{t('subtitleDefaults.stroke')}</Label>
                <HelpIcon content={t('subtitleDefaults.helpStroke')} />
              </div>
              <div className="flex rounded-md overflow-hidden border border-zinc-800">
                {Array.from({ length: OUTLINE_THICKNESS_MAX_PX + 1 }, (_, i) => i).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDefaults({ outlineThicknessPx: v })}
                    className={cn(
                      // 11 buttons in the same width as the previous 6 → shrink font/padding
                      // so labels like "10" still fit comfortably in each cell.
                      'flex-1 py-1.5 text-[12px] tabular-nums transition-colors duration-150',
                      defaults.outlineThicknessPx === v
                        ? 'bg-green-500 text-green-950 font-semibold'
                        : 'bg-zinc-950 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center gap-1">
                <Label>{t('subtitleDefaults.fade')}</Label>
                <HelpIcon content={t('subtitleDefaults.helpFade')} />
              </div>
              <div className="flex items-center gap-2 h-9">
                <Switch checked={defaults.fadeEnabled} onCheckedChange={(v) => setDefaults({ fadeEnabled: v })} />
                <span className="text-[12px] text-zinc-400">
                  {defaults.fadeEnabled ? t('subtitleDefaults.fadeOn') : t('subtitleDefaults.fadeOff')}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Card: Advanced settings accordion */}
        <div className={cn(
          'rounded-xl border border-zinc-800 overflow-hidden transition-opacity duration-200',
          (isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
        )}>
          {/* Accordion header */}
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            className="w-full flex items-center justify-between bg-zinc-800/50 hover:bg-zinc-800 px-4 py-3 transition-colors duration-150"
          >
            <span className="text-[13px] font-medium text-zinc-300">{t('advanced.title')}</span>
            {advancedOpen
              ? <ChevronDown className="h-4 w-4 text-zinc-500 flex-shrink-0" />
              : <ChevronRight className="h-4 w-4 text-zinc-500 flex-shrink-0" />
            }
          </button>

          {/* Animated content area — CSS grid rows trick */}
          <div className={cn(
            'grid transition-all duration-200',
            advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          )}>
            <div className="overflow-hidden">
              <div className="bg-zinc-900/30 border-t border-zinc-800 px-4 pt-4 pb-5 space-y-5">

                {/* Text formatting section */}
                <div className="space-y-0.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-300 mb-2">
                    {t('advanced.textFormatting')}
                  </p>
                  <AdvancedParamRow
                    label={t('advanced.autoLineBreak')}
                    help={t('advanced.autoLineBreakHelp')}
                    changed={!autoLineBreak}
                  >
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={autoLineBreak}
                        onCheckedChange={(v) => setAutoLineBreak(v)}
                      />
                      <span className={cn(
                        'text-[12px] transition-colors duration-150',
                        !autoLineBreak ? 'text-amber-400' : 'text-zinc-400'
                      )}>
                        {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
                      </span>
                    </div>
                  </AdvancedParamRow>
                </div>

                {/* VAD section */}
                <div className="space-y-0.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-300 mb-2">
                    {t('advanced.vad')}
                  </p>
                  {/* vadFilter */}
                  <AdvancedParamRow
                    label={t('advanced.vadFilter')}
                    help={t('advanced.vadFilterHelp')}
                    changed={transcriptionAdvanced.vadFilter !== TRANSCRIPTION_DEFAULTS.vadFilter}
                  >
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={transcriptionAdvanced.vadFilter}
                        onCheckedChange={(v) => setTranscriptionAdvanced({ vadFilter: v })}
                      />
                      <span className={cn(
                        'text-[12px] transition-colors duration-150',
                        transcriptionAdvanced.vadFilter !== TRANSCRIPTION_DEFAULTS.vadFilter
                          ? 'text-amber-400' : 'text-zinc-400'
                      )}>
                        {transcriptionAdvanced.vadFilter ? t('advanced.enabled') : t('advanced.disabled')}
                      </span>
                    </div>
                  </AdvancedParamRow>
                  {/* vadThreshold — only when vadFilter is on */}
                  {transcriptionAdvanced.vadFilter && (
                    <AdvancedParamRow
                      label={t('advanced.vadThreshold')}
                      help={t('advanced.vadThresholdHelp')}
                      changed={transcriptionAdvanced.vadThreshold !== TRANSCRIPTION_DEFAULTS.vadThreshold}
                    >
                      <input
                        key={transcriptionAdvanced.vadThreshold}
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        defaultValue={transcriptionAdvanced.vadThreshold}
                        onBlur={(e) => {
                          const v = parseFloat(e.target.value)
                          if (isNaN(v)) return
                          setTranscriptionAdvanced({ vadThreshold: Math.min(1, Math.max(0, Math.round(v * 100) / 100)) })
                        }}
                        className={cn(
                          'w-20 h-7 rounded-md border bg-zinc-950 px-2 text-center text-[13px] focus:outline-none focus:ring-2 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                          transcriptionAdvanced.vadThreshold !== TRANSCRIPTION_DEFAULTS.vadThreshold
                            ? 'border-amber-400/60 text-amber-400 focus:ring-amber-400/30'
                            : 'border-zinc-700 text-zinc-200 focus:ring-green-500/30'
                        )}
                      />
                    </AdvancedParamRow>
                  )}
                  {/* minSpeechDurationMs */}
                  <AdvancedParamRow
                    label={t('advanced.minSpeechDuration')}
                    help={t('advanced.minSpeechDurationHelp')}
                    changed={transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs}
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        key={transcriptionAdvanced.minSpeechDurationMs}
                        type="number"
                        min={50}
                        max={1000}
                        step={50}
                        defaultValue={transcriptionAdvanced.minSpeechDurationMs}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10)
                          if (isNaN(v)) return
                          setTranscriptionAdvanced({ minSpeechDurationMs: Math.min(1000, Math.max(50, v)) })
                        }}
                        className={cn(
                          'w-20 h-7 rounded-md border bg-zinc-950 px-2 text-center text-[13px] focus:outline-none focus:ring-2 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                          transcriptionAdvanced.minSpeechDurationMs !== TRANSCRIPTION_DEFAULTS.minSpeechDurationMs
                            ? 'border-amber-400/60 text-amber-400 focus:ring-amber-400/30'
                            : 'border-zinc-700 text-zinc-200 focus:ring-green-500/30'
                        )}
                      />
                      <span className="text-[11px] text-zinc-600">ms</span>
                    </div>
                  </AdvancedParamRow>
                  {/* minSilenceDurationMs */}
                  <AdvancedParamRow
                    label={t('advanced.minSilenceDuration')}
                    help={t('advanced.minSilenceDurationHelp')}
                    changed={transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs}
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        key={transcriptionAdvanced.minSilenceDurationMs}
                        type="number"
                        min={100}
                        max={5000}
                        step={100}
                        defaultValue={transcriptionAdvanced.minSilenceDurationMs}
                        onBlur={(e) => {
                          const v = parseInt(e.target.value, 10)
                          if (isNaN(v)) return
                          setTranscriptionAdvanced({ minSilenceDurationMs: Math.min(5000, Math.max(100, v)) })
                        }}
                        className={cn(
                          'w-20 h-7 rounded-md border bg-zinc-950 px-2 text-center text-[13px] focus:outline-none focus:ring-2 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                          transcriptionAdvanced.minSilenceDurationMs !== TRANSCRIPTION_DEFAULTS.minSilenceDurationMs
                            ? 'border-amber-400/60 text-amber-400 focus:ring-amber-400/30'
                            : 'border-zinc-700 text-zinc-200 focus:ring-green-500/30'
                        )}
                      />
                      <span className="text-[11px] text-zinc-600">ms</span>
                    </div>
                  </AdvancedParamRow>
                </div>

                {/* Recognition section */}
                <div className="space-y-0.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-zinc-300 mb-2">
                    {t('advanced.recognition')}
                  </p>
                  {/* beamSize */}
                  <AdvancedParamRow
                    label={t('advanced.beamSize')}
                    help={t('advanced.beamSizeHelp')}
                    changed={transcriptionAdvanced.beamSize !== TRANSCRIPTION_DEFAULTS.beamSize}
                  >
                    <input
                      key={transcriptionAdvanced.beamSize}
                      type="number"
                      min={1}
                      max={20}
                      step={1}
                      defaultValue={transcriptionAdvanced.beamSize}
                      onBlur={(e) => {
                        const v = parseInt(e.target.value, 10)
                        if (isNaN(v)) return
                        setTranscriptionAdvanced({ beamSize: Math.min(20, Math.max(1, v)) })
                      }}
                      className={cn(
                        'w-20 h-7 rounded-md border bg-zinc-950 px-2 text-center text-[13px] focus:outline-none focus:ring-2 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                        transcriptionAdvanced.beamSize !== TRANSCRIPTION_DEFAULTS.beamSize
                          ? 'border-amber-400/60 text-amber-400 focus:ring-amber-400/30'
                          : 'border-zinc-700 text-zinc-200 focus:ring-green-500/30'
                      )}
                    />
                  </AdvancedParamRow>
                  {/* language */}
                  <AdvancedParamRow
                    label={t('advanced.language')}
                    help={t('advanced.languageHelp')}
                    changed={transcriptionAdvanced.language !== TRANSCRIPTION_DEFAULTS.language}
                  >
                    <Select
                      value={transcriptionAdvanced.language}
                      onValueChange={(v) => setTranscriptionAdvanced({ language: v })}
                    >
                      <SelectTrigger className={cn(
                        'w-36 h-7 text-[13px] border bg-zinc-950',
                        transcriptionAdvanced.language !== TRANSCRIPTION_DEFAULTS.language
                          ? 'border-amber-400/60 text-amber-400'
                          : 'border-zinc-700 text-zinc-200'
                      )}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['auto','ja','en','zh','ko','es','fr','de','pt','ru','ar'] as const).map((code) => (
                          <SelectItem key={code} value={code}>
                            {t(`advanced.lang_${code}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </AdvancedParamRow>
                </div>

                {/* Reset + note row */}
                <div className="flex items-center justify-between pt-1">
                  <p className="text-[11px] italic text-zinc-600">
                    {t('advanced.futureNote')}
                  </p>
                  {isAdvancedChanged && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        resetTranscriptionAdvanced()
                        setAutoLineBreak(true)
                      }}
                      className="h-7 text-[12px] text-zinc-500 hover:text-zinc-300 gap-1.5 flex-shrink-0"
                    >
                      <RotateCcw className="h-3 w-3" />
                      {t('advanced.resetToDefaults')}
                    </Button>
                  )}
                </div>

              </div>
            </div>
          </div>
        </div>

      </div>

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
