import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertCircle,
  AudioWaveform,
  FolderOpen,
  Lock,
  Loader2,
  Mic,
  Play,
  Settings2,
  Type,
  Upload,
  Video
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { HelpIcon } from '@/components/help-icon'
import { WhisperAdvancedControls } from '@/components/whisper-advanced-controls/whisper-advanced-controls'
import { StyleSamplePreview } from '@/components/step1/style-sample-preview'
import { FontPicker } from '@/components/font-picker/font-picker'
import { DefaultStyleControls } from '@/components/default-style-controls/default-style-controls'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription
} from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { formatElapsed } from '@/lib/format-elapsed'
import { formatDuration } from '@/lib/time'
import { formatBytes } from '@/lib/format'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import { useAppEnvStore } from '@/stores/app-env-store'
import { useStoreUpsellStore } from '@/stores/store-upsell-store'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { pickTranscriptionTrack } from '../../../shared/track-pick'
import type { AudioTrack, VideoInfo } from '../../../shared/types'

/**
 * REQ-20260615-055 / REQ-0422 — STEP1's transcription **setup** drawer.
 *
 * REQ-0422 restructured STEP1: the main screen keeps only the preparation
 * tools (Whisper model / processing device / translation tool), and every
 * run-time choice moved into this right-sliding drawer, split across three
 * tabs (idle state only):
 *
 *   タブ1 入力ファイル : video picker + file metadata, the word-subtitle
 *                        experimental toggle, and the audio-track grid.
 *   タブ2 文字スタイル : the former SubtitleStyleDialog content
 *                        (preview + FontPicker + DefaultStyleControls).
 *   タブ3 Whisper設定  : the VAD + recognition advanced controls.
 *
 * File selection (`onBrowse`), the project/thumbnail state, and the actual
 * transcription run (`onStart` → step1's `handleStartTranscription`) still
 * live in the STEP1 route — this drawer only renders the UI and reads the
 * stores.  See `dev-docs/specs/step1-drawer-restructure.md`.
 *
 * running / error states are unchanged from the pre-0422 drawer: the tabs
 * are hidden and the whole body shows progress / the error panel.  The X
 * close affordance, backdrop click and Esc are blocked while running.
 */
export type TranscriptionRenderState = 'idle' | 'running' | 'error'

type SetupTab = 'input' | 'style' | 'whisper'

/** Compact label/value row for the file-metadata block (REQ-0422 — moved
 *  here from step1.tsx along with the file picker). */
function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-body-sm font-semibold text-fg-secondary">{label}</span>
      <span className="text-body-sm text-fg-primary font-mono tabular-nums">{value}</span>
    </div>
  )
}

export interface TranscriptionDrawerProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Available audio tracks.  Empty when no video is loaded. */
  audioTracks: AudioTrack[]
  /** REQ-0422 — currently-selected video (project store), or null. */
  video: VideoInfo | null
  /** REQ-0422 — STEP1's local identification thumbnail (data URL) or null. */
  thumbnail: string | null
  /** REQ-0422 — true while the STEP1 probe is in flight. */
  isLoading: boolean
  /** REQ-0422 — opens the OS file picker (owned by step1's handleBrowse). */
  onBrowse: () => void
  /**
   * REQ-0423 — a video/audio file was dropped on タブ1's drop zone.  Receives
   * the absolute path (Electron `File.path`); step1 validates the extension
   * and merges into the same load path as the picker.
   */
  onDropFile: (filePath: string) => void
  /** State of the in-flight transcription run; idle when not running. */
  renderState: TranscriptionRenderState
  /** 0–100 percent progress while `renderState === 'running'`. */
  progress: number
  /**
   * REQ-086 — optional override for the running-state label.  Parent
   * passes a localised string for the preview-mix phase (e.g.
   * "音声準備中…") so the user sees the run move from "文字起こし中"
   * → "音声準備中…" → close.  When omitted, the default
   * `drawer.runningLabel` translation is used.
   */
  runningLabelOverride?: string
  /**
   * REQ-0142 — pre-Whisper preparation phase, or `null` when Whisper
   * inference has begun (= at least one `progress` event received) or
   * the run is not active.  When non-null, the drawer replaces the
   * determinate `progress%` bar with an indeterminate flowing
   * animation + the phase-specific label + `elapsedSec`.
   */
  preparingPhase?: 'extractAudio' | 'loadModel' | 'prepass' | null
  /**
   * REQ-0142 — elapsed seconds since the user pressed Start.  Rendered
   * next to the phase label during the preparing region.
   */
  elapsedSec?: number
  /**
   * REQ-0145 Step 1 — the sidecar's device choice, reported once per
   * run via the `deviceInfo` IPC event.  `null` before loadModel resolves.
   */
  deviceInfo?: {
    device: 'cuda' | 'cpu'
    computeType: string
    fellBack: boolean
  } | null
  /** Error message when `renderState === 'error'`. */
  errorMessage: string
  /** Whether the start button should be enabled.  Driven by the parent
   *  (`canStart` = video + track + model + advanced loaded). */
  canStart: boolean
  /**
   * REQ-0181 — human-readable reason string surfaced when `canStart`
   * is false, or `null` when the button is enabled.  Rendered as the
   * `title` tooltip on hover AND fired as a `toast.warning` when the
   * user clicks the disabled Start button.  REQ-0422 — the disabled
   * click also routes back to タブ1 so the user sees the file picker.
   */
  guardReason?: string | null
  /** Fires when the user presses 文字起こし開始 inside the drawer. */
  onStart: () => void
  /** Fires when the user presses キャンセル mid-run. */
  onCancel: () => void
  /**
   * REQ-0207 — experimental word-level subtitle re-split.  Non-persisted
   * (parent resets to false whenever the drawer closes).
   */
  wordSubtitleOn: boolean
  onWordSubtitleChange: (next: boolean) => void
}

