import { useState, useEffect, useRef, useCallback } from 'react'
import { animationFieldsForNewCue } from '../../shared/cue-animation'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { AppShell } from '@/components/app-shell/app-shell'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { WhisperModelManager } from '@/components/whisper-model-manager/whisper-model-manager'
import { TranslationToolManager } from '@/components/translation-tool-manager/translation-tool-manager'
import { GpuToolManager } from '@/components/gpu-tool-manager/gpu-tool-manager'
import { TranscriptionDrawer } from '@/components/step1/transcription-drawer'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { useHistoryStore } from '@/stores/history-store'
import { usePreviewMixStore } from '@/stores/preview-mix-store'
import { probeVideo, extractThumbnail } from '@/services/video'
import { openVideoDialog } from '@/services/dialog'
import { runTranscription } from '@/services/transcription'
import type { TranscriptionRun } from '@/services/transcription'
import type { SubtitleEntry as SubtitleEntryType, WhisperModelId } from '../../shared/types'
import { makeEntryLayoutDefaults } from '../../shared/burnin-defaults'
import { isSupportedMediaPath } from '../../shared/constants'
import { styleFieldsFromDefaults } from '@/lib/style-defaults-to-entry'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { pickInitialOpenSection } from './step1-initial-open'
import { pickTranscriptionTrack } from '../../shared/track-pick'

// REQ-0185 §3 — `appVersion` prop dropped alongside the removed
// top breadcrumb.  About dialog still shows the version.
interface Step1RouteProps {}

