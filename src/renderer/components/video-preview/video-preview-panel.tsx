import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { Play, Pause, FolderOpen, ChevronUp, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { useCutSkip } from '@/hooks/use-cut-skip'
import { cn } from '@/lib/utils'
import { shellShowInFolder } from '@/services/dialog'
import { SubtitleOverlay } from '@/components/subtitle-overlay/subtitle-overlay'
import { Switch } from '@/components/ui/switch'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { ensureFontLoaded } from '@/lib/font-registry'
import { editedDuration, editedToOrig, origToEdited } from '../../../shared/cuts'
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
  const { t } = useTranslation(['step2'])
  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)
  // REQ-075 #5: the seekbar lives on the EDITED axis (= origToEdited of
  // <video>.currentTime); when cuts is empty the transforms are identity,
  // so existing non-trim users see byte-identical behaviour.
  const cuts = useProjectStore((s) => s.cuts)

  // burnin / subtitleBackground used to live behind the Step 3 form;
  // in the new layout this panel owns the editing UI so the user can
  // adjust position / background while watching the same preview that
  // visualises them.  Reads + writes both share the existing settings-
  // store slices; no schema change.
  const burnin             = useSettingsStore((s) => s.burnin)
  const updateBurnin       = useSettingsStore((s) => s.updateBurnin)
  const subtitleBackground = useSettingsStore((s) => s.subtitleBackground)
  const setSubtitleBackground = useSettingsStore((s) => s.setSubtitleBackground)
  const activeFontId       = useSettingsStore((s) => s.activeFontId)

  const videoSeekRequestSec    = useUiStore((s) => s.videoSeekRequestSec)
  const setVideoSeekRequest    = useUiStore((s) => s.setVideoSeekRequest)
  const focusedRowId           = useUiStore((s) => s.focusedRowId)
  const setFocusedRowId        = useUiStore((s) => s.setFocusedRowId)
  const setVideoCurrentTimeSec = useUiStore((s) => s.setVideoCurrentTimeSec)
  const isExpanded             = useUiStore((s) => s.videoPreviewExpanded)
  const setExpanded            = useUiStore((s) => s.setVideoPreviewExpanded)

  const videoRef  = useRef<HTMLVideoElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  // REQ-074 1b: while playing, jump past any frame that falls inside a
  // user-confirmed cut (ripple-preview behaviour).  No-op when cuts is empty.
  useCutSkip(videoRef)
  const [isPlaying,  setIsPlaying]  = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration,    setDuration]    = useState(0)
  const [hasError,    setHasError]    = useState(false)
  // Measured rendered width of the video container — fed to SubtitleOverlay so
  // font/outline sizes scale correctly with the actual on-screen video.
  const [videoContainerWidth, setVideoContainerWidth] = useState(0)
  // Ensure the subtitle font is loaded so SubtitleOverlay uses the libass
  // scale (~0.6906 for the active font) instead of the pre-load fallback.
  // A tick state forces a re-render once the load resolves so getLibassScale()
  // reads the freshly cached value.
  const [, setFontTick] = useState(0)
  // Ref (not state) so the timeupdate handler can read it synchronously.
  const isSeeking = useRef(false)
  // Track last active entry id so we only write to the store on change.
  const activeEntryIdRef = useRef<string | null>(null)

  const videoUrl = video ? pathToVideoUrl(video.path) : null

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

  // Load the subtitle font on mount and refresh whenever the active font
  // changes so the preview reflects the new metrics without requiring a
  // remount.
  //
  // Awaiting BOTH paths is important:
  //   - loadSubtitleFont() populates the opentype.js Font cache used for
  //     overflow / line-break measurement.
  //   - ensureFontLoaded() registers the FontFace with document.fonts so
  //     CSS `font-family: '<cssFontFamily>'` actually renders in the
  //     selected face.  Without an explicit await here, the tick bump
  //     fires before the FontFace is in the document and SubtitleOverlay
  //     re-renders into a fallback font (the v1.1.1 regression).
  useEffect(() => {
    Promise.all([
      loadSubtitleFont(),
      ensureFontLoaded(activeFontId)
    ]).then(() => setFontTick((n) => n + 1))
      .catch((err) => console.error('[video-preview] font load failed', err))
  }, [activeFontId])

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
    // The slider's value lives on the EDITED axis (its max is
    // editedDuration); translate back to ORIGINAL before writing to
    // <video>.currentTime and to the playhead store slice (both are
    // Original axis).  editedToOrig is identity when cuts is empty so
    // legacy users get the same behaviour.
    const editedVal = parseFloat(e.target.value)
    const origVal = editedToOrig(editedVal, cuts)
    setCurrentTime(origVal)
    setVideoCurrentTimeSec(origVal)
    if (videoRef.current) videoRef.current.currentTime = origVal
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!video || !videoUrl) return null

  const filename = getBasename(video.path)

  // Compact segmented-control helper for the settings row.  Local
  // rather than extracted because the styling is bound to this panel's
  // vertical budget.  Takes an i18n key prefix so the same component
  // serves both the position pickers (subtitlePosition.*) and the
  // background colour picker (background.*) without mis-translating
  // either — the previous version hardcoded "subtitlePosition" as the
  // prefix and made the background black/white buttons fall through to
  // their bare key names ("subtitlePosition.black" / ".white").
  function Segmented<T extends string>({
    options,
    value,
    onChange,
    labelKeyPrefix,
    ariaLabel
  }: {
    options: readonly T[]
    value: T
    onChange: (v: T) => void
    labelKeyPrefix: string
    ariaLabel: string
  }) {
    return (
      <div
        role="group"
        aria-label={ariaLabel}
        className="flex rounded-md overflow-hidden border border-border"
      >
        {options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              'px-2.5 py-1 text-caption transition-colors duration-150',
              value === opt
                ? 'bg-primary/15 text-primary font-medium'
                : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
            )}
          >
            {t(`${labelKeyPrefix}.${opt}`)}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="flex-shrink-0 rounded-lg border border-border bg-card">
      {/* Accordion header — clickable.  Filename + folder button live
          here (rather than in the right column's middle row) so:
            - they stay visible when the panel is collapsed, and
            - the right column has one fewer block, which helps balance
              its height against the left column's video element.
          stopPropagation on the folder button so clicking the icon does
          not also toggle the accordion. */}
      <div
        role="button"
        aria-expanded={isExpanded}
        tabIndex={0}
        onClick={() => setExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded(!isExpanded)
          }
        }}
        className="flex items-center gap-2 cursor-pointer select-none hover:opacity-90 transition-opacity duration-150 px-3 py-2"
      >
        <Play className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        <span className="text-label font-medium uppercase tracking-wider text-muted-foreground flex-shrink-0">
          {t('videoPreview.play')}
        </span>

        {/* Centred filename + folder shortcut.  flex-1 wrapper grabs the
            remaining horizontal space so the filename sits in the middle
            of the header regardless of how wide the panel is. */}
        <div className="flex-1 flex items-center justify-center gap-1.5 min-w-0 px-2">
          <span className="min-w-0 truncate text-body-sm text-foreground/80" title={video.path}>
            {filename}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              shellShowInFolder(video.path).catch(() => {})
            }}
            title={t('videoPreview.showInFolder')}
            className={cn(
              'flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-150',
              'hover:text-foreground focus:outline-none focus:text-foreground'
            )}
            aria-label={t('videoPreview.showInFolder')}
          >
            <FolderOpen className="h-4 w-4" />
          </button>
        </div>

        {isExpanded
          ? <ChevronUp className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          : <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        }
      </div>

      {/* Collapsible body — preview + controls. */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-2 space-y-1 border-t border-border/50 pt-2">
              {/* REQ-044 #2: pin the left grid track to the video's
                  actual rendered width so the videoContainer never
                  grows wider than the <video> inside.  Before this
                  fix the `auto` track let the disclaimer's max-content
                  push the container to ~350px while a vertical
                  1080×1920 source only renders 101px wide, with the
                  side-effect that SubtitleOverlay read the container
                  width (350) as the video width and over-scaled +
                  mispositioned the subtitle.  `minmax(180px, videoW)`
                  ensures the disclaimer below still has a readable
                  wrap width (≥180) even for narrow vertical sources,
                  while horizontal sources continue to size to the
                  full videoW (e.g. 320 for 16:9 @ 180h). */}
              {(() => {
                // REQ-045 #1: 2-axis envelope replaces the previous
                // height-only TARGET_H=180.  Vertical sources now use
                // the available height for a much larger preview while
                // horizontal stays inside the panel's right column's
                // own width budget.  Behaviour by ratio:
                //   - 16:9 → 360×202 (width-bound; +25 % bigger than
                //            the previous 320×180, still well within
                //            the panel)
                //   - 9:16 → 158×280 (height-bound; +143 % area vs the
                //            previous 101×180 — the main visual win)
                //   - 1:1  → 280×280
                // The grid track minimum (180px) is unchanged so the
                // disclaimer below still has a readable wrap width even
                // for the narrowest vertical sources.  When the
                // container width is below the 180px floor (e.g. 158
                // for 9:16) the videoContainer is horizontally centred
                // inside the track via mx-auto (REQ-045 #2) — without
                // this the video would sit flush-left and look
                // mis-aligned against the disclaimer text below it.
                const MAX_W = 360
                const MAX_H = 280
                const ratio =
                  video.widthPx > 0 && video.heightPx > 0
                    ? video.widthPx / video.heightPx
                    : 16 / 9
                const widthBound = MAX_H * ratio > MAX_W
                const videoW = Math.round(widthBound ? MAX_W : MAX_H * ratio)
                const videoH = Math.round(widthBound ? MAX_W / ratio : MAX_H)
                return (
                  <div
                    className="grid gap-4"
                    style={{
                      gridTemplateColumns: `minmax(180px, ${videoW}px) 1fr`
                    }}
                  >

                    {/* ── Left: video + subtitle overlay ─────
                        REQ-075 #2: the "approximate preview" disclaimer
                        used to sit directly under the video here; it has
                        moved to the top of the right column so the space
                        under the video frame stays free (helps Step 2's
                        overall vertical budget). */}
                    <div className="flex flex-col">
                      <div
                        ref={videoContainerRef}
                        className="relative mx-auto flex items-center justify-center overflow-hidden rounded bg-input"
                        style={{ width: `${videoW}px`, height: `${videoH}px` }}
                      >
                        {hasError ? (
                          <span className="px-6 text-body-sm text-muted-foreground">{t('videoPreview.error')}</span>
                        ) : (
                          <>
                            <video
                              ref={videoRef}
                              src={videoUrl}
                              preload="metadata"
                              className="h-full w-auto object-contain"
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
                    </div>

                {/* ── Right: 2-row layout (settings / player) ──────────
                    The middle "filename + folder" row moved up into the
                    accordion header so the right column is shorter and
                    closer to the left column's height. */}
                <div className="flex flex-col py-1 min-w-0">

                  {/* REQ-075 #2: previewNote moved here (was directly
                      under the video frame on the left).  Putting it
                      above the subtitle-layout group keeps the warning
                      visible without consuming any vertical space below
                      the video, which is what the left column was
                      bleeding before. */}
                  <p className="mb-2 text-body-sm text-muted-foreground">
                    {t('subtitleLayout.previewNote')}
                  </p>

                  {/* Top: two boxed groups (Subtitle layout / Subtitle
                      background).  Each group is a rounded outline with
                      its title on top and its items on a single
                      horizontal row beneath (flex-wrap so narrow widths
                      degrade gracefully).  This trades vertical density
                      for horizontal density — the right column has
                      plenty of horizontal space, so packing the items
                      side-by-side keeps the panel's overall height
                      compact and matches the visual rhythm of the rest
                      of the app.
                      All controls write to the same useSettingsStore
                      slices SubtitleOverlay reads, so changes here
                      render immediately on the video on the left. */}
                  <div className="space-y-2">
                    {/* ── Group 1: Subtitle layout ─────────────────── */}
                    <div className="rounded-md border border-border px-3 py-2">
                      <p className="text-label font-medium uppercase tracking-wider text-foreground/70 mb-1.5">
                        {t('subtitleLayout.layoutGroup')}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body-sm text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <span>{t('subtitleLayout.horizontalShort')}</span>
                          <Segmented
                            options={['left', 'center', 'right'] as const}
                            value={burnin.horizontalPosition}
                            onChange={(v) => updateBurnin({ horizontalPosition: v })}
                            labelKeyPrefix="subtitlePosition"
                            ariaLabel={t('subtitlePosition.horizontal')}
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span>{t('subtitleLayout.verticalShort')}</span>
                          <Segmented
                            options={['top', 'bottom'] as const}
                            value={burnin.verticalPosition}
                            onChange={(v) => updateBurnin({ verticalPosition: v })}
                            labelKeyPrefix="subtitlePosition"
                            ariaLabel={t('subtitlePosition.vertical')}
                          />
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span>{t('subtitlePosition.marginShort')}</span>
                          <input
                            type="number"
                            min={0}
                            max={300}
                            value={burnin.verticalMarginPx}
                            onChange={(e) => updateBurnin({ verticalMarginPx: parseInt(e.target.value, 10) || 0 })}
                            className="h-7 w-14 rounded border border-border bg-input px-1.5 text-center text-body-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring/30 tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                          />
                        </div>
                      </div>
                    </div>

                    {/* ── Group 2: Subtitle background ─────────────── */}
                    <div className="rounded-md border border-border px-3 py-2">
                      <p className="text-label font-medium uppercase tracking-wider text-foreground/70 mb-1.5">
                        {t('subtitleLayout.backgroundGroup')}
                      </p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-body-sm text-muted-foreground">
                        {/* Toggle — label-less because the group title
                            ("文字背景") already names the switch. */}
                        <Switch
                          checked={subtitleBackground.enabled}
                          onCheckedChange={(checked) => setSubtitleBackground({ ...subtitleBackground, enabled: checked })}
                          aria-label={t('subtitleLayout.backgroundGroup')}
                        />

                        {/* Colour — disabled when background is off. */}
                        <div className={cn(
                          'flex items-center gap-1.5',
                          !subtitleBackground.enabled && 'opacity-40 pointer-events-none'
                        )}>
                          <span>{t('subtitleLayout.bgColorLabel')}</span>
                          <Segmented
                            options={['black', 'white'] as const}
                            value={subtitleBackground.color}
                            onChange={(v) => setSubtitleBackground({ ...subtitleBackground, color: v })}
                            labelKeyPrefix="background"
                            ariaLabel={t('subtitleLayout.bgColorLabel')}
                          />
                        </div>

                        {/* Opacity — same disabled treatment. */}
                        <div className={cn(
                          'flex items-center gap-1.5',
                          !subtitleBackground.enabled && 'opacity-40 pointer-events-none'
                        )}>
                          <span>{t('subtitleLayout.bgOpacityLabel')}</span>
                          <input
                            type="range"
                            min={0}
                            max={100}
                            step={10}
                            value={subtitleBackground.opacityPercent}
                            onChange={(e) => setSubtitleBackground({
                              ...subtitleBackground,
                              opacityPercent: parseInt(e.target.value, 10)
                            })}
                            style={{ accentColor: 'hsl(var(--primary))' }}
                            aria-label={t('subtitleLayout.bgOpacityLabel')}
                            className="w-24 h-1.5 cursor-pointer"
                          />
                          <span className="font-mono tabular-nums w-9 text-right">
                            {subtitleBackground.opacityPercent}%
                          </span>
                        </div>
                      </div>

                      {/* Outline-disabled advisory note — only when bg
                          is on.  Stays inside the background group's box
                          so the cause/effect link is visually obvious. */}
                      {subtitleBackground.enabled && (
                        <p className="mt-1.5 text-body-sm text-[hsl(var(--warning))]">
                          {t('background.outlineNote')}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* flex-1 spacer absorbs whatever vertical slack the
                      left column's video + disclaimer leaves over so
                      the player anchors to the bottom and the two
                      columns visually balance. */}
                  <div className="flex-1" />

                  {/* Bottom: smaller play/pause + scrub + time.
                      REQ-075 #5 — seekbar + readout on the EDITED axis.
                      `editedTotalSec` and `editedCurrentTime` collapse to
                      `duration` and `currentTime` exactly when cuts is
                      empty (origToEdited / editedDuration are identity),
                      so legacy users notice no change. */}
                  {(() => {
                    const editedTotalSec = editedDuration(duration, cuts)
                    const editedCurrentTime = origToEdited(currentTime, cuts)
                    return (
                      <div className="flex items-center gap-2 px-1">
                        <button
                          type="button"
                          onClick={togglePlay}
                          disabled={hasError || duration === 0}
                          className={cn(
                            'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full',
                            'bg-secondary text-foreground transition-all duration-150',
                            'hover:bg-accent active:scale-95',
                            'focus:outline-none focus:ring-2 focus:ring-ring/30',
                            'disabled:cursor-not-allowed disabled:opacity-40'
                          )}
                          aria-label={isPlaying ? t('videoPreview.pause') : t('videoPreview.play')}
                        >
                          {isPlaying
                            ? <Pause className="h-5 w-5" />
                            : <Play  className="h-5 w-5 translate-x-0.5" />
                          }
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={editedTotalSec > 0 ? editedTotalSec : 100}
                          step={0.1}
                          value={editedCurrentTime}
                          disabled={duration === 0 || hasError}
                          onMouseDown={handleSeekDown}
                          onChange={handleSeekChange}
                          onMouseUp={handleSeekUp}
                          onTouchStart={handleSeekDown}
                          onTouchEnd={handleSeekUp}
                          style={{
                            accentColor: 'hsl(var(--primary))'
                          }}
                          className="flex-1 h-1.5 cursor-pointer disabled:cursor-default disabled:opacity-40"
                        />
                        <span className="flex-shrink-0 select-none font-mono tabular-nums text-body-sm text-muted-foreground">
                          {formatTime(editedCurrentTime)}&nbsp;/&nbsp;{formatTime(editedTotalSec)}
                        </span>
                      </div>
                    )
                  })()}

                </div>

                  </div>
                )
              })()}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