export function TranscriptionDrawer({
  open,
  onOpenChange,
  audioTracks,
  video,
  thumbnail,
  isLoading,
  onBrowse,
  onDropFile,
  renderState,
  progress,
  runningLabelOverride,
  preparingPhase,
  elapsedSec,
  deviceInfo,
  errorMessage,
  canStart,
  guardReason,
  onStart,
  onCancel,
  wordSubtitleOn,
  onWordSubtitleChange
}: TranscriptionDrawerProps) {
  const { t } = useTranslation(['step1', 'step3', 'common'])

  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  const setTranscriptionAdvanced = useSettingsStore((s) => s.setTranscriptionAdvanced)
  const resetTranscriptionAdvanced = useSettingsStore((s) => s.resetTranscriptionAdvanced)
  const selectedTrack = useProjectStore((s) => s.selectedTrackIndex)
  // REQ-0436 — default audio-track preference, used by the autoselect ladder.
  const defaultAudioTrackIndex = useSettingsStore((s) => s.defaultAudioTrackIndex)
  const setSelectedTrack = useProjectStore((s) => s.setSelectedTrackIndex)

  // REQ-0422 タブ2 (文字スタイル) — same store slots the old SubtitleStyleDialog
  // read/wrote directly, so the seed-style single-source-of-truth is unchanged.
  const styleDefaults = useSettingsStore((s) => s.transcriptionDefaults)
  const setStyleDefaults = useSettingsStore((s) => s.updateTranscriptionDefaults)
  const autoLineBreak = useSettingsStore((s) => s.autoLineBreak)
  const setAutoLineBreak = useSettingsStore((s) => s.setAutoLineBreak)
  const fadeDurationSec = useSettingsStore((s) => s.fadeDurationSec)
  const isAudioOnly = useIsAudioOnly()

  // REQ-0210 — word-level transcription is an MSIX-only (paid tier)
  // feature.  Locked (disabled + Lock + upsell) on NSIS (free) builds.
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false
  const openUpsell = useStoreUpsellStore((s) => s.openUpsell)
  const wordSubtitleLocked = !isMsix

  // REQ-0422 — active setup tab.  Reset to 入力ファイル every time the drawer
  // opens so the run flow always starts on the must-touch file picker.
  const [activeTab, setActiveTab] = useState<SetupTab>('input')
  useEffect(() => {
    if (open) setActiveTab('input')
  }, [open])

  // REQ-0442 — the real cause of タブ2/3 "bottom-aligned" was that the タブ
  // <TabsContent> carried `display:flex`, which overrode the UA
  // `[hidden]{display:none}` Radix uses to hide inactive tabs, so all three
  // stacked (see the JSX below; `display:flex` is now off the TabsContent).
  // With `[hidden]` working again, only the active tab renders.  The REQ-0441
  // diagnostic that measured this is removed now the cause is known.  This tiny
  // reset stays only as a harmless belt-and-suspenders against a Radix
  // panel-focus scroll jump: force the freshly-shown tab's scrollTop to 0.
  const resetTabScrollTop = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    el.scrollTop = 0
    requestAnimationFrame(() => {
      el.scrollTop = 0
    })
  }, [])

  // REQ-0423 — drag & drop input file.  `dragActive` drives the drop-zone
  // highlight; the drop reads Electron's `File.path` (available because the
  // renderer runs with sandbox:false) and forwards it to step1, which gates
  // the extension and reuses the picker's load path.
  const [dragActive, setDragActive] = useState(false)
  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragActive(false)
    const file = e.dataTransfer.files?.[0]
    const path = (file as (File & { path?: string }) | undefined)?.path
    if (path) onDropFile(path)
  }

  // REQ-20260615-055 — autoselect a track on first open so the user never sees
  // an empty selection.  REQ-0436 — use the SAME default-track ladder as the
  // load path (`pickTranscriptionTrack`), not `audioTracks[0]`, so the
  // preferred/default track is chosen consistently (no first-track detour).
  const hasValidSelection = useMemo(
    () => audioTracks.some((tr) => tr.index === selectedTrack),
    [audioTracks, selectedTrack]
  )
  useEffect(() => {
    if (!open || hasValidSelection || audioTracks.length === 0) return
    const picked = pickTranscriptionTrack(audioTracks, defaultAudioTrackIndex)
    if (picked.trackIndex !== null) setSelectedTrack(picked.trackIndex)
  }, [open, hasValidSelection, audioTracks, defaultAudioTrackIndex, setSelectedTrack])

  // Mirrors burnin-drawer's open-state guard — block close while
  // running so X / backdrop / Esc cannot abandon a live transcription.
  function handleSheetOpenChange(next: boolean) {
    if (!next && renderState === 'running') return
    onOpenChange(next)
  }

  // REQ-0422 §7 — a click on the disabled run button routes back to タブ1
  // (the file picker) and surfaces the guard reason.
  const startBlocked = !canStart
  function handleBlockedStart() {
    setActiveTab('input')
    if (guardReason) toast.warning(guardReason)
  }

  // Identification-frame envelope (280×240) preserved from the old STEP1 card.
  const thumbBoxStyle = (() => {
    const MAX_W = 280
    const MAX_H = 240
    const ratio =
      !isAudioOnly && video && video.widthPx > 0 && video.heightPx > 0
        ? video.widthPx / video.heightPx
        : 16 / 9
    const widthBound = MAX_H * ratio > MAX_W
    return widthBound
      ? { width: `${MAX_W}px`, height: `${MAX_W / ratio}px` }
      : { width: `${MAX_H * ratio}px`, height: `${MAX_H}px` }
  })()

  return (
    <Sheet open={open} onOpenChange={handleSheetOpenChange}>
      <SheetContent
        side="right"
        // REQ-0440 — `overflow-hidden` on the drawer's outer flex-col is the
        // structural fix for タブ2/3 opening bottom-weighted.  SheetContent is
        // `flex flex-col … h-full inset-y-0` (box = viewport, clientHeight≈820),
        // but WITHOUT overflow-hidden the definite height was not enforced on the
        // `flex-1 min-h-0` chain below (body → Tabs → TabsContent): the tab
        // content sized to its own 1738px content and grew the Sheet to 2158px
        // instead of scrolling inside its box (RES-0439 diagnostic: every node
        // already had scrollTop=0 — a layout break, not a scroll-position one).
        // The working SettingsDialog uses the same `flex flex-col overflow-hidden`
        // on its container; this brings the drawer to parity so each TabsContent
        // scrolls internally and opens at the top.
        className="max-w-[640px] overflow-hidden"
        hideClose={renderState === 'running'}
      >
        <SheetHeader className="flex-row items-baseline gap-3 pr-10">
          <SheetTitle>{t('drawer.title')}</SheetTitle>
          <SheetDescription className="flex-1">{t('drawer.subtitle')}</SheetDescription>
        </SheetHeader>

        {/* REQ-0422 — idle = 3-tab setup; running / error take over the whole
            body (no tabs) exactly as before. */}
        <div className="flex-1 min-h-0 flex flex-col px-4 py-2">
          {renderState === 'idle' && (
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as SetupTab)}
              className="flex flex-col min-h-0 flex-1"
            >
              <TabsList className="shrink-0">
                <TabsTrigger value="input">
                  <Video className="h-3.5 w-3.5" />
                  {t('drawer.tabInput')}
                </TabsTrigger>
                <TabsTrigger value="style">
                  <Type className="h-3.5 w-3.5" />
                  {t('drawer.tabStyle')}
                </TabsTrigger>
                <TabsTrigger value="whisper">
                  <Settings2 className="h-3.5 w-3.5" />
                  {t('drawer.tabWhisper')}
                </TabsTrigger>
              </TabsList>

              {/* REQ-0437 — PER-TAB scroll: each タブ's <TabsContent> is its own
                  `flex-1 min-h-0 overflow-y-auto overflow-x-hidden` scroll box.
                  REQ-0442 — the <TabsContent> itself MUST NOT carry `display:flex`
                  (`flex flex-col`): an author `.flex{display:flex}` overrides the
                  UA `[hidden]{display:none}` Radix uses to hide inactive tabs, so
                  every tab rendered at once, stacked (firstChild.offsetTop=539) —
                  the real cause behind six rounds of "bottom-aligned" reports.
                  Any flex-col layout a tab needs (タブ1's word toggle pinned to the
                  bottom via mt-auto) lives in an INNER wrapper div, never on the
                  TabsContent.  `flex-1`/`min-h-0`/`overflow-*` don't set `display`,
                  so they stay on the TabsContent.  The layout guard test pins this. */}
              {/* ── タブ1 入力ファイル ─────────────────────────────── */}
              <TabsContent
                ref={resetTabScrollTop}
                value="input"
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
              >
                {/* REQ-0442 — inner flex-col wrapper: min-h-full fills the scroll
                      box so the word toggle's mt-auto pins it to the bottom; taller
                      content grows the wrapper and the TabsContent scrolls. */}
                <div className="flex flex-col gap-4 min-h-full">
                  {/* Supported-format hint (right-aligned reference line). */}
                  <div className="flex justify-end">
                    <span className="text-caption text-fg-muted">{t('inputVideo.hint')}</span>
                  </div>

                  {/* Path + Browse */}
                  {isLoading ? (
                    <div className="flex items-center gap-2.5 h-9 px-1">
                      <Loader2 className="h-4 w-4 animate-spin text-fg-secondary flex-shrink-0" />
                      <span className="text-body text-fg-secondary">{t('inputVideo.loading')}</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-9 rounded-md border border-line bg-input px-3.5 flex items-center min-w-0">
                        <span
                          className={cn(
                            'text-body truncate',
                            video ? 'text-fg-primary' : 'text-fg-secondary/60'
                          )}
                        >
                          {video?.path ?? t('inputVideo.placeholder')}
                        </span>
                      </div>
                      <Button
                        variant="secondary"
                        size="md"
                        onClick={onBrowse}
                        className="bg-surface-2 text-fg-primary hover:bg-surface-3 active:bg-surface-4"
                      >
                        <FolderOpen className="h-4 w-4 mr-1.5" />
                        {t('inputVideo.chooseVideo')}
                      </Button>
                    </div>
                  )}

                  {/* REQ-0423 — file selected → thumbnail + metadata.  No file
                      (and not loading) → the same area is a dashed drag-&-drop
                      zone (click also opens the picker). */}
                  {video ? (
                    <div className="grid grid-cols-[auto_1fr] gap-4 items-center">
                      <div
                        className="rounded-md border border-line bg-input overflow-hidden flex items-center justify-center flex-shrink-0"
                        style={thumbBoxStyle}
                      >
                        {isAudioOnly ? (
                          <AudioWaveform className="h-8 w-8 text-fg-secondary/60" />
                        ) : thumbnail ? (
                          <img src={thumbnail} alt="" className="w-full h-full object-contain" />
                        ) : (
                          <Video className="h-6 w-6 text-fg-secondary/40" />
                        )}
                      </div>
                      <div className="divide-y divide-border/50">
                        {!isAudioOnly && (
                          <InfoRow
                            label={t('inputVideo.infoResolution')}
                            value={`${video.widthPx}×${video.heightPx}`}
                          />
                        )}
                        <InfoRow
                          label={t('inputVideo.infoDuration')}
                          value={formatDuration(video.durationSec)}
                        />
                        <InfoRow
                          label={t('inputVideo.infoFormat')}
                          value={
                            isAudioOnly
                              ? `${video.container.toUpperCase()} / ${video.audioTracks[0]?.codec ?? '—'}`
                              : `${video.container.toUpperCase()} / ${video.videoCodec} / ${video.fps}fps`
                          }
                        />
                        <InfoRow
                          label={t('inputVideo.infoFileSize')}
                          value={formatBytes(video.fileSizeBytes)}
                        />
                      </div>
                    </div>
                  ) : !isLoading ? (
                    <div
                      onDragOver={(e) => {
                        e.preventDefault()
                        setDragActive(true)
                      }}
                      onDragLeave={(e) => {
                        e.preventDefault()
                        setDragActive(false)
                      }}
                      onDrop={handleDrop}
                      onClick={onBrowse}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onBrowse()
                        }
                      }}
                      className={cn(
                        'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-10 text-center cursor-pointer transition-colors duration-150',
                        dragActive
                          ? 'border-primary bg-primary/5'
                          : 'border-line hover:border-line-strong hover:bg-surface-2/30'
                      )}
                    >
                      <Upload
                        className={cn('h-7 w-7', dragActive ? 'text-primary' : 'text-fg-tertiary')}
                      />
                      <p className="text-body-sm text-fg-secondary">{t('inputVideo.dropHint')}</p>
                    </div>
                  ) : null}

                  {/* Audio track grid. */}
                  <div className="space-y-3">
                    <div className="flex items-center gap-1.5">
                      <Mic className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
                      {/* REQ-0421 — overlay reassignment: 音声トラック title → body. */}
                      <Label className="text-body">{t('drawer.trackSection')}</Label>
                      <HelpIcon content={t('audioTracks.help')} />
                      {audioTracks.length > 0 && (
                        <Badge variant="muted" className="ml-1">
                          {t('audioTracks.tracksCount', { count: audioTracks.length })}
                        </Badge>
                      )}
                    </div>
                    {audioTracks.length === 0 ? (
                      <p className="text-body-sm text-fg-muted">{t('guard.noInput')}</p>
                    ) : (
                      <>
                        <p className="text-body-sm text-fg-muted">{t('audioTracks.description')}</p>
                        <div className="grid grid-cols-2 gap-2">
                          {audioTracks.map((track) => (
                            /* REQ-0425 — 2-line track button so the 「文字起こし対象」
                               badge never squeezes the track details (stereo /
                               48kHz / aac) into a truncated ellipsis.
                               行1: dot + track name (left) + badge (ml-auto, right).
                               行2: track details, full width, no truncate.
                               Badge-less tracks use the same 2-line layout. */
                            <button
                              key={track.index}
                              type="button"
                              onClick={() => setSelectedTrack(track.index)}
                              className={cn(
                                'flex flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors duration-150',
                                selectedTrack === track.index
                                  ? 'border-primary'
                                  : 'border-line hover:bg-surface-2/40'
                              )}
                            >
                              <div className="flex items-center gap-2 w-full">
                                <span className="h-2 w-2 rounded-full flex-shrink-0 bg-primary" />
                                <span
                                  className={cn(
                                    // REQ-0421 — overlay reassignment: track label body → body-sm.
                                    'text-body-sm font-medium',
                                    selectedTrack === track.index
                                      ? 'text-primary'
                                      : 'text-fg-primary'
                                  )}
                                >
                                  {t('audioTracks.trackLabel', { index: track.index })}
                                </span>
                                {selectedTrack === track.index && (
                                  <Badge variant="success" className="ml-auto flex-shrink-0">
                                    {t('audioTracks.transcriptionTarget')}
                                  </Badge>
                                )}
                              </div>
                              <span className="text-body-sm text-fg-muted">
                                {`${track.channels} · ${track.sampleRateHz / 1000}kHz · ${track.codec}`}
                              </span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  {/* REQ-0423 — word-level (experimental) toggle moved BELOW the
                      track grid and pushed to the tab bottom (mt-auto spacer). */}
                  <div className="mt-auto pt-2">
                    <div
                      className={cn(
                        'flex items-start gap-2 rounded-md border border-line/70 px-3 py-2 bg-surface-2/30',
                        wordSubtitleLocked &&
                          'cursor-pointer hover:bg-surface-2/60 hover:border-line'
                      )}
                      onClick={wordSubtitleLocked ? () => openUpsell() : undefined}
                      role={wordSubtitleLocked ? 'button' : undefined}
                      tabIndex={wordSubtitleLocked ? 0 : undefined}
                      onKeyDown={
                        wordSubtitleLocked
                          ? (e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                openUpsell()
                              }
                            }
                          : undefined
                      }
                      aria-label={
                        wordSubtitleLocked ? t('drawer.wordSubtitle.lockedPaidOnly') : undefined
                      }
                    >
                      <Checkbox
                        id="word-subtitle-experimental"
                        checked={wordSubtitleLocked ? false : wordSubtitleOn}
                        onCheckedChange={(v) => onWordSubtitleChange(v === true)}
                        disabled={wordSubtitleLocked}
                        className="mt-0.5"
                      />
                      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <label
                            htmlFor="word-subtitle-experimental"
                            className={cn(
                              // REQ-0421 — overlay reassignment: 単語ごとに文字起こし label body-sm → title.
                              'text-title font-medium',
                              wordSubtitleLocked && 'text-fg-secondary/70'
                            )}
                          >
                            {t('drawer.wordSubtitle.label')}
                          </label>
                          {wordSubtitleLocked && (
                            <span className="inline-flex items-center gap-1 rounded-full border border-line/70 bg-surface-1/60 px-1.5 py-0.5 text-caption text-fg-secondary/80">
                              <Lock className="h-3 w-3" />
                              {t('drawer.wordSubtitle.lockedPaidOnly')}
                            </span>
                          )}
                        </div>
                        <p
                          className={cn(
                            // REQ-0421 — overlay reassignment: word-subtitle description caption → body-sm.
                            'text-body-sm text-fg-muted leading-relaxed',
                            wordSubtitleLocked && 'text-fg-secondary/60'
                          )}
                        >
                          {t('drawer.wordSubtitle.description')}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </TabsContent>

              {/* ── タブ2 文字スタイル ─────────────────────────────── */}
              {/* Same three pieces the old SubtitleStyleDialog rendered.
                    Stacked (not 2-col) to fit the 640px drawer.  REQ-0437 —
                    own scroll area, top-aligned, no h-scroll. */}
              <TabsContent
                ref={resetTabScrollTop}
                value="style"
                // REQ-0442 — NO `display:flex` on the TabsContent (it overrides
                // Radix's [hidden] and stacks tabs).  Block flow top-aligns the
                // style sections inside the scroll box.  REQ-0485 — spacing moved
                // to the inner content wrapper so the sticky preview's own
                // opaque `pb-3` provides the gap without a double margin.
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
              >
                {/* REQ-0485 §3 — pin the preview to the top of the scroll box so
                    it never scrolls out of view while the user adjusts the style
                    controls below.  `bg-surface-1` matches the drawer body
                    (SheetContent) so scrolled controls are hidden behind it; the
                    whole card (label + frame + 「※ 近似表示です」 note) is stuck
                    together — it reads as one unit and splitting it looked odd.
                    `pb-3` is the opaque gap to the first control below. */}
                <div className="sticky top-0 z-10 bg-surface-1 pb-3">
                  <StyleSamplePreview
                    defaults={styleDefaults}
                    thumbnail={thumbnail}
                    video={video}
                    autoLineBreak={autoLineBreak}
                  />
                </div>
                <div className="space-y-3">
                  {/* REQ-0485 §2 — font list dropped here (lives in Settings ▸
                      Fonts); the default-font dropdown + a pointer note stay. */}
                  <FontPicker showFontList={false} />
                  {/* REQ-0539 §2-1 — keyword emphasis is hidden here: keywords
                      are picked per word in the inspector, and nothing has been
                      transcribed yet at this point, so the default has nothing
                      to apply to.  Hidden only — the saved values are untouched
                      and still reach ASS generation. */}
                  <DefaultStyleControls
                    defaults={styleDefaults}
                    onUpdateDefaults={setStyleDefaults}
                    autoLineBreak={autoLineBreak}
                    onSetAutoLineBreak={setAutoLineBreak}
                    fadeDurationSec={fadeDurationSec}
                    isMsix={isMsix}
                    showKeywordEmphasis={false}
                  />
                </div>
              </TabsContent>

              {/* ── タブ3 Whisper設定 ──────────────────────────────── */}
              {/* REQ-0437 — own scroll area, top-aligned, no h-scroll. */}
              <TabsContent
                ref={resetTabScrollTop}
                value="whisper"
                // REQ-0442 — NO `display:flex` on the TabsContent (it overrides
                // Radix's [hidden] and stacks tabs).  Block flow top-aligns the
                // WhisperAdvancedControls block inside the scroll box.
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
              >
                <WhisperAdvancedControls
                  transcriptionAdvanced={transcriptionAdvanced}
                  onUpdate={setTranscriptionAdvanced}
                  onReset={resetTranscriptionAdvanced}
                />
              </TabsContent>
            </Tabs>
          )}

          {renderState === 'running' && (
            <div className="flex items-center justify-center py-12">
              <div className="rounded-xl border border-line bg-surface-1 px-6 py-8 w-full max-w-md space-y-5">
                {!runningLabelOverride && (
                  <div className="flex flex-col items-center gap-1.5">
                    <span className="font-mono tabular-nums text-title text-fg-primary">
                      {formatElapsed(elapsedSec ?? 0)}
                    </span>
                    {deviceInfo && (
                      <span
                        className={cn(
                          'font-mono tabular-nums text-caption',
                          'rounded-full border px-2 py-0.5',
                          deviceInfo.device === 'cuda'
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : deviceInfo.fellBack
                              ? 'border-warning/40 bg-warning/10 text-warning'
                              : 'border-line bg-surface-2 text-fg-tertiary'
                        )}
                        title={`compute_type=${deviceInfo.computeType}${deviceInfo.fellBack ? ' (CUDA fell back to CPU)' : ''}`}
                      >
                        {deviceInfo.device === 'cuda'
                          ? 'GPU · CUDA'
                          : deviceInfo.fellBack
                            ? 'CPU (CUDA fallback)'
                            : 'CPU'}
                      </span>
                    )}
                  </div>
                )}
                <div className="space-y-3">
                  {preparingPhase || runningLabelOverride ? (
                    <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                      <div className="h-full w-1/3 bg-primary rounded-full animate-progress-indeterminate" />
                    </div>
                  ) : (
                    <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all duration-200 rounded-full"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  )}
                  <div className="flex items-center justify-between text-body-sm text-fg-tertiary">
                    <span>
                      {preparingPhase
                        ? t(`drawer.preparingLabel.${preparingPhase}`)
                        : (runningLabelOverride ?? t('drawer.runningLabel'))}
                    </span>
                    {!preparingPhase && !runningLabelOverride && (
                      <span className="font-mono tabular-nums">{progress}%</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {renderState === 'error' && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-6 py-6 space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <p className="text-body font-semibold">{t('drawer.errorTitle')}</p>
              </div>
              {errorMessage && (
                <p className="text-body-sm text-fg-tertiary break-all font-mono selectable">
                  {errorMessage.slice(-400)}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer.  Close on the left (ghost), run action on the right.
            Running state collapses to right-aligned Cancel only. */}
        <div
          className={cn(
            'mt-auto flex items-center gap-2 px-4 py-3 border-t border-line',
            renderState === 'running' ? 'justify-end' : 'justify-between'
          )}
        >
          {renderState === 'running' ? (
            <Button variant="danger" size="md" onClick={onCancel}>
              {t('drawer.cancelRun')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="md" onClick={() => onOpenChange(false)}>
                {t('drawer.close')}
              </Button>
              {/*
                REQ-0181 / REQ-0422 — guard wrapper.  When canStart is false
                the Button underneath is disabled + `pointer-events-none`, so
                clicks fall through to this span which routes back to タブ1 and
                fires the guard toast.  When canStart is true the props are
                undefined and the Button's own onClick runs.
              */}
              <span
                title={startBlocked && guardReason ? guardReason : undefined}
                onClick={startBlocked ? handleBlockedStart : undefined}
                className="inline-flex"
              >
                <Button variant="primary" size="md" onClick={onStart} disabled={!canStart}>
                  <Play className="h-4 w-4 mr-1.5" />
                  {t('drawer.startRun')}
                </Button>
              </span>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
