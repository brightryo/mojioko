import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { Play, Pause, FolderOpen, ChevronUp, ChevronDown } from 'lucide-react'
import { motion } from 'framer-motion'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore } from '@/stores/ui-store'
import { useHistoryStore } from '@/stores/history-store'
import { useCutSkip } from '@/hooks/use-cut-skip'
import { cn } from '@/lib/utils'
import { shellShowInFolder } from '@/services/dialog'
import { bumpRenderCount, measureSync } from '@/lib/perf-counter'
import { scrubState } from '@/lib/scrub-state'
import { SubtitleOverlay, estimateOverlayHeightPx } from '@/components/subtitle-overlay/subtitle-overlay'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { ensureFontLoaded } from '@/lib/font-registry'
import { findActiveEntryId, findActiveEntryIds, computeFixedStackOffsets } from '@/lib/active-entry'
import {
  previewPxToAss,
  getAnchorAssPosition,
  clampAssPosition,
} from '@/lib/preview-coords'
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

// findActiveEntryId moved to @/lib/active-entry for shared use + unit tests.
// REQ-080 #1: range semantics changed to [start, end) — end exclusive.

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
  bumpRenderCount('VideoPreviewPanel')
  const { t } = useTranslation(['step2'])
  const video = useProjectStore((s) => s.video)
  const entries = useProjectStore((s) => s.entries)
  // REQ-075 #5: the seekbar lives on the EDITED axis (= origToEdited of
  // <video>.currentTime); when cuts is empty the transforms are identity,
  // so existing non-trim users see byte-identical behaviour.
  const cuts = useProjectStore((s) => s.cuts)

  // REQ-20260613-016 Phase 4: the global "字幕レイアウト" + "文字背景"
  // panels that previously lived in this component were retired — each
  // SubtitleEntry now carries its own per-row layout / background, edited
  // from the Style column in SubtitleTable (機能A).  Only `activeFontId`
  // is still consumed here to feed estimateOverlayHeightPx via the stack
  // memo below; the global burnin / subtitleBackground store slices were
  // dropped from settings-store in the same phase.
  const activeFontId       = useSettingsStore((s) => s.activeFontId)

  const videoSeekRequestSec    = useUiStore((s) => s.videoSeekRequestSec)
  const setVideoSeekRequest    = useUiStore((s) => s.setVideoSeekRequest)
  // REQ-080 #1: overlayEntry no longer falls back to focusedRowId on
  // paused, so we only need the SETTER (handleTimeUpdate writes during
  // playback so the subtitle table highlights the active row).
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

  // REQ-20260613-016 Phase 6 — preview drag (機能B).  Captures pointer on
  // overlay pointerdown and tracks moves until pointerup.  The drag
  // updates entry.posX / entry.posY directly (per-frame writes); a single
  // history op is pushed on pointerup with the pre-drag snapshot.
  //
  // Stored as a ref so pointermove / pointerup handlers see synchronous
  // state without a re-render cascade.
  const dragRef = useRef<{
    entryId: string
    snapshot: SubtitleEntry
    startClientX: number
    startClientY: number
    startAssX: number
    startAssY: number
    scale: number
    moved: boolean
  } | null>(null)

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
   * REQ-080 #1 + REQ-20260613-004: source of truth for the overlay — EVERY
   * entry whose `[startSec, endSec)` covers the current playhead, in the
   * stable startSec-ascending order that matches the ASS Dialogue order
   * on burn-in.  Works identically for playback and paused states:
   *
   *   - During playback, `currentTime` tracks `<video>.currentTime`; every
   *     active subtitle renders, stacked vertically.
   *   - When the user clicks a row in the subtitle table, the seek path
   *     sets `currentTime` to the row's startSec, so the same lookup
   *     naturally surfaces that row (and any siblings sharing its span).
   *   - When playback stops at duration (no more 0-warp since REQ-079),
   *     `currentTime === lastEntry.endSec` and the end-exclusive lookup
   *     returns an empty array — no stale subtitles baked on top of the
   *     final frame.
   *
   * Stack ordering (REQ-20260613-004 §2-2): the array order returned by
   * `findActiveEntryIds` matches `sortedActiveEntries` order, which in
   * turn matches the ASS Dialogue order emitted by
   * `ass-generator.ts:113-114` (= `entries.filter(!isDeleted)`).  On
   * burn-in, libass's collision avoidance places the FIRST Dialogue at
   * the configured edge (bottom for alignment 1–3, top for 7–9) and
   * pushes subsequent Dialogues away from that edge.  The preview
   * reproduces that exact ordering: the first entry in `overlayEntries`
   * sits flush against the burnin edge (stackOffsetPx = 0) and each
   * subsequent entry's offset is the cumulative height of preceding
   * entries — so preview top/bottom always agrees with the burn-in.
   *
   * The old isPlaying-gated path that unconditionally fell back to
   * `focusedRowId` produced the REQ-080-reported bug because
   * `focusedRowId` is retained across gap-time (so it stays pointed at
   * the last-played subtitle after EOF).
   */
  const overlayEntries = useMemo<SubtitleEntry[]>(() => {
    const ids = findActiveEntryIds(sortedActiveEntries, currentTime)
    if (ids.length === 0) return []
    if (ids.length === 1) {
      // Fast path for the overwhelmingly-common single-active case.
      const only = sortedActiveEntries.find((e) => e.id === ids[0])
      return only ? [only] : []
    }
    // Preserve the order findActiveEntryIds returned (= sortedActiveEntries
    // order = libass Dialogue order).  Filtering instead of map+find keeps
    // that order without a per-id O(N) lookup.
    const idSet = new Set(ids)
    return sortedActiveEntries.filter((e) => idSet.has(e.id))
  }, [currentTime, sortedActiveEntries])

  /**
   * REQ-20260613-006: precomputed stack offset per entry id.  Replaces the
   * REQ-004 per-render cumulative loop, which re-packed the visible stack
   * every time an entry left and visibly shifted survivors downward.  By
   * computing offsets ONCE per entries / scale change and freezing each
   * entry's offset for its lifetime, the preview now mirrors libass's
   * `fix_collisions` behaviour: positions assigned at startSec, never
   * recomputed unless a new entry arrives.
   *
   * Critically, `currentTime` is NOT a dependency — the playhead tick
   * during playback does not invalidate this memo, so the per-frame cost
   * stays at one Map lookup per active overlay (= effectively free).  The
   * O(N²) algorithm inside `computeFixedStackOffsets` only runs when the
   * entries list or the rendering scale changes — both rare during
   * playback, and the user already accepts the cost in `overflowMap`,
   * `warningsMap`, etc.  See VERIFY-20260613-001 + RES-20260613-005 §Q4
   * for the analysis.
   */
  const videoWidthPx = video?.widthPx ?? 0
  const stackOffsetsByEntryId = useMemo(() => {
    if (videoWidthPx <= 0 || videoContainerWidth <= 0) {
      return new Map<string, number>()
    }
    return computeFixedStackOffsets(
      sortedActiveEntries,
      (entry) => estimateOverlayHeightPx(
        entry,
        activeFontId,
        videoWidthPx,
        videoContainerWidth,
      ),
    )
  }, [sortedActiveEntries, activeFontId, videoWidthPx, videoContainerWidth])

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
    if (el.paused) {
      // REQ-079 #1: with handleEnded no longer warping to 0, the
      // playhead may be sitting at the very end when the user presses
      // ▶ again.  Standard player UX rewinds to the start in that
      // case so playback always starts somewhere watchable.  The eps
      // (~50 ms) matches MIN_BLOCK_SEC and handles float drift around
      // the EOF boundary; well below the threshold of perception.
      const PLAYBACK_RESET_EPS_SEC = 0.05
      if (el.duration > 0 && el.currentTime >= el.duration - PLAYBACK_RESET_EPS_SEC) {
        el.currentTime = 0
      }
      el.play().catch(() => {})
    } else {
      el.pause()
    }
  }, [])

  // REQ-20260612-001: pause the video when the accordion collapses.
  // Pairing with the always-mounted body above: the <video> element now
  // survives collapse cycles (so currentTime / overlayEntry are
  // preserved), but the user collapsing the panel should still feel
  // like "stop the preview" — not "minimise to a tray that keeps
  // playing audio".  Position is preserved; play state is not.
  useEffect(() => {
    if (isExpanded) return
    const el = videoRef.current
    if (el && !el.paused) el.pause()
  }, [isExpanded])

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
    // REQ-095: time the seek effect — this is where the (real-video)
    // `el.currentTime = X` blocking seek lands, plus the three setStates
    // that drive Playhead / VPP / autoScroll subscribers.  Split into
    // (a) the `el.currentTime` assignment alone (= the HTML5 video
    // engine's keyframe-snap + decode cost) and (b) the rest of the
    // effect body, so the e2e can tell whether the bottleneck is the
    // video element or our store fan-out.
    measureSync('VPP.seekEffect.total', () => {
      const el = videoRef.current
      if (el) {
        measureSync('VPP.seekEffect.videoSeek', () => {
          el.currentTime = videoSeekRequestSec
        })
        setCurrentTime(videoSeekRequestSec)
        // REQ-096: while a manual ruler scrub is in progress, the
        // optimistic-playhead path in TimelineView's handleSeek has
        // already written `videoCurrentTimeSec` to the LATEST cursor
        // position.  The rAF-throttled seek that triggered this
        // effect carries the value the cursor had a frame ago, so
        // writing it here would briefly snap the Playhead BACKWARD
        // until the next pointermove.  Skip during scrub; on
        // pointerup the scrub handler clears the flag and the next
        // `timeupdate` (from the actual video element) re-syncs.
        if (!scrubState.inProgress) {
          setVideoCurrentTimeSec(videoSeekRequestSec)
        }
      }
      // Clear the request immediately after consuming it.
      setVideoSeekRequest(null)
    })
  }, [videoSeekRequestSec, setVideoSeekRequest, setVideoCurrentTimeSec])

  // -------------------------------------------------------------------------
  // Video event handlers
  // -------------------------------------------------------------------------

  function handleTimeUpdate() {
    const el = videoRef.current
    if (!el || isSeeking.current) return
    const time = el.currentTime
    setCurrentTime(time)
    // REQ-096: same rationale as the seek useEffect — during a
    // manual ruler scrub, the optimistic write owns
    // `videoCurrentTimeSec` and writing it from the video element's
    // `timeupdate` event (which fires after every successful
    // `el.currentTime = X` commit, carrying the rAF-throttled
    // value) would race the latest pointermove and pull the
    // Playhead backward.  pointerup clears scrubState.inProgress
    // and the next `timeupdate` re-syncs.
    if (!scrubState.inProgress) {
      setVideoCurrentTimeSec(time)
    }

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
  /**
   * REQ-079 #1: `ended` only flips the play state to false.  No more
   * "warp to 0" on EOF.  Whether the user pressed ⏭, scrubbed past the
   * right edge, or simply played through to the end, the playhead now
   * stays at the final frame.  Pressing ▶ from that resting state
   * restarts from the head — see togglePlay's at-end branch.  This
   * supersedes the REQ-078 manualSeekHoldRef 300 ms gating: with no
   * warp ever, there is nothing for that flag to guard.
   */
  function handleEnded() {
    setIsPlaying(false)
  }
  function handleError() { setHasError(true) }

  // -------------------------------------------------------------------------
  // Seekbar
  // -------------------------------------------------------------------------

  function handleSeekDown()  { isSeeking.current = true }
  function handleSeekUp()    { isSeeking.current = false }

  // REQ-20260613-016 Phase 6 — preview drag handlers (機能B).
  //
  // Drag lifecycle:
  //  1. `handleOverlayPointerDown` runs when the user presses on a caption.
  //     We snapshot the entry (for history undo), compute the *start* ASS
  //     coordinate (either the pinned coord if already pinned, or the
  //     alignment-based anchor for unpinned entries), and arm `dragRef`.
  //  2. `handleWindowPointerMove` (attached to window for the lifetime of
  //     the drag) converts the pointer delta to ASS coords via
  //     `previewPxToAss(delta, scale)` and writes posX/posY directly to
  //     the store on every move.  Visual feedback is immediate.
  //  3. `handleWindowPointerUp` pushes a single history op (snapshot →
  //     final patch) and releases pointer capture.  Per REQ補遺: ONE
  //     commit per drag, NOT one per pointermove.
  //
  // Click-without-drag: when `moved === false` at pointerup, we skip the
  // history push entirely — the user just clicked the overlay, and a
  // history-op for a no-op drag would be confusing.
  const handleOverlayPointerDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>, draggedEntry: SubtitleEntry) => {
      const container = videoContainerRef.current
      if (!container || !video) return
      const scale = container.clientWidth / video.widthPx
      if (scale <= 0) return

      // Decide the start ASS coord:
      //   - already pinned → use the entry's own (posX, posY)
      //   - not pinned     → compute the alignment-based anchor so the
      //                       drag starts from the same point the
      //                       caption was visually anchored at.  This
      //                       avoids a "jump" at the first pixel.
      const startAss =
        draggedEntry.posX !== undefined && draggedEntry.posY !== undefined
          ? { x: draggedEntry.posX, y: draggedEntry.posY }
          : getAnchorAssPosition(
              draggedEntry.horizontalPosition,
              draggedEntry.verticalPosition,
              draggedEntry.verticalMarginPx,
              video.widthPx,
              video.heightPx,
            )

      dragRef.current = {
        entryId: draggedEntry.id,
        snapshot: { ...draggedEntry },
        startClientX: e.clientX,
        startClientY: e.clientY,
        startAssX: startAss.x,
        startAssY: startAss.y,
        scale,
        moved: false,
      }

      // Prevent the overlay's pointerdown from also triggering text
      // selection / focus changes on the underlying <video> element.
      e.preventDefault()
      e.stopPropagation()

      // Listen on window so the drag continues even when the cursor
      // leaves the overlay's tiny bounding box.
      window.addEventListener('pointermove', handleWindowPointerMove)
      window.addEventListener('pointerup', handleWindowPointerUp, { once: true })
    },
    // handleWindowPointerMove / handleWindowPointerUp are stable across
    // renders (declared below via useCallback) so the linter wants them
    // here, but they reference dragRef which is a ref — no missing dep.
    [video], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const handleWindowPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current
    if (!d || !video) return
    const dxPx = e.clientX - d.startClientX
    const dyPx = e.clientY - d.startClientY
    // Threshold "any movement" as moved=true so we know whether to push
    // a history op at pointerup.
    if (dxPx !== 0 || dyPx !== 0) d.moved = true
    const newAss = clampAssPosition(
      d.startAssX + previewPxToAss(dxPx, d.scale),
      d.startAssY + previewPxToAss(dyPx, d.scale),
      video.widthPx,
      video.heightPx,
    )
    // Round to integer ASS pixels — the burnin output is integer-px
    // anyway, and float drift would dirty the entry's isEdited state
    // even when the user returns the caption to its exact original pos.
    useProjectStore.getState().updateEntry(d.entryId, {
      posX: Math.round(newAss.x),
      posY: Math.round(newAss.y),
    })
  }, [video])

  const handleWindowPointerUp = useCallback(() => {
    window.removeEventListener('pointermove', handleWindowPointerMove)
    const d = dragRef.current
    dragRef.current = null
    if (!d) return
    if (!d.moved) return // click-without-drag: nothing to commit

    // Snapshot vs final-entry diff → one history op for the entire drag.
    const final = useProjectStore.getState().entries.find((x) => x.id === d.entryId)
    if (!final) return
    const finalSnap = { ...final }
    const pre = d.snapshot
    useHistoryStore.getState().push({
      label: t('history.dragPosition'),
      undo: () => useProjectStore.getState().updateEntry(pre.id, pre),
      redo: () => useProjectStore.getState().updateEntry(pre.id, finalSnap),
    })
  }, [handleWindowPointerMove, t])

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
    if (videoRef.current) {
      videoRef.current.currentTime = origVal
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!video || !videoUrl) return null

  const filename = getBasename(video.path)

  // REQ-20260613-016 Phase 4 — the local `Segmented` helper used by the
  // retired global panels was removed alongside them.  Phase 6 may
  // reintroduce a similar primitive if the drag UI needs a pinned-state
  // segmented toggle, but until then the component is unreferenced.

  return (
    <div className="flex-shrink-0 rounded-lg border border-border bg-card">
      {/* Accordion header — clickable.  Filename + folder button live
          here (rather than in the right column's middle row) so:
            - they stay visible when the panel is collapsed, and
            - the right column has one fewer block, which helps balance
              its height against the left column's video element.
          stopPropagation on the folder button so clicking the icon does
          not also toggle the accordion. */}
      {/* REQ-082: Enter / Space keyboard activation removed. */}
      <div
        role="button"
        aria-expanded={isExpanded}
        tabIndex={0}
        onClick={() => setExpanded(!isExpanded)}
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

      {/* Collapsible body — preview + controls.
          REQ-20260612-001: kept ALWAYS MOUNTED and animated open/closed
          via height + opacity rather than wrapped in <AnimatePresence>
          with a conditional render.  When the body unmounts on close,
          the inner <video> element is destroyed; re-expanding remounts
          it fresh, the browser reloads metadata, fires `timeupdate` at
          currentTime=0, and that 0 propagates back into React state —
          wiping the active subtitle entry from <SubtitleOverlay>.  By
          keeping the subtree mounted, currentTime / videoContainerWidth
          / overlayEntry all survive across collapse cycles and the
          overlay paints continuously at the right playhead position. */}
      <motion.div
        initial={false}
        animate={isExpanded
          ? { height: 'auto', opacity: 1 }
          : { height: 0, opacity: 0 }
        }
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
                            {/* REQ-20260613-004 + REQ-20260613-006:
                                render every active caption as its own
                                SubtitleOverlay.  The vertical offset
                                comes from the pre-computed
                                `stackOffsetsByEntryId` map (= libass-
                                faithful `fix_collisions` positions),
                                so survivors stay put when a sibling
                                caption ends and a later caption fills
                                the freed gap rather than pushing the
                                survivor down.  Single-active resolves
                                to one overlay at offset 0 — byte-
                                identical to the pre-stack render
                                path. */}
                            {/* REQ-20260613-016 Phase 3: per-row layout
                                lives on `entry` itself; SubtitleOverlay
                                reads horizontalPosition / verticalPosition /
                                verticalMarginPx / subtitleBackground from
                                there.  The global `burnin` /
                                `subtitleBackground` slices are no longer
                                consumed by overlay rendering (Phase 4 will
                                also retire the panel UI that wrote them). */}
                            {videoContainerWidth > 0 && overlayEntries.map((entry) => {
                              const offset = stackOffsetsByEntryId.get(entry.id) ?? 0
                              return (
                                <SubtitleOverlay
                                  key={entry.id}
                                  entry={entry}
                                  videoWidthPx={video.widthPx}
                                  containerWidthPx={videoContainerWidth}
                                  stackOffsetPx={offset}
                                  onPointerDown={handleOverlayPointerDown}
                                />
                              )
                            })}
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

                  {/* REQ-20260613-016 Phase 4 — the legacy
                      "字幕レイアウト" + "文字背景" panels were retired here.
                      Per-row editing UI lives in SubtitleTable's Style
                      column (機能A); this space is intentionally left
                      empty so the player anchors via the flex-1 spacer
                      below.  Phase 5/6 may reuse this slot for the
                      inspector-merged UI; the preview note above is kept
                      because it still applies to the per-row preview. */}

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
                            'focus:outline-none focus-visible:outline-none',
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
    </div>
  )
}
