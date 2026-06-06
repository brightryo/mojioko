import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Pause, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/project-store'
import { useUiStore } from '@/stores/ui-store'
import { useCutSkip } from '@/hooks/use-cut-skip'
import { cn } from '@/lib/utils'
import { shellShowInFolder } from '@/services/dialog'
import { findActiveEntryId } from '@/lib/active-entry'
import { editedDuration, editedToOrig, origToEdited } from '../../../shared/cuts'
import { bumpRenderCount } from '@/lib/perf-counter'

// REQ-080 #1: findActiveEntryId moved to @/lib/active-entry — shared
// with VideoPreviewPanel + unit-tested for [start, end) end-exclusive
// boundary semantics.

/**
 * Convert a local file path to a `mojioko-media://` URL served by the
 * custom protocol registered in the main process.  Same scheme used by
 * VideoPreviewPanel — the protocol streams arbitrary local media bytes
 * regardless of audio/video.
 */
function pathToMediaUrl(filePath: string): string {
  return `mojioko-media://${encodeURIComponent(filePath)}`
}

function getBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

function formatTime(sec: number): string {
  if (!isFinite(sec) || isNaN(sec) || sec < 0) return '0:00'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * STEP 2 preview panel for audio-only inputs (REQ-028).  Used in the
 * same slot as VideoPreviewPanel — the parent route picks one or the
 * other via `useIsAudioOnly()`.
 *
 * Deliberately minimal per REQ-027 §8 #2: a centred play / pause button
 * + a single seek bar.  No volume slider, no time readout (kept under
 * the seek bar as a thin label so the user has something to anchor
 * playback against), no subtitle overlay (there's nothing to overlay
 * onto), no subtitle layout / background settings (those drive burn-in,
 * which is unreachable in audio mode).
 *
 * Same outer card shape and approximate vertical footprint as
 * VideoPreviewPanel so the rest of the STEP 2 layout stays in place
 * when the user opens an audio file.
 */
export function AudioPreviewPanel() {
  bumpRenderCount('AudioPreviewPanel')
  const { t } = useTranslation(['step2'])
  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)
  // REQ-075 #5: seekbar lives on the EDITED axis.  Identity transforms
  // when cuts is empty, so existing audio-mode users see no change.
  const cuts = useProjectStore((s) => s.cuts)
  const videoSeekRequestSec = useUiStore((s) => s.videoSeekRequestSec)
  const setVideoSeekRequest = useUiStore((s) => s.setVideoSeekRequest)
  const setVideoCurrentTimeSec = useUiStore((s) => s.setVideoCurrentTimeSec)
  const setFocusedRowId = useUiStore((s) => s.setFocusedRowId)

  const audioRef = useRef<HTMLAudioElement>(null)
  // REQ-074 1b: jump past any time inside a confirmed cut while playing.
  useCutSkip(audioRef)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [hasError, setHasError] = useState(false)
  // Ref so the timeupdate listener can read it synchronously while the
  // user is dragging the seek bar.
  const isSeeking = useRef(false)
  // REQ-030 #2: tracks the last entry we wrote to focusedRowId so the
  // timeupdate handler only writes on change (avoids store thrash at
  // 60 timeupdates/sec while the same caption is on screen).
  const activeEntryIdRef = useRef<string | null>(null)

  // Sorted, non-deleted entries — required for the binary search in
  // findActiveEntryId.  Memoised on entries so the sort runs once per
  // entries mutation, not per timeupdate tick.
  const sortedActiveEntries = useMemo(
    () => entries.filter((e) => !e.isDeleted).sort((a, b) => a.startSec - b.startSec),
    [entries]
  )

  const mediaUrl = video ? pathToMediaUrl(video.path) : null

  // Reset playback state when the source changes.
  useEffect(() => {
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setHasError(false)
    isSeeking.current = false
    activeEntryIdRef.current = null
    setVideoCurrentTimeSec(0)
  }, [mediaUrl, setVideoCurrentTimeSec])

  // Consume seek requests from SubtitleTable row clicks (same channel
  // VideoPreviewPanel uses — clicking a subtitle row should still jump
  // the audio playhead).
  useEffect(() => {
    if (videoSeekRequestSec === null) return
    const el = audioRef.current
    if (el) {
      el.currentTime = videoSeekRequestSec
      setCurrentTime(videoSeekRequestSec)
      setVideoCurrentTimeSec(videoSeekRequestSec)
    }
    setVideoSeekRequest(null)
  }, [videoSeekRequestSec, setVideoSeekRequest, setVideoCurrentTimeSec])

  function togglePlay() {
    const el = audioRef.current
    if (!el) return
    if (el.paused) {
      // REQ-079 #1: rewind to head when ▶ is pressed at EOF (mirrors
      // VideoPreviewPanel).  Without this, "play" from end-of-clip
      // would either silently do nothing or immediately fire 'ended'
      // again — standard player UX is to restart from the start.
      const PLAYBACK_RESET_EPS_SEC = 0.05
      if (el.duration > 0 && el.currentTime >= el.duration - PLAYBACK_RESET_EPS_SEC) {
        el.currentTime = 0
      }
      el.play().catch(() => {})
    } else {
      el.pause()
    }
  }

  // Space key — play/pause when no text field is focused.  Mirrors the
  // VideoPreviewPanel binding so the user's muscle memory carries over
  // between modes.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey) return
      const active = document.activeElement as HTMLElement | null
      const tag = active?.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || active?.isContentEditable) return
      e.preventDefault()
      togglePlay()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  function handleTimeUpdate() {
    const el = audioRef.current
    if (!el || isSeeking.current) return
    const time = el.currentTime
    setCurrentTime(time)
    setVideoCurrentTimeSec(time)

    // REQ-030 #2: drive focusedRowId from playback the same way
    // VideoPreviewPanel does, so the active subtitle row highlights in
    // the table as the audio plays through it.  Skipped while a
    // <textarea> is focused — that means the user is editing a
    // subtitle cell and the focus would yank them out mid-keystroke.
    // Only write on change (newId !== ref) to keep the store quiet
    // during the many timeupdate events fired per second.  We also
    // retain the previous focus across gap-time between subtitles
    // (newId === null) to avoid flickering off then back on at every
    // subtitle boundary — mirrors VideoPreviewPanel's contract.
    const active = document.activeElement
    const isEditingSubtitle = active?.tagName.toLowerCase() === 'textarea'
    if (!isEditingSubtitle) {
      const newId = findActiveEntryId(sortedActiveEntries, time)
      if (newId !== null && newId !== activeEntryIdRef.current) {
        activeEntryIdRef.current = newId
        setFocusedRowId(newId)
      }
    }
  }

  function handleLoadedMetadata() {
    const el = audioRef.current
    if (!el) return
    setDuration(el.duration)
  }

  function handleSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Slider's value is EDITED; convert back to ORIGINAL before writing
    // to <audio>.currentTime (Original) and the playhead store slice
    // (also Original).  editedToOrig is identity for empty cuts.
    const editedVal = parseFloat(e.target.value)
    const origVal = editedToOrig(editedVal, cuts)
    setCurrentTime(origVal)
    setVideoCurrentTimeSec(origVal)
    if (audioRef.current) {
      audioRef.current.currentTime = origVal
    }
  }

  /**
   * REQ-079 #1: just flip the play state.  No more "warp to 0" on EOF.
   * Whether the user pressed ⏭, dragged the seekbar to the end, or
   * played through naturally, the playhead stays at the final frame.
   * Pressing ▶ from rest auto-rewinds to 0 via togglePlay's at-end
   * branch.  Supersedes the REQ-078 manualSeekHoldRef approach.
   */
  function handleEnded() {
    setIsPlaying(false)
  }

  if (!video || !mediaUrl) return null

  const filename = getBasename(video.path)

  return (
    <div className="flex-shrink-0 rounded-lg border border-border bg-card">
      {/* Header — same shape as VideoPreviewPanel's collapsed header so the
          two panels feel like siblings.  No accordion behaviour here; the
          audio panel is always expanded (its body is short enough that
          collapsing it gains nothing). */}
      <div className="flex items-center gap-2 px-3 py-2">
        <Play className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-label font-medium uppercase tracking-wider text-muted-foreground flex-shrink-0">
          {t('videoPreview.play')}
        </span>
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 px-2">
          <span className="min-w-0 truncate text-body-sm text-foreground/80" title={video.path}>
            {filename}
          </span>
          <button
            type="button"
            onClick={() => { shellShowInFolder(video.path).catch(() => {}) }}
            title={t('videoPreview.showInFolder')}
            className={cn(
              'flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-150',
              'hover:text-foreground hover:bg-accent'
            )}
          >
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body — centred play / pause + seek bar.  Same outer height as
          VideoPreviewPanel's left column (180 px video frame) so the
          STEP 2 layout below this panel does not shift when toggling
          between video and audio inputs.
          REQ-029 #1+#2: button stepped down from h-14 → h-10 (control
          weight matches the surrounding text-tabular UI better), and
          the time readout is lifted above the seek bar in its own row
          so the bar gets the full panel width. */}
      <div className="flex items-center justify-center px-4 pb-4 pt-2" style={{ minHeight: 180 }}>
        {hasError ? (
          <span className="text-body-sm text-muted-foreground">{t('videoPreview.error')}</span>
        ) : (
          <div className="flex flex-col items-center gap-3 w-full max-w-md">
            <button
              type="button"
              onClick={togglePlay}
              aria-label={isPlaying ? t('videoPreview.pause') : t('videoPreview.play')}
              className={cn(
                'flex items-center justify-center rounded-full transition-colors duration-150',
                'h-10 w-10 bg-primary text-primary-foreground hover:bg-primary/90',
                'focus:outline-none focus-visible:outline-none'
              )}
            >
              {isPlaying
                ? <Pause className="h-5 w-5" />
                : <Play className="h-5 w-5 ml-0.5" />}
            </button>

            {(() => {
              // REQ-075 #5 — seek + readout in EDITED coordinates.
              // Identical to (currentTime, duration) when cuts is empty.
              const editedTotalSec = editedDuration(duration, cuts)
              const editedCurrentTime = origToEdited(currentTime, cuts)
              return (
                <div className="w-full flex flex-col gap-1">
                  <span className="text-caption tabular-nums text-muted-foreground text-center">
                    {formatTime(editedCurrentTime)} / {formatTime(editedTotalSec)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={editedTotalSec || 0}
                    step={0.01}
                    value={editedCurrentTime}
                    onChange={handleSeekChange}
                    onPointerDown={() => { isSeeking.current = true }}
                    onPointerUp={() => { isSeeking.current = false }}
                    className="w-full accent-primary"
                    aria-label={t('videoPreview.play')}
                  />
                </div>
              )
            })()}
          </div>
        )}
      </div>

      <audio
        ref={audioRef}
        src={mediaUrl}
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={handleEnded}
        onError={() => setHasError(true)}
        className="hidden"
      />
    </div>
  )
}
