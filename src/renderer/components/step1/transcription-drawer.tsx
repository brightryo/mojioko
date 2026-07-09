import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Mic, Play, Settings2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { HelpIcon } from '@/components/help-icon'
import { WhisperAdvancedControls } from '@/components/whisper-advanced-controls/whisper-advanced-controls'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { cn } from '@/lib/utils'
import { formatElapsed } from '@/lib/format-elapsed'
import { useSettingsStore } from '@/stores/settings-store'
import { useProjectStore } from '@/stores/project-store'
import type { AudioTrack } from '../../../shared/types'

/**
 * REQ-20260615-055 — STEP1's transcription drawer.
 *
 * Mirrors the layout / lifecycle of `step2/burnin-drawer.tsx` so the two
 * routes feel like siblings: idle → progress (`running`) → success
 * closes + navigates to STEP2, failure stays in the drawer with an
 * error panel.  The X close affordance, backdrop click, and Esc are
 * blocked while running (via `hideClose` + the parent's
 * `handleSheetOpenChange` guard) so the user has to use the explicit
 * Cancel button mid-run.
 *
 * The advanced-knob form body reuses `WhisperAdvancedControls` —
 * identical to the form rendered in the Settings dialog's Whisper tab,
 * so editing on either surface stays in sync via the shared
 * `settingsStore.transcriptionAdvanced` slice.  REQ-055 retired the
 * separate `TranscriptionAdvancedDialog`; this drawer is now the only
 * Step-1 surface that opens the engine knobs.
 *
 * Track selection moved here from the main InputVideo card.  The main
 * card now displays a read-only summary of available tracks; the
 * drawer's track grid is where the user actually commits the choice.
 */
export type TranscriptionRenderState = 'idle' | 'running' | 'error'

export interface TranscriptionDrawerProps {
  open: boolean
  onOpenChange: (next: boolean) => void
  /** Available audio tracks.  Empty when no video is loaded. */
  audioTracks: AudioTrack[]
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
   * animation + the phase-specific label + `elapsedSec`, so the user
   * sees the "10-second 0%" region as live activity instead of a
   * frozen 0%.
   *
   *   - `'extractAudio'` — ffmpeg mono-16kHz WAV extract (sidecar main.py)
   *   - `'loadModel'`    — `WhisperModel(...)` construction
   *   - `'prepass'`      — Silero VAD + language-detection majority-vote
   *                        prepass inside `model.transcribe(...)`
   */
  preparingPhase?: 'extractAudio' | 'loadModel' | 'prepass' | null
  /**
   * REQ-0142 — elapsed seconds since the user pressed Start.  Rendered
   * next to the phase label during the preparing region so a still
   * screen is impossible.  Driven by the parent (renderer timer), so
   * the sidecar does not need to emit its own tick events.
   */
  elapsedSec?: number
  /**
   * REQ-0145 Step 1 — the sidecar's device choice, reported once per
   * run via the `deviceInfo` IPC event (see `ipc-contracts.ts`).
   * `null` while the loadModel phase has not yet resolved (the chip
   * simply is not rendered).  Rendered as a small monospace chip
   * inside the running block so the owner can visually confirm GPU
   * engagement without opening the DevTools console.  Step 2 will
   * replace this debug chip with a proper Settings-driven toggle.
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
  /** Fires when the user presses 文字起こし開始 inside the drawer. */
  onStart: () => void
  /** Fires when the user presses キャンセル mid-run; routes through the
   *  same cancel-confirmation dialog the parent already owned. */
  onCancel: () => void
}

