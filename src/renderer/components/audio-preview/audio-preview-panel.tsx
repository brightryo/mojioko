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
import { scrubState } from '@/lib/scrub-state'

// REQ-080 #1: findActiveEntryId moved to @/lib/active-entry — shared
// with VideoPreviewPanel + unit-tested for [start, end) end-exclusive
// boundary semantics.

/**
 * REQ-20260615-052 — `<input type=...>` values where Space inserts a
 * literal space character.  Mirrors the same constant in
 * VideoPreviewPanel (the Space shortcut bails on these, on `<textarea>`,
 * and on contenteditable; every other input type — range / number /
 * checkbox / radio / button — falls through to the global play/pause
 * handler).  See the VideoPreviewPanel definition for the full
 * rationale.
 */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'url',
  'email',
  'password',
  'tel',
])

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
      // REQ-096: while a manual ruler scrub is in progress, the
      // optimistic-playhead path owns videoCurrentTimeSec; skip the
      // write here for the same reason as VPP's seek effect.
      if (!scrubState.inProgress) {
        setVideoCurrentTimeSec(videoSeekRequestSec)
      }
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

  // REQ-20260615-051 B / REQ-20260615-052 — capture-phase Space shortcut,
  // mirroring the VideoPreviewPanel binding (see that file for the full
  // rationale).  REQ-052 narrowed the input bail to text-like types
  // only so `<input type="range">` (sliders) and `<input type="number">`
  // still hand Space over to the play/pause shortcut.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey) return
      const active = document.activeElement as HTMLElement | null
      if (active) {
        if (active.isContentEditable) return
        const tag = active.tagName.toLowerCase()
        if (tag === 'textarea') return
        if (tag === 'input') {
          const inputType = ((active as HTMLInputElement).type || 'text').toLowerCase()
          if (TEXT_INPUT_TYPES.has(inputType)) return
        }
      }
      e.preventDefault()
      e.stopPropagation()
      togglePlay()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  function handleTimeUpdate() {
    const el = audioRef.current
    if (!el || isSeeking.current) return
    const time = el.currentTime
    setCurrentTime(time)
    // REQ-096: same scrub-state guard as VPP's handleTimeUpdate.
    if (!scrubState.inProgress) {
      setVideoCurrentTimeSec(time)
    }

    // REQ-20260614-001 Phase 3 — `focusedRowId` is the playback follower
    // (split from the user-selection slice).  Same role as
    // VideoPreviewPanel's `handleTimeUpdate` writer: drives the blue
    // (sky) "currently playing" marker in the table without touching
    // the user's explicit `selectedEntryId`.  Skipped while a <textarea>
    // is focused (active subtitle cell edit) and only writes on entry
    // change so playhead ticks don't flood the store.
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
  const editedTotalSec = editedDuration(duration, cuts)
  const editedCurrentTime = origToEdited(currentTime, cuts)

  return (
    // REQ-20260614-001 Phase 2 — sized to fill the top-left resizable
    // pane (same shape as VideoPreviewPanel's reworked layout).  Outer
    // card chrome retired; the pane border replaces it.
    <div className="flex h-full w-full flex-col">
      {/* Header — filename + open-in-folder shortcut, identical
          structure to VideoPreviewPanel. */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/50 flex-shrink-0 min-w-0">
        <span className="min-w-0 truncate text-body-sm text-foreground/80" title={video.path}>
          {filename}
        </span>
        <button
          type="button"
          onClick={() => { shellShowInFolder(video.path).catch(() => {}) }}
          title={t('videoPreview.showInFolder')}
          className={cn(
            'flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-150',
            'hover:text-foreground focus:outline-none focus-visible:text-foreground'
          )}
        >
          <FolderOpen className="h-4 w-4" />
        </button>
      </div>

      {/* Body — centred play / pause button takes the flex-1 area. */}
      <div className="flex-1 min-h-0 flex items-center justify-center p-4 bg-surface-0">
        {hasError ? (
          <span className="text-body-sm text-muted-foreground">{t('videoPreview.error')}</span>
        ) : (
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? t('videoPreview.pause') : t('videoPreview.play')}
            className={cn(
              'flex items-center justify-center rounded-full transition-colors duration-150',
              'h-14 w-14 bg-primary text-primary-foreground hover:bg-primary/90',
              'focus:outline-none focus-visible:outline-none'
            )}
          >
            {isPlaying
              ? <Pause className="h-6 w-6" />
              : <Play className="h-6 w-6 ml-0.5" />}
          </button>
        )}
      </div>

      {/* Seekbar + time row — placed where VideoPreviewPanel's seekbar
          sits so the audio / video panels share the same lower-edge
          control surface. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/50 flex-shrink-0">
        <input
          type="range"
          min={0}
          max={editedTotalSec || 0}
          step={0.01}
          value={editedCurrentTime}
          onChange={handleSeekChange}
          onPointerDown={() => { isSeeking.current = true }}
          onPointerUp={() => { isSeeking.current = false }}
          className="flex-1 h-1.5 cursor-pointer accent-primary"
          aria-label={t('videoPreview.play')}
        />
        <span className="flex-shrink-0 select-none font-mono tabular-nums text-body-sm text-muted-foreground">
          {formatTime(editedCurrentTime)}&nbsp;/&nbsp;{formatTime(editedTotalSec)}
        </span>
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
