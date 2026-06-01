import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Video, Mic, ShieldCheck, Square, Loader2, Settings2, ChevronUp, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useHotkeys } from 'react-hotkeys-hook'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AppShell } from '@/components/app-shell/app-shell'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { HelpIcon } from '@/components/help-icon'
import { WhisperModelManager } from '@/components/whisper-model-manager/whisper-model-manager'
import { TranscriptionAdvancedDialog } from '@/components/step1/transcription-advanced-dialog'
import { SubtitleStyleDialog } from '@/components/step1/subtitle-style-dialog'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { probeVideo, extractThumbnail } from '@/services/video'
import { openVideoDialog } from '@/services/dialog'
import { runTranscription } from '@/services/transcription'
import type { TranscriptionRun } from '@/services/transcription'
import { formatDuration } from '@/lib/time'
import { formatBytes } from '@/lib/format'
import type { SubtitleEntry as SubtitleEntryType, WhisperModelId } from '../../shared/types'
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
  // REQ-016: the source of truth for the seed-style fields is now
  // settingsStore.transcriptionDefaults; the Subtitle Style dialog edits
  // that slice directly.  handleStartTranscription snapshots settings →
  // projectStore.defaults below so step 2+ still see a frozen-at-start
  // copy regardless of subsequent settings edits.
  const setProjectDefaults = useProjectStore((s) => s.setDefaults)
  const transcriptionDefaults = useSettingsStore((s) => s.transcriptionDefaults)
  const defaultAudioTrackIndex = useSettingsStore((s) => s.defaultAudioTrackIndex)
  // transcriptionAdvanced is needed in handleStartTranscription to feed the
  // Whisper sidecar with the user's tweaked VAD / beam-size / language; the
  // dialog owns reads + writes for editing those fields, but step1 still
  // needs the value at run-time.
  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  // autoLineBreak is read here for the post-transcription line-break pass.
  // The toggle UI itself lives inside the Subtitle Style dialog so the
  // dialog can subscribe to setAutoLineBreak directly.
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const resetStep3Settings = useSettingsStore((s) => s.resetStep3Settings)

  const isLoading = videoLoadingState === 'loading'

  const [activeModelId, setActiveModelId] = useState<WhisperModelId | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState(0)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  const [advancedDialogOpen, setAdvancedDialogOpen] = useState(false)
  const [subtitleStyleDialogOpen, setSubtitleStyleDialogOpen] = useState(false)
  // Mutually-exclusive accordion section.  Exactly one of the two main
  // panels (Whisper model picker / Input video) is expanded at any time,
  // so the vertical budget stays predictable regardless of state.
  // Default to 'inputVideo' so the user lands on "pick a video" without
  // having to click anything; if no Whisper model is active they can
  // toggle to 'whisper' via the header.
  const [openSection, setOpenSection] = useState<'whisper' | 'inputVideo'>('inputVideo')
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

    // Snapshot the persistent defaults (settingsStore) into the project
    // store at the moment of transcribe-start.  Step 2 onward reads
    // projectStore.defaults to seed entries / preview / burn-in, so this
    // freezes "what the user wants for this run" without further coupling
    // to live settings edits.
    setProjectDefaults(transcriptionDefaults)
    // Reuse the just-snapshotted values directly so the segment-mapping
    // loop below doesn't need to wait for projectStore to re-render.
    const runDefaults = transcriptionDefaults

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
          fontSizePx: runDefaults.fontSizePx,
          textColorHex: runDefaults.textColorHex,
          outlineColorHex: runDefaults.outlineColorHex,
          outlineThicknessPx: runDefaults.outlineThicknessPx,
          fadeEnabled: runDefaults.fadeEnabled
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

    // Capture the active font ID at transcription time so subsequent
    // settings changes do not retroactively repaint already-transcribed rows.
    // Per-row font overrides (REQ-021) write this same field; rows with
    // `fontId === activeFontId` round-trip identically to legacy rows.
    const runFontId = useSettingsStore.getState().activeFontId

    // Build SubtitleEntry array from collected segments
    const entries: SubtitleEntryType[] = segments.map((seg, i) => {
      const base = {
        startSec: seg.startSec,
        endSec: seg.endSec,
        text: seg.text,
        fontSizePx: runDefaults.fontSizePx,
        textColorHex: runDefaults.textColorHex,
        outlineColorHex: runDefaults.outlineColorHex,
        outlineThicknessPx: runDefaults.outlineThicknessPx,
        fadeEnabled: runDefaults.fadeEnabled,
        fontId: runFontId
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
          // Per-row fontId (REQ-021): every transcribed row gets the
          // captured `runFontId`, so the break positions are measured
          // against that font's glyph metrics — important once the user
          // assigns mixed fonts to rows later, harmless when every row
          // uses the same font.
          const brokenText = applyAutoLineBreak(
            entry.text,
            entry.fontSizePx,
            entry.outlineThicknessPx,
            video.widthPx,
            font,
            entry.fontId
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

  // Footer right slot — split-button cluster on the idle path:
  //   [ Start transcription | ▼ ]
  // Left half is the primary action (kicks off Whisper exactly as before).
  // Right half opens the Subtitle Style dialog so users have a one-click
  // path to verify seed style at the moment of decision, without
  // requiring a separate trigger elsewhere in the layout.  Two adjacent
  // primary buttons share their background; the inner edges have their
  // rounded corner removed and a dark hairline divider sits between them
  // so the boundary is visually unambiguous.  During transcription the
  // caret is hidden and the main button collapses to a plain rounded
  // Cancel / Stop button — seed style is locked mid-run.
  const showStyleCaret = !isTranscribing
  const footerRight = (
    <div className="inline-flex items-stretch">
      <Button
        variant="primary"
        size="md"
        disabled={!isTranscribing && !canStart}
        onClick={isTranscribing ? handleCancelClick : handleStartTranscription}
        className={cn(showStyleCaret && 'rounded-r-none')}
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
      {showStyleCaret && (
        <Button
          variant="primary"
          size="md"
          onClick={() => setSubtitleStyleDialogOpen(true)}
          aria-label={t('subtitleStyle.openButton')}
          title={t('subtitleStyle.openButton')}
          // Caret half — narrow (icon-only), shares primary background
          // with the main button, no left-side rounding, and a
          // primary-foreground hairline divider (10 % opacity) so the
          // boundary reads clearly without introducing a fresh accent.
          // Both colours route through --primary / --primary-foreground
          // so a future light theme repaints the split button atomically.
          className="rounded-l-none border-l border-[hsl(var(--primary-foreground)/0.2)] px-2"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>
      )}
    </div>
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

        {/* Whisper model + Advanced (engine) trigger.  Subtitle Style
            does NOT live here — it is unrelated to the Whisper engine
            and sits next to the Start button in the footer instead. */}
        <div className={cn(
          'rounded-xl border border-border bg-card p-4 transition-opacity duration-200',
          (isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
        )}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <WhisperModelManager
                onActiveModelChange={setActiveModelId}
                disabled={isLoading || isTranscribing}
                isOpen={openSection === 'whisper'}
                onOpenChange={(open) => setOpenSection(open ? 'whisper' : 'inputVideo')}
              />
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

        {/* First-view body — only the must-touch cards remain visible
            here: pick a video, pick which audio track to transcribe.
            All seed-style controls + the live preview moved into the
            Subtitle Style dialog so the route stays scroll-free at
            1280×820 even on first launch with the Whisper accordion
            collapsed.  The `space-y-4` siblings render top-to-bottom in
            a single column. */}
        {/* Input video — single encompassing card holding (a) the path
            picker, (b) a small identification thumbnail + the video's
            technical metadata side-by-side, and (c) the audio-track
            selector below.  All "what to transcribe" decisions in one
            visual unit so the first view has a single primary surface
            plus the Whisper card above.

            The thumbnail here is purely an identification frame (no
            subtitle overlay) — the styled live preview belongs to the
            Subtitle Style dialog. */}
        <div className={cn(
          'rounded-xl border border-border bg-card p-4 transition-opacity duration-200',
          isTranscribing && 'opacity-50 pointer-events-none'
        )}>
          {/* Accordion header — clickable, toggles `openSection` to enforce
              mutual exclusion with the Whisper card above.  Clicking the
              header when this section is already open switches the
              expanded panel to 'whisper'; clicking when collapsed
              switches back here.  Either way exactly one panel is open. */}
          <div
            role="button"
            aria-expanded={openSection === 'inputVideo'}
            tabIndex={0}
            onClick={() =>
              setOpenSection(openSection === 'inputVideo' ? 'whisper' : 'inputVideo')
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setOpenSection(openSection === 'inputVideo' ? 'whisper' : 'inputVideo')
              }
            }}
            className="flex items-center justify-between cursor-pointer select-none hover:opacity-90 transition-opacity duration-150"
          >
            <div className="flex items-center gap-1.5">
              <Video className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <Label className="uppercase tracking-wider text-[10px] cursor-pointer">
                {t('inputVideo.label')}
              </Label>
              <span onClick={(e) => e.stopPropagation()}>
                <HelpIcon content={t('inputVideo.help')} />
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground/60">{t('inputVideo.hint')}</span>
              {openSection === 'inputVideo' ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              )}
            </div>
          </div>

          {/* Collapsible body — same animation pattern WhisperModelManager
              uses, so the two cards' open / close transitions feel like
              the same control. */}
          <AnimatePresence initial={false}>
            {openSection === 'inputVideo' && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="space-y-4 pt-3">
          {/* Path + Browse */}
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

          {/* Thumbnail + technical metadata side-by-side.  Fixed 16:9
              thumbnail container so portrait videos crop to the same
              identifying frame size; object-cover fills the box. */}
          <div className="grid grid-cols-[160px_1fr] gap-4 items-center">
            <div className="rounded-md border border-border bg-input aspect-video w-full overflow-hidden flex items-center justify-center">
              {thumbnail ? (
                <img src={thumbnail} alt="" className="w-full h-full object-cover" />
              ) : (
                <Video className="h-6 w-6 text-muted-foreground/40" />
              )}
            </div>
            <div className="divide-y divide-border/50">
              <InfoRow
                label={t('inputVideo.infoResolution')}
                value={video ? `${video.widthPx}×${video.heightPx}` : '—'}
              />
              <InfoRow
                label={t('inputVideo.infoDuration')}
                value={video ? formatDuration(video.durationSec) : '—'}
              />
              <InfoRow
                label={t('inputVideo.infoFormat')}
                value={video ? `${video.container.toUpperCase()} / ${video.videoCodec} / ${video.fps}fps` : '—'}
              />
              <InfoRow
                label={t('inputVideo.infoFileSize')}
                value={video ? formatBytes(video.fileSizeBytes) : '—'}
              />
            </div>
          </div>

          {/* Audio tracks — absorbed into this card.  Internal divider
              instead of a separate card so the picker reads as part of
              "the video you've chosen" rather than a parallel concept.
              Disabled until a video is loaded. */}
          <div className={cn(
            'border-t border-border/50 pt-3 space-y-3 transition-opacity duration-150',
            !video && 'opacity-50 pointer-events-none'
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
                    // Compact layout — name and spec sit on a single line
                    // with the indicator dot on the left so 6+ tracks fit
                    // without the card sprawling.  The "transcription
                    // target" badge moves inline at the right edge instead
                    // of absolute-positioned, freeing the row's vertical
                    // budget.
                    'flex items-center gap-2 rounded-md border px-3 py-1.5 text-left transition-colors duration-150',
                    selectedTrack === track.index
                      ? 'border-primary/50 bg-primary/5'
                      : 'border-border hover:bg-accent/40'
                  )}
                >
                  <span className="h-2 w-2 rounded-full flex-shrink-0 bg-primary" />
                  <span className={cn(
                    'text-[13px] font-medium flex-shrink-0',
                    selectedTrack === track.index ? 'text-primary' : 'text-foreground'
                  )}>
                    {t('audioTracks.trackLabel', { index: track.index })}
                  </span>
                  <span className="text-[11px] text-muted-foreground truncate min-w-0">
                    {`${track.channels} · ${track.sampleRateHz / 1000}kHz · ${track.codec}`}
                  </span>
                  {selectedTrack === track.index && (
                    <Badge variant="success" className="ml-auto flex-shrink-0">
                      {t('audioTracks.transcriptionTarget')}
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

      </div>

      {/* Dialogs.  Both are mounted unconditionally and gated on `open` —
          Radix unmounts the content while closed so there is no idle
          render cost.  Subtitle Style covers seed style + live preview;
          Advanced covers Whisper engine knobs (VAD / Recognition). */}
      <SubtitleStyleDialog
        open={subtitleStyleDialogOpen}
        onOpenChange={setSubtitleStyleDialogOpen}
        thumbnail={thumbnail}
      />
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
