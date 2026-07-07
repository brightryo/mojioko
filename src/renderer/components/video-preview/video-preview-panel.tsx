import { useRef, useState, useEffect, useLayoutEffect, useCallback, useMemo } from 'react'
import { Play, Pause, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useUiStore, isAnyOverlayOpen } from '@/stores/ui-store'
import { useHistoryStore } from '@/stores/history-store'
import { usePreviewMixStore } from '@/stores/preview-mix-store'
import { useCutSkip } from '@/hooks/use-cut-skip'
import { cn } from '@/lib/utils'
import { shortcutHint } from '@/lib/shortcut-hint'
import { shellShowInFolder } from '@/services/dialog'
import { bumpRenderCount, measureSync } from '@/lib/perf-counter'
import { scrubState } from '@/lib/scrub-state'
import { SubtitleOverlay, estimateOverlayHeightPx } from '@/components/subtitle-overlay/subtitle-overlay'
import { PositionGuideOverlay } from '@/components/subtitle-overlay/position-guide-overlay'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { ensureFontLoaded } from '@/lib/font-registry'
import { findActiveEntryId, findActiveEntryIds, computeFixedStackOffsets } from '@/lib/active-entry'
import {
  previewPxToAss,
  getAnchorAssPosition,
  clampAssPosition,
} from '@/lib/preview-coords'
import { editedDuration, editedToOrig, origToEdited } from '../../../shared/cuts'
import { computeFadeOpacity } from '@/lib/fade-opacity'
import type { SubtitleEntry } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * REQ-20260615-052 — `<input type=...>` values where Space inserts a
 * literal space character into the field.  The global play/pause
 * shortcut bails on these (and on `<textarea>` / contenteditable) so
 * the user can type a space; every other input type (range, number,
 * checkbox, radio, file, button, etc.) is left to the document
 * shortcut, where Space's default action would otherwise be either
 * "scroll the focused scroll container" or "activate the focused
 * control" — neither of which is what the user wants here.
 *
 * `<input>` with empty / missing `type` defaults to `"text"`, so this
 * set matches both the spec text-input types and the implicit default.
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
  // REQ-20260615-050 — fade duration is now per-entry; no global slice
  // is read here.  The rAF loop below pulls `entry.fadeDurationSec`
  // from each active SubtitleEntry.

  const videoSeekRequestSec    = useUiStore((s) => s.videoSeekRequestSec)
  const setVideoSeekRequest    = useUiStore((s) => s.setVideoSeekRequest)
  // REQ-080 #1: overlayEntry no longer falls back to focusedRowId on
  // paused, so we only need the SETTER (handleTimeUpdate writes during
  // playback so the subtitle table highlights the active row).
  const setFocusedRowId        = useUiStore((s) => s.setFocusedRowId)
  const setVideoCurrentTimeSec = useUiStore((s) => s.setVideoCurrentTimeSec)
  // REQ-20260615-038 C — the position guide overlay surfaces on the
  // inspector-selected row and on the row currently being dragged.  Pull
  // the selection from ui-store; dragging is tracked locally below.
  const selectedEntryId = useUiStore((s) => s.selectedEntryId)
  // REQ-20260614-001 Phase 2 — the accordion-style "expanded / collapsed"
  // state retired here; the user resizes the left-top pane to reclaim
  // vertical space instead.  `videoPreviewExpanded` slice and its setter
  // stay in ui-store for now (no other consumer; harmless), to be cleaned
  // up in a follow-up phase along with the seek / current-time slices.

  const videoRef  = useRef<HTMLVideoElement>(null)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  // REQ-086 — hidden <audio> that plays the pre-generated multi-track
  // amix when the source has >= 2 audio tracks.  `previewMixUrl` is null
  // for single-track / no-audio sources and during the brief window
  // between video load and a fresh transcription completing — in both
  // cases <video> alone drives playback (legacy behaviour, no regression).
  const audioRef = useRef<HTMLAudioElement>(null)
  const previewMixUrl = usePreviewMixStore((s) => s.url)
  // REQ-074 1b: while playing, jump past any frame that falls inside a
  // user-confirmed cut (ripple-preview behaviour).  No-op when cuts is empty.
  useCutSkip(videoRef)
  // REQ-086 — same cut-skip applied to the hidden audio element so the
  // mixed soundtrack jumps the same cuts as the video.  Both elements
  // see the same `timeupdate` cadence and the same cuts list, so they
  // hop together (within a few ms); the rAF drift-correction loop below
  // tightens any residual gap on the next tick.  No-op when audioRef
  // is null (= no preview mix) or cuts is empty.
  useCutSkip(audioRef)
  const [isPlaying,  setIsPlaying]  = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration,    setDuration]    = useState(0)
  const [hasError,    setHasError]    = useState(false)
  // REQ-20260614-001 補遺② 修正2 — measure the BODY (the flex-1 region
  // hosting the video frame) so we can compute fit-within-parent width
  // and height via JS.  Phase 2's CSS `aspect-ratio` approach collapsed
  // to 0×0 inside a flex column because the container had no intrinsic
  // content (the <video> is absolute-positioned) and no explicit
  // width/height — aspect-ratio alone does not size a box when both
  // dimensions resolve to `auto`.  Reverting to JS-computed pixel sizes
  // matches the v1.2.1 behaviour with the new ability to react to pane
  // resize.
  const previewBodyRef = useRef<HTMLDivElement>(null)
  const [previewBodySize, setPreviewBodySize] = useState({ w: 0, h: 0 })
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

  // REQ-20260615-038 B/C — span DOM refs per overlay entry id, populated
  // via callback ref so the PositionGuideOverlay siblings can measure the
  // rendered subtitle for the inspector-selected / dragging row.  Tracked
  // in a ref (not state) so registering / unregistering during render does
  // not loop; the guide component is re-rendered whenever the parent
  // re-renders (which happens on every drag move via the store update).
  const overlaySpanRefs = useRef<Map<string, HTMLSpanElement>>(new Map())
  const setOverlaySpanRef = useCallback(
    (entryId: string) => (el: HTMLSpanElement | null) => {
      if (el) {
        overlaySpanRefs.current.set(entryId, el)
      } else {
        overlaySpanRefs.current.delete(entryId)
      }
    },
    [],
  )
  // Tracks the entry currently being dragged so the affordance + guide
  // stay visible while the pointer is held down even if the hover state
  // changes (e.g. cursor leaves the bbox at fast drag speeds).
  const [draggingEntryId, setDraggingEntryId] = useState<string | null>(null)

  // REQ-20260615-049 — outer span DOM refs per entry id, written by a
  // single requestAnimationFrame loop with the per-entry fade opacity.
  // Distinct from `overlaySpanRefs` (= inner text wrapper, used by the
  // position guide) because the two consumers want different elements:
  // opacity has to wrap the bg panel + the affordance icon too, so it
  // belongs on the outer positioned span.
  const overlayOuterRefs = useRef<Map<string, HTMLSpanElement>>(new Map())
  // Mirror of `overlayEntries` kept in a ref so the rAF loop can read
  // entry data (`startSec`, `endSec`, `fadeEnabled`) without taking
  // `overlayEntries` as an effect dep — taking it as a dep would tear
  // down and re-spawn the rAF every time the active set changed, which
  // happens at every entry boundary.
  const activeEntryMapRef = useRef<Map<string, SubtitleEntry>>(new Map())
  // REQ-20260615-050 — fade duration now lives per-entry, so no global
  // ref is needed.  The rAF reads `entry.fadeDurationSec` straight from
  // the `activeEntryMapRef` snapshot.
  // Callback ref factory: stores the element in the map AND applies an
  // immediate opacity write so the first paint after mount is already
  // at the correct ramp value (callback refs fire during the commit
  // phase, before the browser paints).  Without this we would see a
  // single frame at opacity 1 before the next rAF tick wrote 0 — a
  // visible flash at the start of every fade-in.  Closes over `entry`
  // so the lookup needs no Map; new closure per render is cheap at
  // typical overlay counts (< 10 simultaneous captions).
  const setOverlayOuterRef = useCallback(
    (entry: SubtitleEntry) => (el: HTMLSpanElement | null) => {
      if (el) {
        overlayOuterRefs.current.set(entry.id, el)
        const t = videoRef.current?.currentTime ?? 0
        el.style.opacity = String(
          computeFadeOpacity({
            currentTimeSec: t,
            startSec: entry.startSec,
            endSec: entry.endSec,
            fadeDurationSec: entry.fadeDurationSec,
          }),
        )
      } else {
        overlayOuterRefs.current.delete(entry.id)
      }
    },
    [],
  )

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

  // REQ-20260615-049 — sync the active-entry table read by the rAF fade
  // loop.  Kept in a ref so the loop never lists `overlayEntries` as a
  // dep (which would tear down / re-spawn the loop every entry boundary).
  useEffect(() => {
    const m = new Map<string, SubtitleEntry>()
    for (const e of overlayEntries) m.set(e.id, e)
    activeEntryMapRef.current = m
  }, [overlayEntries])

  // REQ-20260615-049 — single requestAnimationFrame loop that drives the
  // fade opacity for every rendered overlay.  Vsync-aligned (~60 Hz),
  // independent of the HTMLVideoElement `timeupdate` event (which is
  // 4–66 Hz, irregular) and of React re-renders (which can stall during
  // the resize-cascade triggered by window maximize).  Writing
  // `element.style.opacity` directly via DOM lets the loop survive the
  // resize storm and produces a smooth ramp at all setting values down
  // to ~16 ms.  Decoupling from React render also means the entry can
  // be ramping toward 0 even while React's `currentTime` state lags by
  // a frame or two, so the fade-out window is never visually skipped.
  useEffect(() => {
    let raf = 0
    // REQ-086 — drift threshold between `<video>` (master clock) and the
    // hidden `<audio>` (slave) before we force-resync.  50 ms is above
    // typical inter-element jitter (a few ms) but well below the
    // perceptual threshold for audio-video lag (~80 ms), so the
    // correction is invisible-but-effective.  When over threshold we
    // snap the audio to the video's currentTime — Chromium pauses
    // playback for one frame around the assignment, which is far less
    // disruptive than letting an audible drift accumulate.
    const PREVIEW_MIX_DRIFT_THRESHOLD_SEC = 0.05
    const tick = () => {
      const v = videoRef.current
      const t = v?.currentTime ?? 0
      const entries = activeEntryMapRef.current
      for (const [id, el] of overlayOuterRefs.current) {
        const entry = entries.get(id)
        if (!entry) continue
        const next = String(
          computeFadeOpacity({
            currentTimeSec: t,
            startSec: entry.startSec,
            endSec: entry.endSec,
            fadeDurationSec: entry.fadeDurationSec,
          }),
        )
        // Guard CSSOM writes so a steady-state caption (mid-plateau,
        // opacity = "1") does not invalidate style every frame.
        if (el.style.opacity !== next) el.style.opacity = next
      }
      // REQ-086 — audio drift check piggy-backs on the same rAF.  The
      // guards (no audio element / video paused / video mid-seek) keep
      // us from poking the audio element during transient states where
      // a forced rewrite would be visually disruptive.
      const a = audioRef.current
      if (v && a && !v.paused && !v.seeking && !a.seeking) {
        const drift = a.currentTime - v.currentTime
        if (Math.abs(drift) > PREVIEW_MIX_DRIFT_THRESHOLD_SEC) {
          a.currentTime = v.currentTime
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

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
  const videoHeightPx = video?.heightPx ?? 0
  // REQ-20260614-001 補遺② 修正2 — compute the visible video-frame box
  // (largest box that preserves source aspect ratio AND fits in
  // previewBodySize).  When previewBodySize is still 0×0 (first render
  // before the layout effect commits) the frame falls back to 0×0, the
  // overlay map renders empty (early-return below), and the next render
  // after measurement paints normally.
  const aspect = videoWidthPx > 0 && videoHeightPx > 0
    ? videoWidthPx / videoHeightPx
    : 16 / 9
  const widthBound = previewBodySize.h * aspect > previewBodySize.w
  const videoFrameW = Math.max(0, widthBound ? previewBodySize.w : previewBodySize.h * aspect)
  const videoFrameH = Math.max(0, widthBound ? previewBodySize.w / aspect : previewBodySize.h)
  // `videoContainerWidth` is now a derived value (matches videoFrameW)
  // so SubtitleOverlay's px↔ASS scale stays in sync with the frame's
  // actual pixel size.  Replaces the old separate ResizeObserver on
  // videoContainerRef.
  const videoContainerWidth = videoFrameW

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

  // REQ-20260614-001 補遺② 修正2 — measure the preview body (the flex-1
  // region that hosts the video frame).  The frame's width/height are
  // computed below as the largest box that preserves the source aspect
  // ratio AND fits inside (clientWidth, clientHeight).  useLayoutEffect
  // so the first paint already sees a real size; ResizeObserver picks up
  // every pane-resize / window-resize.
  useLayoutEffect(() => {
    const el = previewBodyRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      setPreviewBodySize({ w: el.clientWidth, h: el.clientHeight })
    })
    obs.observe(el)
    setPreviewBodySize({ w: el.clientWidth, h: el.clientHeight })
    return () => obs.disconnect()
  }, [])

  // -------------------------------------------------------------------------
  // Play / pause
  // -------------------------------------------------------------------------

  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (!el) return
    const audio = audioRef.current
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
      // REQ-086 — align the audio playhead to the video's BEFORE both
      // start playing.  Without this, the audio would start from
      // wherever it last paused while the video had moved on (e.g. via
      // a subtitle-row seek that happened with `<audio>` not yet wired
      // through that path historically).  Aligning here also covers
      // the EOF-rewind branch above.
      if (audio) {
        audio.currentTime = el.currentTime
        // Surface failures instead of swallowing them — the original
        // REQ-086 silent `.catch(() => {})` masked a CSP block on the
        // `mojioko-preview-mix:` scheme that took a separate triage
        // pass to track down.  A console.error here would have
        // shortcut that.
        audio.play().catch((err) => {
          console.error('[preview-mix audio] play() rejected', err)
        })
      }
      el.play().catch(() => {})
    } else {
      el.pause()
      if (audio) audio.pause()
    }
  }, [])

  // REQ-20260614-001 Phase 2 — the "pause-on-collapse" effect retired
  // alongside the accordion.  Pane resize shrinks the preview area
  // without unmounting the <video>, so playback is naturally preserved
  // (and the user keeps explicit control via the play/pause button).

  // REQ-20260615-051 B / REQ-20260615-052 — global Space keydown
  // shortcut for play / pause.
  //
  // Attached at the **capture phase** of `document` so the handler always
  // runs BEFORE the focused element's own keydown handler, and BEFORE the
  // browser dispatches Space's default action (page scroll for the
  // nearest scroll container with focus inside it, or button activation
  // for focused buttons).  Capture phase + `preventDefault` +
  // `stopPropagation` together guarantee the shortcut wins regardless
  // of the focused element.
  //
  // Exception: when a focused element is one where Space inserts a
  // literal space character we let it through.  REQ-052 narrowed this
  // to the inputs that actually do that — `<textarea>`, contenteditable,
  // and `<input>` whose `type` is text-like.  REQ-051's first cut
  // bailed for every `<input>` regardless of type, which roped in
  // `<input type="range">` (the outline-thickness / fade-duration
  // sliders) and `<input type="number">` (size).  Range/number/etc. do
  // NOT insert a space on Space — the browser scrolls instead — so
  // bailing for them re-introduced the scroll bug the REQ-051 capture
  // phase was supposed to fix.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== 'Space' || e.ctrlKey || e.altKey || e.metaKey) return
      // REQ-0131 §2 context A — suppress Space play/pause while any
      // modal is open so it falls through to the modal (typing space
      // into the hex input, activating focused OK button, etc.).  Same
      // predicate the shared `useGlobalShortcuts` handler uses.
      if (isAnyOverlayOpen(useUiStore.getState())) return
      const active = document.activeElement as HTMLElement | null
      if (active) {
        if (active.isContentEditable) return
        const tag = active.tagName.toLowerCase()
        if (tag === 'textarea') return
        if (tag === 'input') {
          // Empty / missing `type` defaults to "text" per spec.
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
    // REQ-086 — when <video src> changes, also rewind the audio so the
    // two clocks restart together (Chromium does not reset <audio> on a
    // sibling element's src change).  Safe when audioRef is null.
    if (audioRef.current) {
      audioRef.current.currentTime = 0
    }
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
        // REQ-086 — match the hidden audio's playhead in the same tick
        // so a row-click seek does not cause a perceptible audio/video
        // delta.  No-op when audioRef is null (single-track / no mix).
        if (audioRef.current) {
          audioRef.current.currentTime = videoSeekRequestSec
        }
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

    // REQ-20260614-001 Phase 3 — `focusedRowId` is now the **playback
    // follower** (split from the user-selection slice).  Write the
    // currently-playing entry's id here so the table / timeline can
    // render the blue (sky) "currently playing" marker without touching
    // the user's explicit selection (`selectedEntryId`).  Skipped while
    // the user is editing a subtitle cell (CellEditor mounts a <textarea>)
    // because store writes during text-edit interfere with the IME path.
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
      // REQ-20260615-038 C — surface the guide for the in-flight drag.
      setDraggingEntryId(draggedEntry.id)

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
    setDraggingEntryId(null)
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
    // REQ-086 — keep the audio playhead aligned during seekbar drag so
    // the user does not hear the prior playback position while watching
    // the new one.  No-op when audioRef is null.
    if (audioRef.current) {
      audioRef.current.currentTime = origVal
    }
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!video || !videoUrl) return null

  const filename = getBasename(video.path)

  // REQ-20260614-001 Phase 2 — the panel now lives INSIDE the top-left
  // resizable pane (see step2.tsx).  Layout:
  //   1. Filename + open-in-folder header (one row)
  //   2. Flex-1 video container — sized via CSS aspect-ratio so the
  //      <video> always fits the pane while preserving the source
  //      aspect ratio
  //   3. Seekbar row (play button + range + time)
  //   4. Warning / approximate-preview note
  // Outer chrome (rounded border + bg) retired because the resizable
  // pane itself provides the visual boundary.
  const editedTotalSec = editedDuration(duration, cuts)
  const editedCurrentTime = origToEdited(currentTime, cuts)

  return (
    <div className="flex h-full w-full flex-col">
      {/* Header — filename + open-in-folder button.  Compact; designed
          to live INSIDE a resizable pane so wraps gracefully when the
          pane is narrow.  REQ-20260614-001 Phase 2. */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/50 flex-shrink-0 min-w-0">
        <span className="min-w-0 truncate text-body-sm text-foreground/80" title={video.path}>
          {filename}
        </span>
        <button
          type="button"
          onClick={() => shellShowInFolder(video.path).catch(() => {})}
          title={t('videoPreview.showInFolder')}
          className={cn(
            'flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors duration-150',
            'hover:text-foreground focus:outline-none focus-visible:text-foreground'
          )}
          aria-label={t('videoPreview.showInFolder')}
        >
          <FolderOpen className="h-4 w-4" />
        </button>
      </div>

      {/* Video frame area — REQ-20260614-001 補遺② 修正2.
          `previewBodyRef` is measured (clientWidth × clientHeight) so the
          frame inside can be sized in JS to the largest box that
          preserves source aspect ratio AND fits the body.  Explicit
          pixel sizes avoid the flexbox + `aspect-ratio` collapse that
          flattened the frame to 0×0 in the original Phase 2 attempt. */}
      <div
        ref={previewBodyRef}
        className="flex-1 min-h-0 flex items-center justify-center p-2 bg-surface-0"
      >
        {hasError ? (
          <span className="px-6 text-body-sm text-muted-foreground">{t('videoPreview.error')}</span>
        ) : videoFrameW > 0 && videoFrameH > 0 ? (
          <div
            ref={videoContainerRef}
            className="relative bg-input rounded overflow-hidden"
            style={{
              width: `${videoFrameW}px`,
              height: `${videoFrameH}px`,
            }}
          >
            <video
              ref={videoRef}
              src={videoUrl}
              preload="metadata"
              // REQ-086 — when a preview-mix audio file is available,
              // mute the <video> so we only hear the mix.  Otherwise
              // (single-track / no audio / no transcription yet) keep
              // <video> audio so the editor still has sound — this is
              // the legacy single-element behaviour, unchanged.
              muted={previewMixUrl !== null}
              className="absolute inset-0 h-full w-full object-contain"
              onTimeUpdate={handleTimeUpdate}
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={handlePlay}
              onPause={handlePause}
              onEnded={handleEnded}
              onError={handleError}
            />
            {/* REQ-086 — hidden multi-track preview mix.  When mounted
                (i.e. `previewMixUrl !== null`), this <audio> plays the
                amixed soundtrack while the <video> above is muted.
                Drift between the two is corrected in the rAF loop
                (PREVIEW_MIX_DRIFT_THRESHOLD_SEC = 50 ms).  The URL
                carries a `?t=<timestamp>` cache buster from the main
                process so Chromium fetches a freshly-generated mix
                instead of serving the prior cached body for the same
                fixed file path. */}
            {previewMixUrl !== null && (
              <audio
                ref={audioRef}
                src={previewMixUrl}
                preload="auto"
                className="hidden"
                onError={(e) => {
                  // Loud failure mode for any future regression in the
                  // mix → CSP → protocol → playback chain.  See the
                  // sibling comment in togglePlay's audio.play() catch
                  // for the rationale.  MediaError.code values:
                  //   1 ABORTED, 2 NETWORK, 3 DECODE, 4 SRC_NOT_SUPPORTED
                  // SRC_NOT_SUPPORTED with a CSP console message above is
                  // the signature of a missing `media-src` allowlist entry.
                  const el = e.currentTarget
                  console.error('[preview-mix audio] error', {
                    code: el.error?.code,
                    message: el.error?.message,
                    src: el.currentSrc,
                  })
                }}
              />
            )}
            {videoContainerWidth > 0 && overlayEntries.map((entry) => {
              const offset = stackOffsetsByEntryId.get(entry.id) ?? 0
              const isSelected = entry.id === selectedEntryId
              const isDragging = entry.id === draggingEntryId
              return (
                <SubtitleOverlay
                  key={entry.id}
                  entry={entry}
                  videoWidthPx={video.widthPx}
                  containerWidthPx={videoContainerWidth}
                  stackOffsetPx={offset}
                  onPointerDown={handleOverlayPointerDown}
                  spanRef={setOverlaySpanRef(entry.id)}
                  outerSpanRef={setOverlayOuterRef(entry)}
                  showAffordance={isSelected || isDragging}
                />
              )
            })}
            {/* REQ-20260615-038 C — OBS-style position guide overlay.
                Drawn for the inspector-selected row and for the row that
                is currently being dragged.  The guide measures the
                rendered subtitle span (via overlaySpanRefs) and renders
                bbox + four distance rulers + offset X/Y in OUTPUT pixel
                space.  Pointer-events-none so it never steals the drag
                pointer. */}
            {videoContainerWidth > 0 && videoFrameH > 0 && overlayEntries.map((entry) => {
              const isSelected = entry.id === selectedEntryId
              const isDragging = entry.id === draggingEntryId
              if (!isSelected && !isDragging) return null
              return (
                <PositionGuideOverlay
                  key={`guide-${entry.id}`}
                  entry={entry}
                  targetEl={overlaySpanRefs.current.get(entry.id) ?? null}
                  containerEl={videoContainerRef.current}
                  videoWidthPx={video.widthPx}
                  videoHeightPx={video.heightPx}
                  containerWidthPx={videoContainerWidth}
                  containerHeightPx={videoFrameH}
                />
              )
            })}
          </div>
        ) : null}
      </div>

      {/* Seekbar — REQ-20260614-001 §3: moved from the right column to
          DIRECTLY below the video frame.  Same play/pause + range +
          time-readout as the previous layout, just relocated. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-t border-border/50 flex-shrink-0">
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
          aria-label={(isPlaying ? t('videoPreview.pause') : t('videoPreview.play')) + shortcutHint('playPause')}
          title={(isPlaying ? t('videoPreview.pause') : t('videoPreview.play')) + shortcutHint('playPause')}
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

      {/* Warning / approximate-preview note — REQ-20260614-001 §3:
          relocated below the seekbar. */}
      <p className="px-3 py-1 text-caption text-muted-foreground flex-shrink-0">
        {t('subtitleLayout.previewNote')}
      </p>
    </div>
  )
}