export default function Step1Route(_: Step1RouteProps) {
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
  // REQ-0540 — a new cue gets the SAME parameters タブ2 displays: the memory
  // first, then the saved defaults, then the fixed table.
  const animationMemory = useSettingsStore((s) => s.animationMemory)
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
  // REQ-086 — drawer phase override.  Whisper run starts at 'whisper';
  // when the main process emits the `phase: 'preview-mix'` event the
  // label switches to "音声準備中…" while the amix ffmpeg pass runs.
  // The progress bar bar stays full (100 %) during the mix step since
  // it has no per-frame progress events; the loader spinner + new
  // label communicates that the run is still in flight.
  const [transcribePhase, setTranscribePhase] = useState<'whisper' | 'preview-mix'>('whisper')
  // REQ-0142 — pre-Whisper preparation phase from the sidecar (RES-0141
  // §1 phases 3, 5, 6).  Null while Whisper inference is producing
  // real progress events, or when the run is not active.  The drawer
  // uses this to render an indeterminate bar + phase-specific label
  // + elapsed timer, replacing the pre-REQ-0142 stuck "0%" bar.
  const [preparingPhase, setPreparingPhase] = useState<
    'extractAudio' | 'loadModel' | 'prepass' | null
  >(null)
  // REQ-0142 — Start-click timestamp (ms) and a live tick that drives
  // the drawer's elapsed display.  Rendered as `mm:ss` inside the
  // drawer; the timer runs entirely renderer-side so no sidecar
  // change is needed to keep the display moving during the prep
  // region.  Reset back to `null` when the run finishes / fails /
  // cancels so an idle drawer never shows leftover elapsed digits.
  const [transcribeStartMs, setTranscribeStartMs] = useState<number | null>(null)
  const [nowTick, setNowTick] = useState<number>(0)
  useEffect(() => {
    if (transcribeStartMs === null) return
    // Half-second tick keeps the seconds field visually smooth without
    // burning a full RAF budget.  The renderer subscribes to
    // `nowTick` implicitly via the `elapsedSec` calc below.
    const id = window.setInterval(() => setNowTick(Date.now()), 500)
    return () => window.clearInterval(id)
  }, [transcribeStartMs])
  const elapsedSec = transcribeStartMs !== null
    ? Math.max(0, Math.floor((Math.max(nowTick, Date.now()) - transcribeStartMs) / 1000))
    : 0
  // REQ-0145 — device info from the sidecar's `deviceInfo` event.
  // `null` until the sidecar reports which device the WhisperModel
  // constructor actually used (cuda vs cpu, and whether it fell back
  // from a failed cuda attempt).  Owner uses this to verify GPU
  // engagement without needing to open the dev-terminal.
  const [deviceInfo, setDeviceInfo] = useState<
    { device: 'cuda' | 'cpu'; computeType: string; fellBack: boolean } | null
  >(null)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [showCancelDialog, setShowCancelDialog] = useState(false)
  // REQ-20260615-055 — STEP1 now uses a right-sliding drawer for the
  // "confirm advanced settings + pick track + run" leg, mirroring
  // STEP2's burnin-drawer.  Pre-REQ the footer Start button kicked off
  // `handleStartTranscription` directly; it now opens this drawer and
  // the drawer's own Start button is the run trigger.
  const [transcriptionDrawerOpen, setTranscriptionDrawerOpen] = useState(false)
  // REQ-0207 — experimental word-level subtitle re-split.  Non-persisted:
  // the user has to opt in every time the drawer opens.  This is deliberate
  // — the checkbox is labelled "experimental" and we do not want it to
  // silently stick between projects.  Reset happens in the useEffect below,
  // which fires as soon as the drawer transitions to closed.
  const [wordSubtitleOn, setWordSubtitleOn] = useState(false)
  useEffect(() => {
    if (!transcriptionDrawerOpen) setWordSubtitleOn(false)
  }, [transcriptionDrawerOpen])
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
  // REQ-0152 §2 — single-open accordion across Whisper model / Processing
  // device / Input video.  Widened from the pre-REQ-0152 binary
  // `'whisper' | 'inputVideo'` union so the newly-promoted device
  // accordion joins the mutual-exclusion group; `null` is the "all
  // closed" state the REQ explicitly allows.
  const [openSection, setOpenSection] = useState<'whisper' | 'device' | 'translation' | 'inputVideo' | null>(null)
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
    await loadVideoFromPath(filePath)
  }

  // REQ-0423 — drag & drop entry point for the drawer's タブ1 drop zone.
  // Merges into the exact same load path as the picker; the only extra step
  // is an extension gate (D&D can deliver anything) using the shared media
  // list, so an unsupported drop is rejected with a toast instead of a
  // confusing ffprobe error.
  function handleDropFile(filePath: string) {
    if (!isSupportedMediaPath(filePath)) {
      toast.error(t('toast.unsupportedFile'))
      return
    }
    void loadVideoFromPath(filePath)
  }

  // REQ-0423 — the "load a chosen path" leg of handleBrowse, extracted so
  // both the file picker and drag & drop reuse the identical probe / reset /
  // thumbnail / track-pick sequence.
  async function loadVideoFromPath(filePath: string) {
    setVideoLoadingState('loading')
    setThumbnail(null)
    // REQ-086 — drop any previously-generated preview mix URL the moment
    // a fresh video is picked.  The mix file on disk still belongs to the
    // prior source, so until a new transcription run finishes the preview
    // must fall back to `<video>`-only audio rather than play stale audio
    // over the new visuals.
    usePreviewMixStore.getState().clear()
    // REQ-0196 §1 — defensive clear of the step2-produced editing state
    // (entries + cuts) before hydrating the new video.  The back-discard
    // handler in step2 already clears these when the user hits "OK", but
    // that path is only taken in one flow — a project-open that landed
    // on step1 (REQ-0195 branching) or a first-launch step1 could still
    // hold entries in the Zustand store from an earlier session pattern.
    // Picking a new video means the old subtitles are always stale.
    // History is cleared too so Ctrl+Z can't rewind into the old set;
    // ui selection follows.  Same "keep video + track + defaults" line
    // as the discard handler — but we're about to replace `video`
    // anyway a few lines below.
    useProjectStore.getState().resetEditingState()
    useHistoryStore.getState().clear()
    const ui = useUiStore.getState()
    ui.setSelectedEntryId(null)
    ui.setRowSelection(new Set())
    ui.setFocusedRowId(null)
    ui.setScrollToRowId(null)
    ui.setVideoCurrentTimeSec(0)
    ui.setVideoSeekRequest(null)

    const result = await probeVideo(filePath)
    if (!result.ok) {
      setVideoLoadingState('idle')
      toast.error(t('toast.probeError', { error: result.error.message }))
      return
    }

    const info = result.data
    setVideo(info)

    // REQ-0436 — pick the default audio track in the SAME synchronous tick as
    // `setVideo`, so React batches both into one render.  Previously the pick
    // ran only after the `await extractThumbnail` below, so the new video
    // rendered first with the STALE selection (e.g. track 2 from the prior
    // video / a hydrated default), which the drawer showed until the pick
    // landed — the reported "track 2 → track 1" flicker.  Setting the default
    // now means the drawer's autoselect effect already sees a valid selection
    // and skips, and no intermediate track is ever shown.
    //
    // REQ-0121 — audio-track fallback ladder.  See shared/track-pick.ts.
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

    // Extract thumbnail as part of the loading sequence
    try {
      const thumbResult = await extractThumbnail(info.path, 1)
      if (thumbResult.ok) setThumbnail(thumbResult.data)
    } catch {
      // thumbnail is optional
    }

    setVideoLoadingState('loaded')
    toast.success(t('toast.videoLoaded'))
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

    // REQ-086 — clear any prior preview-mix URL before the run starts so
    // a failure mid-run leaves the editor without a stale URL pointing at
    // whatever video was transcribed before.  The success path below
    // re-populates it with the freshly-generated mix.
    usePreviewMixStore.getState().clear()
    setIsTranscribing(true)
    setTranscribeProgress(0)
    setTranscribePhase('whisper')
    // REQ-0142 — pin the initial prep label so the drawer never shows
    // an empty state during the ~50-ms gap between Start click and
    // the first sidecar `phase: 'extractAudio'` event.  Also start the
    // elapsed timer here (renderer-side) — the sidecar does not emit
    // ticks.
    setPreparingPhase('extractAudio')
    setTranscribeStartMs(Date.now())
    // REQ-0145 — clear the previous run's device chip so a fresh Start
    // never carries stale info across runs.
    setDeviceInfo(null)
    // REQ-20260615-055 — drive the drawer's render state too so the
    // body switches from the configuration form to the spinner /
    // progress bar / error panel as the run progresses.
    setDrawerRenderState('running')
    setDrawerErrorMessage('')
    window.electronAPI.menuSetTranscribing(true)

    // REQ-0285 — collected segments now carry an optional `words` array
    // (per-word timestamps from faster-whisper).  Type mirrors the IPC
    // contract (`ipc-contracts.ts:TranscriptionEvent`) so the compiler
    // catches any drift between wire shape and this local buffer.
    const segments: { startSec: number; endSec: number; text: string; words?: import('../../shared/types').WordSpan[] }[] = []
    let previewMixUrl: string | null = null

    const run = runTranscription(
      {
        videoPath: video.path,
        trackIndex: selectedTrack,
        // REQ-086 — main needs the total track count to decide whether
        // to spawn the post-Whisper amix pass.  Passing it from here
        // avoids a re-probe in the main process and keeps the cancel
        // path symmetrical (renderer initiates; main aborts ffmpeg).
        audioTrackCount: video.audioTracks.length,
        modelId: activeModelId,
        defaults: {
          fontSizePx: runDefaults.fontSizePx,
          textColorHex: runDefaults.textColorHex,
          outlineColorHex: runDefaults.outlineColorHex,
          outlineThicknessPx: runDefaults.outlineThicknessPx,
          fadeDurationSec: settingsFadeDurationSec,
        ...animationFieldsForNewCue(transcriptionDefaults, animationMemory),
        },
        advanced: transcriptionAdvanced,
        // REQ-0207 — pass the drawer's checkbox through.  The service
        // wrapper omits the key entirely when false so the IPC payload
        // matches the pre-REQ-0207 shape byte-for-byte.
        wordSubtitle: wordSubtitleOn
      },
      (evt) => {
        if (evt.event === 'progress') {
          // REQ-0142 — first real progress event ends the prep region.
          // Clearing `preparingPhase` swaps the drawer back to the
          // determinate bar (already the pre-REQ-0142 look).
          setPreparingPhase(null)
          setTranscribeProgress(Math.round(evt.percent))
        } else if (evt.event === 'segment') {
          segments.push(evt.segment)
        } else if (evt.event === 'phase') {
          if (evt.phase === 'preview-mix') {
            // REQ-086 — Whisper done, preview-mix in flight.  Show the
            // mix label and pin the progress bar at 100 % so the user
            // sees the run is still active without a misleading reset
            // to 0.
            setTranscribePhase('preview-mix')
            setTranscribeProgress(100)
            setPreparingPhase(null)
          } else {
            // REQ-0142 — pre-Whisper prep phases (extractAudio /
            // loadModel / prepass) from the sidecar.  The drawer
            // shows an indeterminate bar + phase-specific label +
            // elapsed timer while these are in flight.
            setPreparingPhase(evt.phase)
          }
        } else if (evt.event === 'needsDownload') {
          toast.warning(t('toast.modelNotInstalled', { model: evt.model }))
        } else if (evt.event === 'deviceInfo') {
          // REQ-0145 §3 — surface the sidecar's device choice so the
          // owner can verify GPU engagement.  Duplicated to
          // `console.log` (visible in DevTools console) AND stored in
          // React state so the drawer chip can render it live.  The
          // main-process `[sidecar stderr]` log covers the third
          // channel (dev terminal) via the print(...) in main.py.
          console.log(
            `[REQ-0145 deviceInfo] device=${evt.device} computeType=${evt.computeType} fellBack=${evt.fellBack}`,
          )
          setDeviceInfo({
            device: evt.device,
            computeType: evt.computeType,
            fellBack: evt.fellBack,
          })
          // REQ-0173 §2 — surface silent GPU→CPU fallback with an
          // explicit toast.  The transcription drawer already turns
          // its device chip warning-yellow when `fellBack === true`,
          // but users focused on the progress bar / elapsed timer
          // frequently miss the chip and only notice that transcribe
          // is much slower than expected.  Firing a toast at the
          // moment the sidecar reports the fallback catches every
          // silent CPU-drop — Blackwell + int8 crash, missing cuDNN,
          // driver mismatch, OOM, or the REQ-0173 §1 secondary
          // defense exhausting its retry ladder — so the owner /
          // user always knows the speedup they expected did not
          // happen.  Deliberately no dependency-array useEffect: the
          // sidecar sends `deviceInfo` at most once per transcribe
          // run, so we can act on the event synchronously here.
          if (evt.fellBack) {
            toast.warning(t('toast.gpuFallback'))
          }
        }
      }
    )
    transcriptionRunRef.current = run

    let cancelled = false
    let errorReason: string | null = null
    try {
      const runResult = await run.promise
      previewMixUrl = runResult.previewMixUrl
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
      // REQ-0142 — stop the elapsed timer and clear the prep phase so
      // a fresh drawer open never carries leftover state from the
      // previous run.
      setTranscribeStartMs(null)
      setPreparingPhase(null)
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
    // REQ-0295 — expanded seeding: on top of the four legacy style
    // fields (font size / colours / outline), every new REQ-0295
    // TranscriptionDefaults field is copied onto each transcribed
    // row when the user has set it in Settings > "字幕スタイル".
    // Fields left `undefined` in defaults stay `undefined` on the
    // row (i.e. the renderer's neutral "off / default" behaviour
    // for that field) so pre-REQ-0295 setups produce byte-identical
    // entries to before.
    // REQ-0334 §2-3 — the whole "defaults → cue style" projection now lives
    // in ONE exhaustively-typed place.  Adding a field to
    // `TranscriptionDefaults` without classifying it there is a `tsc` error,
    // and Step 1's style preview calls this same function, so the preview
    // cannot fall behind this seeding again.  Layout fallbacks and the
    // 「オフセット」→ absolute `posX/posY` conversion moved inside it.
    const styleFields = styleFieldsFromDefaults(runDefaults, {
      videoWidthPx: video?.widthPx,
      videoHeightPx: video?.heightPx,
    })

    const entries: SubtitleEntryType[] = segments.map((seg, i) => {
      const base = {
        startSec: seg.startSec,
        endSec: seg.endSec,
        text: seg.text,
        fadeDurationSec: settingsFadeDurationSec,
        ...animationFieldsForNewCue(transcriptionDefaults, animationMemory),
        fontId: runFontId,
        // REQ-0285 — attach per-word timestamps captured by the sidecar.
        // `undefined` (rather than `[]`) when the segment carried no
        // word data, so `areWordsValidForText` short-circuits on the
        // truthiness check and downstream Phase B renderers can gate on
        // a single value.  Deep-copied into `original.words` below via
        // spread so Reset row restores the same array.
        words: seg.words,
        // REQ-20260613-016 / v1.2.2 機能A: layout + background values
        // seeded from ENTRY_LAYOUT_DEFAULTS.  `makeEntryLayoutDefaults`
        // returns a fresh object literal per call so each row owns its
        // own subtitleBackground — mutating one row never aliases
        // another.  This call is now ONLY for the background sub-object
        // (background stays BURNIN_DEFAULTS since it's not a REQ-0295
        // field per owner decision 2026-07-26); the layout triple it also
        // returns is immediately overridden by `styleFields` below, which
        // applies the user's TranscriptionDefaults on top.  Order matters.
        ...makeEntryLayoutDefaults(),
        // REQ-0334 §2-3 — every style default in one spread.  The field
        // list that used to be written out here is now the exhaustively
        // typed map in `lib/style-defaults-to-entry.ts`, shared with Step
        // 1's live style preview.
        ...styleFields,
      }
      return {
        id: `t-${i}-${Date.now()}`,
        ...base,
        isDeleted: false,
        isEdited: false,
        // Deep-copy the nested subtitleBackground so the live entry and
        // its `original` snapshot don't share object identity (otherwise
        // an inline edit would also mutate the reset target).
        // REQ-0285 — `words` is intentionally aliased between live and
        // original (arrays of WordSpan objects are immutable in practice;
        // nothing in the codebase mutates a word span in-place).  Cost
        // of a per-row `.map` copy is nontrivial for long transcripts;
        // the alias is safe as long as the invariant holds.
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
    // REQ-086 — surface the preview-mix URL (or null when N<=1 / the
    // main process didn't generate one) to the panel consumer.  This
    // must happen BEFORE navigate so VideoPreviewPanel sees the value
    // on its first mount.
    usePreviewMixStore.getState().setUrl(previewMixUrl)
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
    setTranscribePhase('whisper')
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

  // REQ-0181 — guard-reason resolver.  Mutually-exclusive priority chain
  // that mirrors the natural dependency order (a video with no audio is
  // impossible without a video; a model can be picked independently).
  // Returns a translated string when the transcribe start is blocked, or
  // `null` when canStart is true (no reason needed).  Consumed by
  // (a) the footer Start button's tooltip + click-toast wrapper below,
  // and (b) the TranscriptionDrawer's own Start button (same reason
  // string forwarded via props).
  const guardReason = (() => {
    if (isLoading) return null                            // transient, no useful guidance
    if (!video) return t('guard.noInput')
    if ((video.audioTracks?.length ?? 0) === 0) return t('guard.noAudio')
    if (!activeModelId) return t('guard.noModel')
    return null
  })()

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
  // REQ-0422 — footer collapses to a single [文字起こし開始] button that
  // ALWAYS opens the setup drawer (default tab = 入力ファイル).  File
  // selection now lives inside the drawer's タブ1, so this button must open
  // regardless of whether a video is chosen — the drawer's own bottom
  // [文字起こし開始] is the guarded run trigger (canStart), and pressing it
  // while disabled routes the user back to タブ1 (see transcription-drawer).
  // The old split-button (Start + subtitle-style caret) and the standalone
  // SubtitleStyleDialog are retired; style now lives in the drawer's タブ2.
  const footerRight = (
    <Button
      variant="primary"
      size="md"
      onClick={() => setTranscriptionDrawerOpen(true)}
    >
      {isTranscribing
        ? t('action.transcribing', { percent: transcribeProgress })
        : t('action.startTranscription')}
    </Button>
  )

  return (
    <AppShell
      // REQ-0185 §3 — title + description moved to the top strip
      // (see components/app-shell/breadcrumb.tsx).  The in-content
      // "Page header" block that used to render `<h1 text-title>`
      // + `<p text-body>` below was removed to avoid double titling.
      title={t('title')}
      description={t('guidance')}
      footerCenter={footerCenter}
      footerRight={footerRight}
    >
      {/*
        REQ-0178 Phase B-1 — dropped the 3 outer card wrappers
        (`rounded-xl border border-line bg-surface-1 p-4`) that used to
        box each of Whisper / GPU / Input-Video into a floating
        rounded panel with margins between.  The panels now flow as
        flat sections divided by hairlines (`divide-y divide-line`
        on this parent), matching Resolve's "info-dense inspector"
        pattern rather than the pre-0178 "3 rounded boxes stacked
        with air".  The `space-y-4` also went — vertical spacing
        is now the section padding (`py-3`) + hairline instead of
        outer margin.
      */}
      <div className="divide-y divide-line">
        {/* Whisper model + Advanced (engine) trigger.  Subtitle Style
            does NOT live here — it is unrelated to the Whisper engine
            and sits next to the Start button in the footer instead.
            REQ-20260615-020: the Advanced button was retired in favour of
            the gear icon that WhisperModelManager renders inline in its
            own header; step1 just forwards a callback. */}
        <div className={cn(
          'py-3 transition-opacity duration-200',
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
            // REQ-0152 §2 — `open` here reflects the direction of the
            // pending transition (WhisperModelManager passes `!isOpen`
            // from its header click, `false` from its post-install /
            // activate auto-collapse).  Map both to the single-open
            // toggle: `true` opens whisper (auto-closing others), `false`
            // sets the section to `null` (all-closed).
            onOpenChange={(open) => setOpenSection(open ? 'whisper' : null)}
          />
        </div>

        {/* REQ-0150 / REQ-0152 §2 — GPU acceleration accordion, promoted
            to an independent card between the Whisper model picker and
            the input-video card, and now participating in the shared
            single-open exclusion group (was uncontrolled pre-REQ-0152).
            Position matches REQ-0150 §1 ("Whisperモデルの項目と入力
            ファイルの項目の間"). */}
        <div className={cn(
          'py-3 transition-opacity duration-200',
          isTranscribing && 'opacity-50 pointer-events-none'
        )}>
          <GpuToolManager
            disabled={isTranscribing}
            isOpen={openSection === 'device'}
            onOpenChange={(open) => setOpenSection(open ? 'device' : null)}
          />
        </div>

        {/* REQ-0405 — optional translation tool (MADLAD-400), directly under
            the 処理デバイス section.  Phase 1: download / enable / delete only
            (no translation execution).  Participates in the same single-open
            accordion group. */}
        <div className={cn(
          'py-3 transition-opacity duration-200',
          isTranscribing && 'opacity-50 pointer-events-none'
        )}>
          <TranslationToolManager
            disabled={isTranscribing}
            isOpen={openSection === 'translation'}
            onOpenChange={(open) => setOpenSection(open ? 'translation' : null)}
          />
        </div>


      </div>

      {/* REQ-0422 — the 3-tab setup drawer is now the single surface for
          input file / subtitle style / Whisper settings.  File selection
          (browse + metadata), the word-subtitle toggle and the audio-track
          grid live in タブ1; the former SubtitleStyleDialog content is タブ2;
          the Whisper advanced controls are タブ3.  Style props are read by
          the drawer directly from the stores (same as the old dialog). */}
      <TranscriptionDrawer
        open={transcriptionDrawerOpen}
        onOpenChange={setTranscriptionDrawerOpen}
        audioTracks={audioTracks}
        video={video}
        thumbnail={thumbnail}
        isLoading={isLoading}
        onBrowse={handleBrowse}
        onDropFile={handleDropFile}
        renderState={drawerRenderState}
        progress={transcribeProgress}
        runningLabelOverride={
          transcribePhase === 'preview-mix'
            ? t('drawer.runningLabelPreviewMix')
            : undefined
        }
        preparingPhase={preparingPhase}
        elapsedSec={elapsedSec}
        deviceInfo={deviceInfo}
        errorMessage={drawerErrorMessage}
        canStart={canStart}
        // REQ-0181 — the drawer's own Start button gets the guard reason
        // string; REQ-0422 also routes a disabled-click back to タブ1.
        guardReason={guardReason}
        onStart={handleStartTranscription}
        onCancel={handleCancelClick}
        wordSubtitleOn={wordSubtitleOn}
        onWordSubtitleChange={setWordSubtitleOn}
      />

      {/* Cancel transcription dialog.
          REQ-0139 §3 — REQ-0138's `onEnterConfirm={handleConfirmCancel}`
          was removed because this is a destructive confirmation
          (aborts an in-flight Whisper run).  Owner must click; Esc
          closes safely without cancelling. */}
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
