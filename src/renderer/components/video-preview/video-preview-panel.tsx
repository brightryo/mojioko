import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { Play, Pause, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { cn } from '@/lib/utils'
import { shellShowInFolder } from '@/services/dialog'
import { SubtitleOverlay } from '@/components/subtitle-overlay/subtitle-overlay'
import { loadSubtitleFont, getSubtitleFont, type SubtitleFont } from '@/lib/font-metrics'
import type { SubtitleEntry } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a local file path to a `mojioko-media://` URL served by the
 * custom protocol registered in the main process.
 *
 * encodeURIComponent encodes ALL special characters (including `\`, `:`, `/`),
 * so the entire path becomes the opaque "host" component of the URL.
 * The protocol handler reverses this with decodeURIComponent.
 *
 *   "D:\\path\\video.mp4" → "mojioko-media://D%3A%5Cpath%5Cvideo.mp4"
 */
function pathToVideoUrl(filePath: string): string {
  return `mojioko-media://${encodeURIComponent(filePath)}`
}

/** Extract the filename (with extension) from a full path, cross-platform. */
function getBasename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

/**
 * Format seconds to "M:SS" or "H:MM:SS".
 * Returns "0:00" for non-finite / negative values (before metadata loads).
 */
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
 * Binary-search the sorted `entries` array for the entry active at `timeSec`.
 * Returns the entry's id, or null if none covers the timestamp.
 *
 * Assumes entries are sorted by startSec ascending (guaranteed by the
 * transcription pipeline; SubtitleTable preserves this order).
 */
function findActiveEntryId(entries: SubtitleEntry[], timeSec: number): string | null {
  let lo = 0
  let hi = entries.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const e = entries[mid]
    if (timeSec < e.startSec) {
      hi = mid - 1
    } else if (timeSec > e.endSec) {
      lo = mid + 1
    } else {
      return e.id
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Self-contained video preview panel for Step 2.
 *
 * Layout (2-column grid):
 *   Left  (auto):  video element — 180 px tall, width follows aspect ratio
 *   Right (1fr):   music-player style, 3 rows via flex-col justify-between
 *     top:    filename  [📁]          (centered, opens in Explorer on click)
 *     middle: large ▶/⏸ button       (56×56 px circle, 36 px icon, centered)
 *     bottom: [━━━━━●━━━━━━━] MM:SS / MM:SS  (seekbar flex-1 + time right)
 *
 * D-2 synchronisation:
 *   - Row click in SubtitleTable sets `videoSeekRequestSec` in ui-store;
 *     this panel consumes it, seeks the video, then clears the request.
 *   - On each `timeupdate`, this panel binary-searches the active subtitle
 *     entry and updates `focusedRowId` in ui-store (unless the user is
 *     currently editing subtitle text, detected via `document.activeElement`).
 *
 * Isolation contract:
 *   - Reads `projectStore.video` and `projectStore.entries`.
 *   - Reads / writes `uiStore.videoSeekRequestSec` and `uiStore.focusedRowId`.
 *   - Returns null when no video is loaded — no layout impact.
 *   - Remove the single JSX line in step2.tsx (or set ENABLE_VIDEO_PREVIEW=false)
 *     to revert Step 2 to its original state.
 *
 * Space-key shortcut:
 *   Toggles play/pause unless a text-input or contentEditable is focused,
 *   so it does NOT interfere with subtitle text editing in the table.
 */
export function VideoPreviewPanel() {
  const { t } = useTranslation(['step2', 'step3'])
  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)

  const burnin             = useSettingsStore((s) => s.burnin)
  const subtitleBackground = useSettingsStore((s) => s.subtitleBackground)

  const videoSeekRequestSec    = useUiStore((s) => s.videoSeekRequestSec)
  const setVideoSeekRequest    = useUiStore((s) => s.setVideoSeekRequest)
  const focusedRowId           = useUiStore((s) => s.focusedRowId)
  const setFocusedRowId        = useUiStore((s) => s.setFocusedRowId)
  const setVideoCurrentTimeSec = useUiStore((s) => s.setVideoCurrentTimeSec)

  const videoRef  = useRef<HTMLVideoElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const [isPlaying,  setIsPlaying]  = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration,    setDuration]    = useState(0)
  const [hasError,    setHasError]    = useState(false)
  // Measured rendered width of the video container — fed to SubtitleOverlay so
  // font/outline sizes scale correctly with the actual on-screen video.
  const [videoContainerWidth, setVideoContainerWidth] = useState(0)
  // Ensure the subtitle font is loaded so SubtitleOverlay uses the libass scale
  // (≈0.6906) instead of falling back to 1.0.
  const [subtitleFont, setSubtitleFont] = useState<SubtitleFont | null>(getSubtitleFont)
  // Ref (not state) so the timeupdate handler can read it synchronously.
  const isSeeking = useRef(false)
  // Track last active entry id so we only write to the store on change.
  const activeEntryIdRef = useRef<string | null>(null)

  const videoUrl = video ? pathToVideoUrl(video.path) : null
  const pct      = duration > 0 ? (currentTime / duration) * 100 : 0

  /**
   * Pre-filter to non-deleted entries only, sorted by startSec.
   * Sorted array is required for the binary search in findActiveEntryId.
   */
  const sortedActiveEntries = useMemo(() => {
    return entries
      .filter((e) => !e.isDeleted)
      .sort((a, b) => a.startSec - b.startSec)
  }, [entries])

  /**
   * Decide which subtitle entry to overlay on the video.
   *   Playing  → entry covering `currentTime` (null between subtitles)
   *   Stopped  → focused row in the table (the user's current selection)
   */
  const overlayEntry = useMemo<SubtitleEntry | null>(() => {
    if (isPlaying) {
      const id = findActiveEntryId(sortedActiveEntries, currentTime)
      return id ? sortedActiveEntries.find((e) => e.id === id) ?? null : null
    }
    return focusedRowId
      ? sortedActiveEntries.find((e) => e.id === focusedRowId) ?? null
      : null
  }, [isPlaying, currentTime, focusedRowId, sortedActiveEntries])

  // Load the subtitle font on mount if not already cached (covers direct entry to Step 2).
  useEffect(() => {
    if (!subtitleFont) {
      loadSubtitleFont().then(setSubtitleFont).catch(() => {})
    }
  }, [subtitleFont])

  // Measure the video container so SubtitleOverlay can scale text/outline to the
  // actual rendered size (the <video> has w-auto, so width depends on aspect ratio).
  useEffect(() => {
    const el = videoContainerRef.current
    if (!el) return
    const obs = new ResizeObserver(() => setVideoContainerWidth(el.clientWidth))
    obs.observe(el)
    setVideoContainerWidth(el.clientWidth)
    return () => obs.disconnect()
  }, [])

  // -------------------------------------------------------------------------
  // Play / pause
  // -------------------------------------------------------------------------

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) { el.play().catch(() => {}) }
    else           { el.pause() }
  }, [])

  // Space key — play/pause when no text field is focused
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
  }, [togglePlay])

  // Reset playback state when the video source changes
  useEffect(() => {
    setIsPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setHasError(false)
    isSeeking.current = false
    activeEntryIdRef.current = null
    setVideoCurrentTimeSec(0)
  }, [videoUrl, setVideoCurrentTimeSec])

  // -------------------------------------------------------------------------
  // Consume seek requests from SubtitleTable row clicks
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (videoSeekRequestSec === null) return
    const el = videoRef.current
    if (el) {
      el.currentTime = videoSeekRequestSec
      setCurrentTime(videoSeekRequestSec)
      setVideoCurrentTimeSec(videoSeekRequestSec)
    }
    // Clear the request immediately after consuming it.
    setVideoSeekRequest(null)
  }, [videoSeekRequestSec, setVideoSeekRequest, setVideoCurrentTimeSec])

  // -------------------------------------------------------------------------
  // Video event handlers
  // -------------------------------------------------------------------------

  function handleTimeUpdate() {
    const el = videoRef.current
    if (!el || isSeeking.current) return
    const time = el.currentTime
    setCurrentTime(time)
    setVideoCurrentTimeSec(time)

    // Drive focusedRowId from playback — but not while the user is editing
    // a subtitle cell (CellEditor mounts a <textarea>).
    const active = document.activeElement
    const isEditingSubtitle = active?.tagName.toLowerCase() === 'textarea'
    if (!isEditingSubtitle) {
      const newId = findActiveEntryId(sortedActiveEntries, time)
      // Only update when a subtitle is actively playing (newId !== null).
      // During gap time between subtitles, retain the previous focus instead
      // of clearing it — prevents the row highlight from flickering off/on
      // at every subtitle boundary.
      if (newId !== null && newId !== activeEntryIdRef.current) {
        activeEntryIdRef.current = newId
        setFocusedRowId(newId)
      }
    }
  }

  function handleLoadedMetadata() {
    const el = videoRef.current
    if (!el) return
    setDuration(el.duration)
  }

  function handlePlay()  { setIsPlaying(true) }
  function handlePause() { setIsPlaying(false) }
  function handleEnded() {
    setIsPlaying(false)
    setCurrentTime(0)
    setVideoCurrentTimeSec(0)
    if (videoRef.current) videoRef.current.currentTime = 0
    activeEntryIdRef.current = null
    setFocusedRowId(null)
  }
  function handleError() { setHasError(true) }

  // -------------------------------------------------------------------------
  // Seekbar
  // -------------------------------------------------------------------------

  function handleSeekDown()  { isSeeking.current = true }
  function handleSeekUp()    { isSeeking.current = false }

  function handleSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = parseFloat(e.target.value)
    setCurrentTime(val)
    setVideoCurrentTimeSec(val)
    if (videoRef.current) videoRef.current.currentTime = val
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!video || !videoUrl) return null

  const filename = getBasename(video.path)

  return (
    <div className="flex-shrink-0 rounded-lg border border-zinc-800 bg-[#141414] px-3 py-2 space-y-1">
      {/*
       * 2-column grid:
       *   left  = auto  → video shrinks / grows with its aspect ratio
       *   right = 1fr   → takes remaining panel width
       */}
      <div className="grid gap-4" style={{ gridTemplateColumns: 'auto 1fr' }}>

        {/* ── Left: video + subtitle overlay ──────────────────────────── */}
        <div
          ref={videoContainerRef}
          className="relative flex items-center justify-center overflow-hidden rounded bg-zinc-950 h-[180px]"
        >
          {hasError ? (
            <span className="px-6 text-xs text-zinc-500">{t('videoPreview.error')}</span>
          ) : (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                preload="metadata"
                className="h-[180px] w-auto object-contain"
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={handlePlay}
                onPause={handlePause}
                onEnded={handleEnded}
                onError={handleError}
              />
              {overlayEntry && videoContainerWidth > 0 && (
                <SubtitleOverlay
                  entry={overlayEntry}
                  burnin={burnin}
                  videoWidthPx={video.widthPx}
                  containerWidthPx={videoContainerWidth}
                  subtitleBackground={subtitleBackground}
                />
              )}
            </>
          )}
        </div>

        {/* ── Right: music-player 3-row layout ─────────────────────────── */}
        <div className="flex flex-col justify-between py-2">

          {/* Top: filename + open-in-folder icon */}
          <div className="flex items-center justify-center gap-1.5 min-w-0 px-1">
            <span
              className="min-w-0 truncate text-sm text-zinc-400"
              title={video.path}
            >
              {filename}
            </span>
            <button
              type="button"
              onClick={() => shellShowInFolder(video.path).catch(() => {})}
              title={t('videoPreview.showInFolder')}
              className={cn(
                'flex-shrink-0 rounded p-0.5 text-zinc-500 transition-colors duration-150',
                'hover:text-zinc-300 focus:outline-none focus:text-zinc-300'
              )}
              aria-label={t('videoPreview.showInFolder')}
            >
              <FolderOpen className="h-4 w-4" />
            </button>
          </div>

          {/* Middle: large play/pause button */}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={togglePlay}
              disabled={hasError || duration === 0}
              className={cn(
                'flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full',
                'bg-zinc-800 text-zinc-100 transition-all duration-150',
                'hover:bg-zinc-700 active:scale-95',
                'focus:outline-none focus:ring-2 focus:ring-green-500/30',
                'disabled:cursor-not-allowed disabled:opacity-40'
              )}
              aria-label={isPlaying ? t('videoPreview.pause') : t('videoPreview.play')}
            >
              {isPlaying
                ? <Pause className="h-9 w-9" />
                : <Play  className="h-9 w-9 translate-x-0.5" />
              }
            </button>
          </div>

          {/* Bottom: seekbar (flex-1) + time display */}
          <div className="flex items-center gap-2 px-1">
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 100}
              step={0.1}
              value={currentTime}
              disabled={duration === 0 || hasError}
              onMouseDown={handleSeekDown}
              onChange={handleSeekChange}
              onMouseUp={handleSeekUp}
              onTouchStart={handleSeekDown}
              onTouchEnd={handleSeekUp}
              className={cn(
                'flex-1 h-1.5 cursor-pointer appearance-none rounded-full',
                'disabled:cursor-default disabled:opacity-40',
                '[&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3',
                '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:border-0',
                '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-green-500',
                '[&::-webkit-slider-thumb]:cursor-pointer',
                '[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-100',
                '[&::-webkit-slider-thumb]:hover:scale-125'
              )}
              style={{
                background: `linear-gradient(to right, #22c55e 0%, #22c55e ${pct}%, #3f3f46 ${pct}%, #3f3f46 100%)`
              }}
            />
            <span className="flex-shrink-0 select-none font-mono tabular-nums text-xs text-zinc-400">
              {formatTime(currentTime)}&nbsp;/&nbsp;{formatTime(duration)}
            </span>
          </div>

        </div>

      </div>

      {/* Approximate-preview disclaimer — same i18n key as Step 3 (preview.disclaimer) */}
      <p className="text-xs text-zinc-500">{t('step3:preview.disclaimer')}</p>
    </div>
  )
}
