import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { FolderOpen, Video, Mic, ShieldCheck, Square, Loader2, ChevronUp, ChevronDown, AudioWaveform, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
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
import { TranscriptionDrawer } from '@/components/step1/transcription-drawer'
import { SubtitleStyleDialog } from '@/components/step1/subtitle-style-dialog'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { useHistoryStore } from '@/stores/history-store'
import { probeVideo, extractThumbnail } from '@/services/video'
import { openVideoDialog } from '@/services/dialog'
import { runTranscription } from '@/services/transcription'
import type { TranscriptionRun } from '@/services/transcription'
import { formatDuration } from '@/lib/time'
import { formatBytes } from '@/lib/format'
import type { SubtitleEntry as SubtitleEntryType, WhisperModelId } from '../../shared/types'
import { makeEntryLayoutDefaults } from '../../shared/burnin-defaults'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { pickInitialOpenSection } from './step1-initial-open'
import { pickTranscriptionTrack } from './step1-track-pick'
import { pickAudioTrackLabel } from '@/lib/audio-track-label'

function InfoRow({ label, value }: { label: string; value: string }) {
  // REQ-071 Phase 3.5: value bumped to `body` (15) so it physically reads as
  // the primary info on the row.  Label stays `callout` (13/semibold + muted)
  // as the supporting category marker.  Hierarchy now is:
  //   - size : value (15) > label (13)
  //   - color: value (foreground) > label (muted)
  //   - weight: label (semibold) carries category emphasis without
  //             out-shouting the value
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-callout font-semibold text-muted-foreground">{label}</span>
      <span className="text-body text-foreground font-mono tabular-nums">{value}</span>
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
  const isAudioOnly = useIsAudioOnly()
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
  // REQ-20260615-050 — fade duration is the only style field that lives
  // outside `transcriptionDefaults` (it shares the settings-store slot
  // with the General-tab slider that drives all three surfaces).  Read
  // it here so the per-entry `fadeDurationSec` seeded onto transcribed
  // rows comes from the same source the user controls in Settings.
  const settingsFadeDurationSec = useSettingsStore((s) => s.fadeDurationSec)
  const defaultAudioTrackIndex = useSettingsStore((s) => s.defaultAudioTrackIndex)
  // REQ-0121 — user-preferred default input folder used when the current
  // session has no MRU yet (first browse after launch).  `null` = fall
  // through to the OS Videos folder, resolved on the main side.
  const defaultInputDir = useSettingsStore((s) => s.defaultInputDir)
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
  const [subtitleStyleDialogOpen, setSubtitleStyleDialogOpen] = useState(false)
  // REQ-20260615-055 — STEP1 now uses a right-sliding drawer for the
  // "confirm advanced settings + pick track + run" leg, mirroring
  // STEP2's burnin-drawer.  Pre-REQ the footer Start button kicked off
  // `handleStartTranscription` directly; it now opens this drawer and
  // the drawer's own Start button is the run trigger.
  const [transcriptionDrawerOpen, setTranscriptionDrawerOpen] = useState(false)
  // Drawer render state — idle while configuring, running during the
  // ffmpeg/Whisper pipeline, error if the run failed (cancel returns
  // to idle so the user can adjust + retry without reopening).
  const [drawerRenderState, setDrawerRenderState] = useState<'idle' | 'running' | 'error'>('idle')
  const [drawerErrorMessage, setDrawerErrorMessage] = useState('')
  // Mutually-exclusive accordion section.  Exactly one of the two main
  // panels (Whisper model picker / Input video) is expanded at any time,
  // so the vertical budget stays predictable regardless of state.
  //
  // REQ-20260615-072: initial value is `null` until the first
  // listModels IPC settles.  The first call to `handleActiveModelChange`
  // below picks 'whisper' (when no model is installed) or 'inputVideo'
  // (when a model is already usable) — see `pickInitialOpenSection`.
  // Both panels render closed during the few-ms IPC roundtrip; this
  // avoids the flash that a hardcoded 'inputVideo' default would cause
  // for first-time users we then need to flip to 'whisper'.
  //
  // Pre-REQ-072 the default was hardcoded to 'inputVideo', which left
  // brand-new users with no installed model staring at the input-video
  // card instead of the model download flow that actually unblocks them.
  // The amber AlertTriangle on the collapsed Whisper header was the
  // documented substitute for the old auto-expand-on-no-model behaviour
  // (see WhisperModelManager:135-149), but in practice it didn't draw
  // the eye strongly enough — REQ-072 restores the auto-expand for the
  // no-model case only.  Once a user has any model installed they keep
  // landing on inputVideo, matching the prior "skip past picker on the
  // happy path" intent.
  const [openSection, setOpenSection] = useState<'whisper' | 'inputVideo' | null>(null)
  // Set on the first `handleActiveModelChange` callback, OR when the
  // user toggles the accordion header before that callback arrives.
  // Subsequent listModels-triggered callbacks (after install / uninstall
  // / activate flows inside WhisperModelManager) MUST NOT clobber a
  // user-driven open state — the ref guards that.
  const initialOpenDecidedRef = useRef(false)

  const handleActiveModelChange = useCallback(
    (modelId: WhisperModelId | null) => {
      setActiveModelId(modelId)
      if (!initialOpenDecidedRef.current) {
        initialOpenDecidedRef.current = true
        setOpenSection(pickInitialOpenSection(modelId))
      }
    },
    []
  )

  const handleAccordionToggle = useCallback(
    (next: 'whisper' | 'inputVideo') => {
      // Mark the initial decision as taken so a later listModels
      // callback (post-install/uninstall) can't override what the user
      // just chose by hand.
      initialOpenDecidedRef.current = true
      setOpenSection(next)
    },
    []
  )

  const transcriptionRunRef = useRef<TranscriptionRun | null>(null)

  // REQ-082: removed Enter-to-start-transcription hotkey.

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
    // REQ-0121 — MRU wins (same-session continuity when opening video after
    // video), else fall back to the user-preferred default input folder,
    // else the main-side handler resolves the OS Videos folder.
    const lastDir = video?.path
      ? video.path.replace(/[\\/][^\\/]+$/, '')
      : (defaultInputDir ?? undefined)
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

    // REQ-0121 — audio-track fallback ladder.  See step1-track-pick.ts.
    //   preferred exists          → use it, no notice
    //   preferred missing, T1 ok  → use Track 1, non-blocking toast
    //   nothing usable            → leave selection empty (existing "no
    //                               audio track" flow handles it)
    const picked = pickTranscriptionTrack(info.audioTracks, defaultAudioTrackIndex)
    if (picked.trackIndex !== null) {
      setSelectedTrack(picked.trackIndex)
      if (picked.fallbackUsed) {
        toast.info(t('audioTracks.defaultTrackMissing', {
          index: defaultAudioTrackIndex,
          fallback: picked.trackIndex
        }))
      }
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
    // REQ-20260615-055 — drive the drawer's render state too so the
    // body switches from the configuration form to the spinner /
    // progress bar / error panel as the run progresses.
    setDrawerRenderState('running')
    setDrawerErrorMessage('')
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
          fadeDurationSec: settingsFadeDurationSec,
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
    let errorReason: string | null = null
    try {
      await run.promise
    } catch (err) {
      const msg = String(err)
      if (msg.includes('Cancelled')) {
        cancelled = true
        toast.info(t('toast.transcriptionCancelled'))
      } else {
        toast.error(t('toast.transcriptionError', { error: msg }))
        errorReason = msg
      }
    } finally {
      setIsTranscribing(false)
      transcriptionRunRef.current = null
      window.electronAPI.menuSetTranscribing(false)
    }

    if (cancelled) {
      // Back to idle so the user can adjust the form and re-run without
      // having to reopen the drawer.
      setDrawerRenderState('idle')
      return
    }
    if (errorReason !== null) {
      // Surface the failure inside the drawer's error panel; the toast
      // already fired above so the user has both surfaces in case the
      // toast was missed.
      setDrawerRenderState('error')
      setDrawerErrorMessage(errorReason)
      return
    }

    // Capture the active font ID at transcription time so subsequent
    // settings changes do not retroactively repaint already-transcribed rows.
    // Per-row font overrides (REQ-021) write this same field; rows with
    // `fontId === activeFontId` round-trip identically to legacy rows.
    const runFontId = useSettingsStore.getState().activeFontId

    // Build SubtitleEntry array from collected segments
    const entries: SubtitleEntryType[] = segments.map((seg, i) => {
      // REQ-20260613-016 / v1.2.2 機能A: every transcribed row carries its
      // own layout + background values seeded from ENTRY_LAYOUT_DEFAULTS
      // (= BURNIN_DEFAULTS).  `makeEntryLayoutDefaults` returns a fresh
      // object literal per call so each row owns its own subtitleBackground
      // — mutating one row never aliases another.
      const base = {
        startSec: seg.startSec,
        endSec: seg.endSec,
        text: seg.text,
        fontSizePx: runDefaults.fontSizePx,
        textColorHex: runDefaults.textColorHex,
        outlineColorHex: runDefaults.outlineColorHex,
        outlineThicknessPx: runDefaults.outlineThicknessPx,
        fadeDurationSec: settingsFadeDurationSec,
        fontId: runFontId,
        ...makeEntryLayoutDefaults()
      }
      return {
        id: `t-${i}-${Date.now()}`,
        ...base,
        isDeleted: false,
        isEdited: false,
        // Deep-copy the nested subtitleBackground so the live entry and
        // its `original` snapshot don't share object identity (otherwise
        // an inline edit would also mutate the reset target).
        original: { ...base, subtitleBackground: { ...base.subtitleBackground } }
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

    // REQ-091: a fresh (or repeated) transcription means a fresh
    // editing session.  Clear the cut list, any in-flight trim toolbar
    // points, and undo/redo history; reset Step 2/3 layout + background
    // settings to BURNIN_DEFAULTS so the user lands in Step 2 with no
    // carry-over from the previous edit.  Per-entry styles do not need
    // an explicit clear — `setEntries(finalEntries)` immediately below
    // overwrites the entry array with brand-new entries seeded from
    // `runDefaults`, so the old entries' fontSize / colour / fade /
    // fontId edits cannot survive.
    //
    // Placement note (REQ-092 audit): the 4 resets sit AFTER the
    // post-cancel `if (cancelled) return` above (line ~227), but
    // crucially NOT because we are protecting a recoverable
    // "cancelled-transcription preserves prior session" path — no
    // such path exists.  From Step 1, the breadcrumb
    // (`breadcrumb.tsx:64-66`, `isCompleted = step < currentStep`)
    // disables the Step 2 button because `step1.tsx`'s
    // `currentStep={1}` makes Step 2 isFuture, and Step 1 has no
    // other forward navigate beyond the `navigate('/step2')` at
    // line ~317 below.  So a cancelled run leaves projectStore
    // stale on Step 1, but the user can ONLY reach Step 2 by
    // re-running transcription — which re-enters this same block
    // and wipes the stale state.  The "after cancel-check"
    // placement is kept for code locality: these 4 resets and
    // `setEntries` form one logical "commit transcription
    // success" block, and keeping them together makes the
    // invariant "fresh transcription ⇒ fresh editing state"
    // locally obvious.
    useProjectStore.getState().setCuts([])
    useUiStore.getState().clearPendingCut()
    useHistoryStore.getState().clear()
    resetStep3Settings()

    // REQ-20260615-064 A — overrides the REQ-063 keep-on-STEP-1 path.
    // Zero-segment runs are a normal flow: the user is allowed to
    // transcribe a silent / no-speech track and then build the
    // subtitle list manually with the "追加" button.  So treat zero
    // segments as a successful completion and proceed to STEP 2 with
    // an empty `entries` array.  The drawer's success toast is
    // suppressed in that case — STEP 2 surfaces a single-shot
    // "発話を検出できませんでした" hint on mount instead so the
    // notification lives next to the editor it is talking about
    // (`lastTranscriptionWasEmpty` flag in ui-store; STEP 2 reads &
    // clears it on mount).
    setEntries(finalEntries)
    if (finalEntries.length === 0) {
      useUiStore.getState().setLastTranscriptionWasEmpty(true)
    } else {
      toast.success(t('toast.transcriptionComplete', { count: finalEntries.length }))
    }
    // REQ-20260615-055 — close the drawer + reset its state before the
    // route change so the next time the user lands on STEP1 the drawer
    // opens clean in the `idle` state.
    setTranscriptionDrawerOpen(false)
    setDrawerRenderState('idle')
    setDrawerErrorMessage('')
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
    /* REQ-067 phase B: status colors lifted from text-fg-muted to
       text-fg-secondary so the model-status and privacy line stay legible
       in the chrome.  Matches the same treatment in step2 / step3. */
    <div className="flex items-center gap-4">
      <span className="text-body-sm text-fg-secondary">
        {activeModelId
          ? t('footer.modelStatus', { model: activeModelId })
          : t('footer.modelNotDownloaded', { model: '—' })}
      </span>
      <span className="w-px h-3 bg-surface-3 flex-shrink-0" />
      <span className="flex items-center gap-1.5 text-body-sm text-fg-secondary">
        <ShieldCheck className="h-3.5 w-3.5 flex-shrink-0" />
        {t('footer.privacyNote')}
      </span>
    </div>
  )

  // Footer right slot — split-button cluster on the idle path:
  //   [ Start transcription | ▼ ]
  // REQ-20260615-055: the Start half no longer runs Whisper directly.
  // It now opens the TranscriptionDrawer where the user confirms advanced
  // settings + audio track and presses the drawer's own Start button.
  // The caret half still opens the Subtitle Style dialog for one-click
  // seed-style verification.  During transcription the caret is hidden
  // and the main button collapses to a plain rounded Cancel button —
  // seed style is locked mid-run.
  // REQ-028: also hidden in audio-only mode — there is no burn-in step
  // for audio, so the seed-style dialog has no consumer.
  const showStyleCaret = !isTranscribing && !isAudioOnly
  const footerRight = (
    <div className="inline-flex items-stretch">
      <Button
        variant="primary"
        size="md"
        disabled={!isTranscribing && !canStart}
        onClick={isTranscribing ? handleCancelClick : () => setTranscriptionDrawerOpen(true)}
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
          <h1 className="text-heading font-semibold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-body text-muted-foreground">{t('guidance')}</p>
        </div>

        {/* Whisper model + Advanced (engine) trigger.  Subtitle Style
            does NOT live here — it is unrelated to the Whisper engine
            and sits next to the Start button in the footer instead.
            REQ-20260615-020: the Advanced button was retired in favour of
            the gear icon that WhisperModelManager renders inline in its
            own header; step1 just forwards a callback. */}
        <div className={cn(
          'rounded-xl border border-border bg-card p-4 transition-opacity duration-200',
          (isLoading || isTranscribing) && 'opacity-50 pointer-events-none'
        )}>
          {/* REQ-20260615-055 — the gear-icon "詳細設定" trigger was
              retired here.  The advanced controls now live inside the
              TranscriptionDrawer that opens from the footer Start
              button, so STEP1's main screen carries only the model
              picker + input file + read-only track list. */}
          <WhisperModelManager
            onActiveModelChange={handleActiveModelChange}
            disabled={isLoading || isTranscribing}
            isOpen={openSection === 'whisper'}
            onOpenChange={(open) => handleAccordionToggle(open ? 'whisper' : 'inputVideo')}
          />
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
          {/* REQ-082: Enter / Space keyboard activation removed. */}
          {/* REQ-20260615-079: header right side now shows the audio-track
              **inventory** for the loaded file (count, or "no audio"),
              not the currently-selected track.  Track selection itself
              moved into the TranscriptionDrawer per REQ-055/056, so a
              "selected track" indicator here was stale.  Nothing
              renders when no file is loaded — the prior "トラック未選択"
              placeholder was just noise.  See `pickAudioTrackLabel`. */}
          <div
            role="button"
            aria-expanded={openSection === 'inputVideo'}
            tabIndex={0}
            onClick={() =>
              handleAccordionToggle(openSection === 'inputVideo' ? 'whisper' : 'inputVideo')
            }
            className="flex items-center justify-between cursor-pointer select-none hover:opacity-90 transition-opacity duration-150"
          >
            <div className="flex items-center gap-1.5">
              <Video className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <Label className="cursor-pointer">
                {t('inputVideo.label')}
              </Label>
              <span onClick={(e) => e.stopPropagation()}>
                <HelpIcon content={t('inputVideo.help')} />
              </span>
            </div>
            <div className="flex items-center gap-2">
              {(() => {
                const labelState = pickAudioTrackLabel(video ? audioTracks.length : null)
                if (labelState.kind === 'hidden') return null
                return (
                  <>
                    <span className="text-body-sm text-fg-secondary">
                      {labelState.kind === 'no-audio'
                        ? t('audioTracks.noAudioTrack')
                        : t('audioTracks.audioTrackCount', { count: labelState.count })}
                    </span>
                    {/* REQ-20260615-080 — positive-detection check.  Shown
                        only when N ≥ 1 (the "we found usable audio" case),
                        NOT for 0 / hidden.  Identical Check element +
                        Tailwind class triple as the Whisper accordion's
                        active-model check (whisper-model-manager.tsx:309)
                        so the two greens in this route's two headers
                        track each other exactly — same icon, same
                        `text-primary`, same h-4 w-4.  Decorative; the
                        adjacent text already conveys the count to AT, so
                        aria-hidden mirrors the pre-REQ-079 treatment. */}
                    {labelState.kind === 'count' && (
                      <Check className="h-4 w-4 text-primary flex-shrink-0" aria-hidden="true" />
                    )}
                  </>
                )
              })()}
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
          {/* REQ-20260615-020: supported file-format hint moved here from
              the header.  Right-aligned, muted, so it reads as a small
              reference line rather than the primary content. */}
          <div className="flex justify-end">
            <span className="text-caption text-fg-muted">
              {t('inputVideo.hint')}
            </span>
          </div>
          {/* Path + Browse */}
          {isLoading ? (
            <div className="flex items-center gap-2.5 h-9 px-1">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground flex-shrink-0" />
              <span className="text-body text-muted-foreground">{t('inputVideo.loading')}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1 h-9 rounded-md border border-border bg-input px-3.5 flex items-center min-w-0">
                <span className={cn(
                  'text-body truncate',
                  video ? 'text-foreground' : 'text-muted-foreground/60'
                )}>
                  {video?.path ?? t('inputVideo.placeholder')}
                </span>
              </div>
              {/* REQ-072 Q4: secondary's `bg-surface-inverse-0` white slab dominated the
                  STEP 1 input row visually — same pattern bulk-edit-bar already
                  flagged (see comment there).  Pending the full Button variant
                  redesign (REQ-073), this single site is overridden to a tonal
                  (bg-surface-2) treatment so Browse reads as a secondary action
                  in the dark theme without claiming primary emphasis. */}
              <Button
                variant="secondary"
                size="md"
                onClick={handleBrowse}
                className="bg-surface-2 text-fg-primary hover:bg-surface-3 active:bg-surface-4"
              >
                <FolderOpen className="h-4 w-4 mr-1.5" />
                {t('inputVideo.chooseVideo')}
              </Button>
            </div>
          )}

          {/* Thumbnail + technical metadata side-by-side.
              REQ-028: in audio-only mode (no video stream) the left box
              shows an AudioWaveform icon instead of the video frame, and
              the Resolution row drops out — those fields carry no
              meaning for pure audio inputs.  Format row also collapses
              from "MP4 / h264 / 30fps" to "MP3 / mp3" since fps /
              videoCodec are placeholders.
              REQ-044 #1: the box used to be aspect-video (16:9 fixed) +
              object-cover, which centre-cropped vertical (9:16) sources
              to a horizontal band, making them look like horizontal
              videos in the thumbnail.  Now the box follows the video's
              own aspect ratio (clamped to a 240×180 envelope so neither
              orientation dominates the card layout), and the <img> uses
              object-contain so any sub-pixel mismatch produces letter-
              boxing rather than crop. */}
          <div className="grid grid-cols-[auto_1fr] gap-4 items-center">
            <div
              className="rounded-md border border-border bg-input overflow-hidden flex items-center justify-center flex-shrink-0"
              style={(() => {
                // REQ-045 #1: envelope bumped from 240×180 → 280×240 so
                // vertical sources stretch closer to the InfoRow stack's
                // own height while horizontal stays inside the card.
                // Behaviour by ratio:
                //   - 16:9 → 280×157 (width-bound; ~33 % bigger than the
                //            previous 240×135)
                //   - 9:16 → 135×240 (height-bound; ~78 % bigger area
                //            than the previous 101×180)
                //   - 1:1  → 240×240
                // Audio-only and pre-load both fall back to 16:9 so the
                // empty/waveform state stays at 280×157.
                const MAX_W = 280
                const MAX_H = 240
                const ratio =
                  (!isAudioOnly && video && video.widthPx > 0 && video.heightPx > 0)
                    ? video.widthPx / video.heightPx
                    : 16 / 9
                const widthBound = MAX_H * ratio > MAX_W
                return widthBound
                  ? { width: `${MAX_W}px`, height: `${MAX_W / ratio}px` }
                  : { width: `${MAX_H * ratio}px`, height: `${MAX_H}px` }
              })()}
            >
              {isAudioOnly ? (
                <AudioWaveform className="h-8 w-8 text-muted-foreground/60" />
              ) : thumbnail ? (
                <img src={thumbnail} alt="" className="w-full h-full object-contain" />
              ) : (
                <Video className="h-6 w-6 text-muted-foreground/40" />
              )}
            </div>
            <div className="divide-y divide-border/50">
              {!isAudioOnly && (
                <InfoRow
                  label={t('inputVideo.infoResolution')}
                  value={video ? `${video.widthPx}×${video.heightPx}` : '—'}
                />
              )}
              <InfoRow
                label={t('inputVideo.infoDuration')}
                value={video ? formatDuration(video.durationSec) : '—'}
              />
              <InfoRow
                label={t('inputVideo.infoFormat')}
                value={
                  !video
                    ? '—'
                    : isAudioOnly
                      ? `${video.container.toUpperCase()} / ${video.audioTracks[0]?.codec ?? '—'}`
                      : `${video.container.toUpperCase()} / ${video.videoCodec} / ${video.fps}fps`
                }
              />
              <InfoRow
                label={t('inputVideo.infoFileSize')}
                value={video ? formatBytes(video.fileSizeBytes) : '—'}
              />
            </div>
          </div>

          {/* REQ-20260615-055 / REQ-20260615-056 — main-screen audio
              tracks card.  Collapsed to a single summary header:
              `[Mic] 音声トラック   Nトラック検出 (or 検出無し)`.  The
              description, the per-track list, and the "対象" badge
              were retired here — the actual selection happens inside
              the TranscriptionDrawer.  Disabled tone (opacity-50)
              until a video is loaded; the row sits on a top divider
              so it still reads as part of the "video you've chosen"
              card. */}
          <div className={cn(
            'border-t border-border/50 pt-3 transition-opacity duration-150',
            !video && 'opacity-50 pointer-events-none'
          )}>
            <div className="flex items-center gap-1.5">
              <Mic className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <Label>{t('audioTracks.label')}</Label>
              <HelpIcon content={t('audioTracks.help')} />
              <Badge variant="muted">
                {audioTracks.length > 0
                  ? t('audioTracks.tracksDetected', { count: audioTracks.length })
                  : t('audioTracks.notDetected')}
              </Badge>
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
      {/* REQ-20260615-055 — right-sliding drawer for the run leg.
          Hosts the Whisper advanced controls + audio-track selection
          + Start / Cancel.  See `transcription-drawer.tsx` for the
          lifecycle that mirrors STEP2's burnin-drawer. */}
      <TranscriptionDrawer
        open={transcriptionDrawerOpen}
        onOpenChange={setTranscriptionDrawerOpen}
        audioTracks={audioTracks}
        renderState={drawerRenderState}
        progress={transcribeProgress}
        errorMessage={drawerErrorMessage}
        canStart={canStart}
        onStart={handleStartTranscription}
        onCancel={handleCancelClick}
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
              className="bg-destructive-hover hover:bg-destructive text-white"
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