export function TranscriptionDrawer({
  open,
  onOpenChange,
  audioTracks,
  renderState,
  progress,
  runningLabelOverride,
  preparingPhase,
  elapsedSec,
  deviceInfo,
  errorMessage,
  canStart,
  onStart,
  onCancel,
}: TranscriptionDrawerProps) {
  const { t } = useTranslation(['step1', 'step3', 'common'])

  const transcriptionAdvanced = useSettingsStore((s) => s.transcriptionAdvanced)
  const setTranscriptionAdvanced = useSettingsStore((s) => s.setTranscriptionAdvanced)
  const resetTranscriptionAdvanced = useSettingsStore((s) => s.resetTranscriptionAdvanced)
  const selectedTrack = useProjectStore((s) => s.selectedTrackIndex)
  const setSelectedTrack = useProjectStore((s) => s.setSelectedTrackIndex)

  // REQ-20260615-055 — autoselect the first available track on first open
  // so the user never sees an empty selection state.  Mirrors the
  // existing main-card heuristic (`handleVideoLoaded` already picks the
  // first track on load).  We re-assert it here in case the project
  // store was hydrated without one.
  const hasValidSelection = useMemo(
    () => audioTracks.some((tr) => tr.index === selectedTrack),
    [audioTracks, selectedTrack],
  )
  useEffect(() => {
    if (!open || hasValidSelection || audioTracks.length === 0) return
    setSelectedTrack(audioTracks[0].index)
  }, [open, hasValidSelection, audioTracks, setSelectedTrack])

  // Mirrors burnin-drawer's open-state guard — block close while
  // running so X / backdrop / Esc cannot abandon a live transcription.
  function handleSheetOpenChange(next: boolean) {
    if (!next && renderState === 'running') return
    onOpenChange(next)
  }

  return (
    <Sheet open={open} onOpenChange={handleSheetOpenChange}>
      <SheetContent
        side="right"
        className="max-w-[640px]"
        hideClose={renderState === 'running'}
      >
        <SheetHeader className="flex-row items-baseline gap-3 pr-10">
          <SheetTitle>{t('drawer.title')}</SheetTitle>
          <SheetDescription className="flex-1">
            {t('drawer.subtitle')}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 space-y-4">
          {renderState === 'idle' && (
            <>
              {/* Whisper Advanced controls — same form bound to the same
                  settings slice that the Settings dialog edits, so the two
                  surfaces stay in sync (REQ-019 #1).  Hosted inside an
                  outlined card to mirror burnin-drawer's section panels. */}
              <div className="rounded-xl border border-line bg-surface-1 p-4 space-y-3">
                <div className="flex items-center gap-1.5">
                  <Settings2 className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
                  <Label>{t('drawer.advancedSection')}</Label>
                </div>
                <WhisperAdvancedControls
                  transcriptionAdvanced={transcriptionAdvanced}
                  onUpdate={setTranscriptionAdvanced}
                  onReset={resetTranscriptionAdvanced}
                />
              </div>

              {/* Audio track grid — same visual treatment as the legacy
                  main-card grid (compact rows with a left-edge dot and
                  inline transcription-target Badge on selection). */}
              <div className="rounded-xl border border-line bg-surface-1 p-4 space-y-3">
                <div className="flex items-center gap-1.5">
                  <Mic className="h-4 w-4 text-fg-tertiary flex-shrink-0" />
                  <Label>{t('drawer.trackSection')}</Label>
                  <HelpIcon content={t('audioTracks.help')} />
                  {audioTracks.length > 0 && (
                    <Badge variant="muted" className="ml-1">
                      {t('audioTracks.tracksCount', { count: audioTracks.length })}
                    </Badge>
                  )}
                </div>
                <p className="text-body-sm text-fg-muted">
                  {t('audioTracks.description')}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {audioTracks.map((track) => (
                    <button
                      key={track.index}
                      type="button"
                      onClick={() => setSelectedTrack(track.index)}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-3 py-1.5 text-left transition-colors duration-150',
                        selectedTrack === track.index
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-line hover:bg-surface-2/40',
                      )}
                    >
                      <span className="h-2 w-2 rounded-full flex-shrink-0 bg-primary" />
                      <span
                        className={cn(
                          'text-body font-medium flex-shrink-0',
                          selectedTrack === track.index
                            ? 'text-primary'
                            : 'text-fg-primary',
                        )}
                      >
                        {t('audioTracks.trackLabel', { index: track.index })}
                      </span>
                      <span className="text-body-sm text-fg-muted truncate min-w-0">
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
            </>
          )}

          {renderState === 'running' && (
            <div className="flex items-center justify-center py-12">
              <div className="rounded-xl border border-line bg-surface-1 px-6 py-8 w-full max-w-md space-y-5">
                {/* REQ-0143 — the REQ-0142 `Loader2` green spinner was
                    removed.  Owner rationale: the elapsed timer is
                    always moving, so a separate "still alive" affordance
                    is redundant.  In its place — but only while the run
                    is still in prep or Whisper — the top slot now
                    surfaces the elapsed timer `mm:ss` at title-size so
                    it is the visual center of the drawer.  During REQ-086
                    preview-mix (`runningLabelOverride` set) the elapsed
                    top slot is hidden to preserve the REQ-086 look; the
                    label + 100 % bar carry the state visibly enough for
                    the short mix step. */}
                {!runningLabelOverride && (
                  <div className="flex flex-col items-center gap-1.5">
                    <span className="font-mono tabular-nums text-title text-fg-primary">
                      {formatElapsed(elapsedSec ?? 0)}
                    </span>
                    {/* REQ-0145 §3 — device chip.  Only rendered once
                        the sidecar has reported its device choice;
                        stays invisible during the pre-`loadModel`
                        window so the layout does not jump.  The
                        `fellBack` variant explicitly calls out the
                        CUDA→CPU fallback so the owner knows the
                        speedup they expected did not happen. */}
                    {deviceInfo && (
                      <span
                        className={cn(
                          'font-mono tabular-nums text-label',
                          'rounded-full border px-2 py-0.5',
                          deviceInfo.device === 'cuda'
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : deviceInfo.fellBack
                              ? 'border-warning/40 bg-warning/10 text-warning'
                              : 'border-line bg-surface-2 text-fg-tertiary',
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
                  {/* REQ-0142 — during the pre-Whisper preparing region
                      (`preparingPhase != null`) the determinate bar is
                      swapped for an indeterminate stripe: RES-0141
                      confirmed no accurate percentage exists until the
                      first `progress` event, and the previous "stuck
                      at 0%" bar read as a freeze.  Once Whisper starts
                      emitting `progress` events (or the parent moves
                      to preview-mix which pins at 100 %) the bar is
                      determinate again. */}
                  {preparingPhase ? (
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
                    {/* REQ-0143 — the right-side percent chip now shows
                        ONLY while a real percentage exists (= Whisper
                        inference or preview-mix pinned at 100 %).  In
                        the prep region no accurate percent is available
                        so the chip is intentionally blank; the elapsed
                        moved up top (see above) covers "is it moving?". */}
                    {!preparingPhase && (
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
                <p className="text-headline font-semibold">
                  {t('drawer.errorTitle')}
                </p>
              </div>
              {errorMessage && (
                <p className="text-body-sm text-fg-tertiary break-all font-mono selectable">
                  {errorMessage.slice(-400)}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer.  Matches burnin-drawer's pattern: Close on the left
            (ghost, neutral grey, REQ-20260615-041 trio), primary action
            on the right.  Running state collapses to right-aligned
            Cancel only and X is also hidden via `hideClose`. */}
        <div
          className={cn(
            'mt-auto flex items-center gap-2 px-4 py-3 border-t border-line',
            renderState === 'running' ? 'justify-end' : 'justify-between',
          )}
        >
          {renderState === 'running' ? (
            <Button variant="danger" size="md" onClick={onCancel}>
              {t('drawer.cancelRun')}
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                size="md"
                onClick={() => onOpenChange(false)}
              >
                {t('drawer.close')}
              </Button>
              <Button
                variant="primary"
                size="md"
                onClick={onStart}
                disabled={!canStart}
              >
                <Play className="h-4 w-4 mr-1.5" />
                {t('drawer.startRun')}
              </Button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
