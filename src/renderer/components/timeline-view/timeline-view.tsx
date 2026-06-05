import { useMemo, useRef, useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Magnet, GanttChartSquare } from 'lucide-react'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import {
  useUiStore,
  TIMELINE_PPS_MIN,
  TIMELINE_PPS_MAX
} from '@/stores/ui-store'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { cn } from '@/lib/utils'
import { filterEntries } from '@/lib/subtitle-filter'
import { commitTimeEdit } from '@/lib/commit-time-edit'
import { roundToCs } from '@/lib/entry-edits'
import { formatTimecode } from '@/lib/time'
import {
  layoutEntries,
  chooseRulerStepSec,
  formatRulerLabel
} from '@/lib/timeline-layout'
import {
  buildSnapTargets,
  snapInterval,
  SNAP_DISTANCE_PX,
  type SnapResult
} from '@/lib/timeline-snap'
import type { EntryWarnings } from '@/lib/entry-warnings'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { TimelineBlockInspector } from './timeline-block-inspector'
import type { SubtitleEntry } from '../../../shared/types'

// ---------------------------------------------------------------------------
// Layout constants (pixels)
// ---------------------------------------------------------------------------

const RULER_HEIGHT_PX        = 28
/**
 * Block + track heights — doubled vs the original 32/44 px so each block
 * has room for a two-row layout (timecodes on top, text on bottom).  The
 * pad value is intentionally a derived constant so the block always sits
 * centred inside its track row.  REQ-061.
 */
const TRACK_HEIGHT_PX        = 88
const BLOCK_HEIGHT_PX        = 64
const BLOCK_VERTICAL_PAD_PX  = (TRACK_HEIGHT_PX - BLOCK_HEIGHT_PX) / 2
const TRACK_GUTTER_LEFT_PX   = 56   // left gutter for track labels (T0, T1, …)
const ZOOM_STEP_PX           = 10
/** Width of each resize handle (left/right edge of a block) in CSS pixels. */
const RESIZE_HANDLE_PX       = 6
/**
 * Minimum block width (px) at which the top "timecode row" is rendered.
 * Below this the row is hidden entirely — showing only one end of the
 * time range, OR showing both ends touching, would be worse than showing
 * none (the user can't tell which end they're looking at).  REQ-061.
 *
 * Budget derivation (text-[10px] monospace tabular, empirically ~6.5 px
 * per char rather than the textbook 6 px):
 *   - "00:00:06.92" = 11 chars × ~6.5 px ≈ 72 px per timecode
 *   - 2 × timecode + ≥ 4-char visible gap (24 px) + px-2 padding both
 *     sides (16 px)
 *   - 72 + 72 + 24 + 16 ≈ 184 → rounded up to 200 px for comfortable
 *     headroom against subpixel rendering differences
 */
const TIME_ROW_MIN_BLOCK_WIDTH_PX = 200
/**
 * Minimum block duration in seconds — protects against drags that would
 * collapse start ≥ end and produce a 0-duration row.  Matches the precision
 * of `TIME_EPS_SEC` in timeline-layout.ts and is small enough that a real
 * subtitle (which needs to be on screen long enough to be read) is never
 * accidentally clamped to this floor by a normal drag.
 */
const MIN_BLOCK_SEC          = 0.05

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface RulerProps {
  pixelsPerSec: number
  totalSec: number
  /**
   * Seek the video to `sec`.  Called once per pointerdown (instant
   * jump) AND continuously during a ruler-scrub drag.  REQ-063 #2.
   */
  onSeek: (sec: number) => void
}

function Ruler({ pixelsPerSec, totalSec, onSeek }: RulerProps) {
  const stepSec = chooseRulerStepSec(pixelsPerSec)
  const tickCount = Math.ceil(totalSec / stepSec) + 1
  const widthPx = totalSec * pixelsPerSec
  const rulerRef = useRef<HTMLDivElement>(null)

  // Scrub state: when a pointer is held down on the ruler, every
  // pointermove fires onSeek so the video preview tracks the cursor in
  // real time.  REQ-063 #2.  Plain refs (not state) because we don't
  // need re-renders while dragging — the playhead position is driven by
  // the shared `videoCurrentTimeSec` store slice that VideoPreviewPanel
  // updates as the video element seeks.
  const isScrubbingRef = useRef(false)

  function xToSec(clientX: number): number {
    const el = rulerRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const xPx = clientX - rect.left
    const sec = xPx / pixelsPerSec
    // Clamp to the ruler's visible range — outside the timeline is not a
    // meaningful seek target and the video element would clamp anyway.
    return Math.max(0, Math.min(totalSec, sec))
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return
    e.preventDefault()
    isScrubbingRef.current = true
    // Capture so the up event still reaches us if the cursor leaves the
    // ruler mid-drag (matches the convention in Block.handleEdgePointerDown).
    e.currentTarget.setPointerCapture(e.pointerId)
    onSeek(xToSec(e.clientX))
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isScrubbingRef.current) return
    onSeek(xToSec(e.clientX))
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!isScrubbingRef.current) return
    isScrubbingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // Capture may already be released if the element re-mounted —
      // safe to ignore.
    }
  }

  const ticks = []
  for (let i = 0; i < tickCount; i++) {
    const sec = i * stepSec
    if (sec > totalSec + stepSec) break
    const xPx = sec * pixelsPerSec
    ticks.push(
      <div
        key={i}
        className="absolute top-0 bottom-0 flex flex-col items-start"
        style={{ left: `${xPx}px` }}
      >
        <div className="h-full w-px bg-zinc-700/60" />
        <span className="absolute top-1 left-1 text-[10px] font-mono tabular-nums text-zinc-500 select-none">
          {formatRulerLabel(sec, stepSec)}
        </span>
      </div>
    )
  }

  return (
    <div
      ref={rulerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className="relative cursor-ew-resize bg-zinc-900 border-b border-zinc-800 touch-none select-none"
      style={{ width: `${widthPx}px`, height: `${RULER_HEIGHT_PX}px` }}
    >
      {ticks}
    </div>
  )
}

type DragKind = 'resize-start' | 'resize-end' | 'move'

interface BlockProps {
  entry: SubtitleEntry
  warnings: EntryWarnings | null
  leftPx: number
  widthPx: number
  /** Absolute top in pixels (already includes track offset). */
  topPx: number
  trackIndex: number
  isFocused: boolean
  isOverflow: boolean
  displayIndex: number
  /** Whether this block's inspector Popover is currently open. */
  isInspectorOpen: boolean
  /** True while a drag is in progress for this block — suppresses popover open. */
  isDragging: boolean
  /** Click handler — focus the row + seek the video + open the inspector. */
  onSelect: (id: string, startSec: number) => void
  onInspectorOpenChange: (open: boolean) => void
  onAdjustTime: (entryId: string) => void
  /** Start a drag (resize or move) — TimelineView attaches window listeners. */
  onStartDrag: (kind: DragKind, entry: SubtitleEntry, clientX: number) => void
}

function Block({
  entry,
  warnings,
  leftPx,
  widthPx,
  topPx,
  trackIndex,
  isFocused,
  isOverflow,
  displayIndex,
  isInspectorOpen,
  isDragging,
  onSelect,
  onInspectorOpenChange,
  onAdjustTime,
  onStartDrag
}: BlockProps) {
  const { t } = useTranslation(['step2'])
  const ariaLabel = t('timeline.block.ariaLabel', {
    track: trackIndex,
    index: displayIndex
  })
  const displayText = entry.text.replace(/\\N/g, ' ').trim()

  // Click-vs-drag bookkeeping for the body button (Phase 4).  Pointerdown
  // records the origin; pointermove flips `moved` once the cursor crosses
  // the 3 px threshold; click swallows the open-popover action if `moved`
  // was set so a real drag never pops the inspector mid-motion.  Refs
  // (not state) so writes do not retrigger renders during the drag.
  const bodyDownXRef = useRef<number | null>(null)
  const bodyMovedRef = useRef(false)
  const BODY_DRAG_THRESHOLD_PX = 3

  function handleEdgePointerDown(kind: 'resize-start' | 'resize-end') {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      // Only react to primary mouse button / touch contact.
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      onStartDrag(kind, entry, e.clientX)
    }
  }

  function handleBodyPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || entry.isDeleted) return
    bodyDownXRef.current = e.clientX
    bodyMovedRef.current = false
    // Kick off the 'move' drag eagerly — TimelineView's handler defers any
    // entry mutation until the pointer crosses the threshold (see the
    // dxPx check in applyDragPatch's 'move' branch).  Doing it on
    // pointerdown rather than after a debounce avoids a perceptible
    // "stickiness" at drag start.
    onStartDrag('move', entry, e.clientX)
  }

  function handleBodyPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const down = bodyDownXRef.current
    if (down === null) return
    if (Math.abs(e.clientX - down) > BODY_DRAG_THRESHOLD_PX) {
      bodyMovedRef.current = true
    }
  }

  function handleBodyClick(e: React.MouseEvent<HTMLButtonElement>) {
    e.stopPropagation()
    bodyDownXRef.current = null
    if (bodyMovedRef.current) {
      // A drag happened — swallow the click so the inspector doesn't
      // pop open on top of the freshly-moved block.
      bodyMovedRef.current = false
      return
    }
    onSelect(entry.id, entry.startSec)
  }

  return (
    <Popover
      open={isInspectorOpen && !isDragging}
      onOpenChange={(open) => {
        // Radix tries to open the popover on pointerdown by default — when a
        // drag is in progress we want to suppress that.
        if (isDragging && open) return
        onInspectorOpenChange(open)
      }}
    >
      {/* Outer wrapper sized to the block — left handle / body button /
          right handle live inside.  Sized exactly to the block so multiple
          wrappers on the same track never overlap and steal each other's
          pointer events (the Phase 1 latent bug we fixed in Phase 2). */}
      <div
        className="absolute"
        style={{
          left: `${leftPx}px`,
          top: `${topPx}px`,
          width: `${Math.max(2, widthPx)}px`,
          height: `${BLOCK_HEIGHT_PX}px`
        }}
      >
        {/* Left edge handle.  z-index lifts it above the body so its 6 px
            hit area wins over the button when the cursor sits on the edge.
            Hidden for deleted rows — editing a deleted row's time is a
            no-op (matches subtitle-table's disabled time inputs). */}
        {!entry.isDeleted && widthPx > RESIZE_HANDLE_PX * 2 && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('timeline.block.resizeStart')}
            onPointerDown={handleEdgePointerDown('resize-start')}
            className={cn(
              'absolute top-0 bottom-0 left-0 z-10 cursor-ew-resize',
              'hover:bg-green-500/40 transition-colors duration-100'
            )}
            style={{ width: `${RESIZE_HANDLE_PX}px` }}
          />
        )}

        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            onPointerDown={handleBodyPointerDown}
            onPointerMove={handleBodyPointerMove}
            onClick={handleBodyClick}
            title={displayText}
            className={cn(
              'absolute inset-0 flex flex-col justify-center gap-0.5 px-2 py-1 rounded-md text-left',
              'transition-colors duration-150 select-none overflow-hidden',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40',
              'bg-zinc-700/70 text-zinc-100 border border-zinc-600/70',
              'hover:bg-zinc-700 hover:border-zinc-500',
              entry.isEdited && !entry.isDeleted && 'bg-amber-400/15 border-amber-400/40 hover:bg-amber-400/25',
              isOverflow && !entry.isDeleted && 'bg-red-500/15 border-red-500/40 hover:bg-red-500/25',
              isFocused && 'ring-2 ring-green-500 border-green-500 bg-green-500/15 text-zinc-50',
              entry.isDeleted && 'opacity-40 line-through',
              !entry.isDeleted && 'cursor-grab active:cursor-grabbing'
            )}
          >
            {/* Row 1 — timecodes.  Rendered only when the block is wide
                enough to show BOTH ends with at least a 2-char gap
                between them.  Showing only one end would be ambiguous
                (the user can't tell whether it's start or end), so we
                go all-or-nothing.  REQ-061. */}
            {widthPx >= TIME_ROW_MIN_BLOCK_WIDTH_PX && (
              <div className="flex w-full items-baseline justify-between text-[10px] font-mono tabular-nums text-zinc-300/80 leading-none">
                <span>{formatTimecode(entry.startSec)}</span>
                <span>{formatTimecode(entry.endSec)}</span>
              </div>
            )}
            {/* Row 2 — text (truncated, single line for now to keep the
                block compact).  Placeholder `·` keeps the block visually
                anchored when text is empty. */}
            <span className="block truncate text-body-sm leading-tight">
              {displayText || '·'}
            </span>
          </button>
        </PopoverTrigger>

        {!entry.isDeleted && widthPx > RESIZE_HANDLE_PX * 2 && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('timeline.block.resizeEnd')}
            onPointerDown={handleEdgePointerDown('resize-end')}
            className={cn(
              'absolute top-0 bottom-0 right-0 z-10 cursor-ew-resize',
              'hover:bg-green-500/40 transition-colors duration-100'
            )}
            style={{ width: `${RESIZE_HANDLE_PX}px` }}
          />
        )}
      </div>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="p-3"
        // REQ-061 #2(a): suppress Radix's default "focus first focusable
        // child" so the textarea inside the inspector is NOT auto-focused
        // / selected on open.  Click-to-edit is now the explicit gesture
        // — opening a block highlights but does not enter edit mode,
        // matching the list view's row-click behaviour.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // REQ-061 #2(b) / REQ-062: the inspector lives in a Radix
        // Portal at the DOM level, but React's synthetic events still
        // bubble up the React tree — clicks inside the popover would
        // reach the tracks' `onClick={handleTracksBackgroundClick}` and
        // trigger a spurious video seek.  Stop the event in **bubble**
        // phase (not capture) so the target's own handlers — X-close,
        // Reset, Delete, AutoLineBreak, ColorPicker, sliders, etc. —
        // fire first; we only suppress further upward propagation
        // toward the tracks div.  Capture-phase stops killed every
        // button inside the inspector silently (REQ-062 #1 / #2).
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <TimelineBlockInspector
          entry={entry}
          warnings={warnings}
          onAdjustTime={onAdjustTime}
          onClose={() => onInspectorOpenChange(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface TimelineViewProps {
  /** Same per-entry warning bitmap the table consumes — drives block tint and Ready/Warnings filter. */
  warningsMap: ReadonlyMap<string, EntryWarnings>
  /** Video duration (seconds); `Infinity` when no video or in audio-only mode. */
  videoDurationSec: number
  /**
   * Open the shared TimeEditorDialog in edit mode for the given entry.
   * Same signature as SubtitleTable's `onAdjustTime` so step2.tsx can pass
   * a single `openEditTimeDialog` reference to either view.
   */
  onAdjustTime: (entryId: string) => void
}

/**
 * STEP 2 timeline view.
 *
 * Renders the same `useProjectStore.entries` the subtitle-table consumes,
 * but as horizontal blocks on multiple tracks.
 *
 *  - Clicking a block focuses the row in the shared `focusedRowId` store
 *    slice (so the subtitle-table view shows the same selection on switch
 *    back), seeks the video preview to the block's startSec, AND opens an
 *    inspector Popover anchored to the block (Phase 2) so the user can
 *    read / edit the entry's text, see warnings, jump into the existing
 *    TimeEditorDialog, or delete-restore the row.
 *  - Clicking the ruler / empty timeline area seeks the video.
 *  - The current `videoCurrentTimeSec` is drawn as a vertical red
 *    playhead; that store slice is updated by the existing
 *    VideoPreviewPanel on every `timeupdate`.
 *  - Filter tabs continue to drive what's visible (`filterEntries`).
 *
 * Drag-to-edit interactions land in Phases 3–4, snap in Phase 5.  See
 * `dev-docs/specs/timeline.md`.
 */
export function TimelineView({ warningsMap, videoDurationSec, onAdjustTime }: TimelineViewProps) {
  const { t } = useTranslation(['step2'])
  const entries = useProjectStore((s) => s.entries)
  const tableFilter = useUiStore((s) => s.tableFilter)
  const focusedRowId = useUiStore((s) => s.focusedRowId)
  const setFocusedRowId = useUiStore((s) => s.setFocusedRowId)
  const setVideoSeekRequest = useUiStore((s) => s.setVideoSeekRequest)
  const videoCurrentTimeSec = useUiStore((s) => s.videoCurrentTimeSec)
  const pixelsPerSec = useUiStore((s) => s.timelinePixelsPerSec)
  const setPixelsPerSec = useUiStore((s) => s.setTimelinePixelsPerSec)
  const snapEnabled = useUiStore((s) => s.timelineSnapEnabled)
  const setSnapEnabled = useUiStore((s) => s.setTimelineSnapEnabled)
  const scrollToRowId = useUiStore((s) => s.scrollToRowId)
  const setScrollToRowId = useUiStore((s) => s.setScrollToRowId)
  const isAudioOnly = useIsAudioOnly()

  // Apply the same filter the table uses so a "Ready" tab hides warning
  // rows in timeline view too.
  const visibleEntries = useMemo(
    () => filterEntries(entries, tableFilter, warningsMap),
    [entries, tableFilter, warningsMap]
  )

  // Fallback duration: video duration when available, otherwise the last
  // entry's endSec stretched by 20 % so the timeline still has something to
  // span when no video is loaded (REQ-052 Phase 0 §13).
  const fallbackDurationSec = useMemo(() => {
    if (isFinite(videoDurationSec) && videoDurationSec > 0) return videoDurationSec
    const maxEnd = entries.reduce((m, e) => (e.endSec > m ? e.endSec : m), 0)
    return Math.max(10, maxEnd * 1.2)
  }, [videoDurationSec, entries])

  const layout = useMemo(
    () => layoutEntries(visibleEntries, fallbackDurationSec),
    [visibleEntries, fallbackDurationSec]
  )

  // Index in the unfiltered, unsorted entries array — used for the human-
  // readable label on each block ("row N" matches the table's `displayIndex`
  // when no filter is active).
  const indexOfEntry = useMemo(() => {
    const map = new Map<string, number>()
    let displayIdx = 0
    for (const e of entries) {
      if (!e.isDeleted) {
        displayIdx += 1
        map.set(e.id, displayIdx)
      } else {
        map.set(e.id, -1)
      }
    }
    return map
  }, [entries])

  const totalSec   = layout.totalSec
  const trackCount = Math.max(1, layout.trackCount)
  const widthPx    = totalSec * pixelsPerSec
  const tracksHeightPx = trackCount * TRACK_HEIGHT_PX

  // Inspector open-id — single-popover invariant.  Lives as local state
  // rather than in ui-store because no other component needs to know
  // which block has its inspector open (and persisting it across navigations
  // would surface a stale popover when returning to STEP 2).
  const [openInspectorId, setOpenInspectorId] = useState<string | null>(null)

  // Filter changes can hide the currently-open block; close the inspector
  // in that case so a stale popover never lingers off-screen.
  const visibleIds = useMemo(
    () => new Set(visibleEntries.map((e) => e.id)),
    [visibleEntries]
  )
  useEffect(() => {
    if (openInspectorId && !visibleIds.has(openInspectorId)) {
      setOpenInspectorId(null)
    }
  }, [openInspectorId, visibleIds])

  // -------------------------------------------------------------------------
  // Drag state (Phase 3 onwards)
  //
  // The active drag is held in a ref so the window-level pointermove /
  // pointerup listeners can read the latest values without re-attaching on
  // every render.  A parallel React state (`draggingId`) only exists so the
  // Block component can re-render with the "dragging" flag set (used to
  // suppress popover open during a drag).
  // -------------------------------------------------------------------------

  interface ActiveDrag {
    kind: DragKind
    entryId: string
    snapshot: SubtitleEntry
    /** Pointer clientX at drag-start — drag delta is computed from this. */
    originClientX: number
  }

  const activeDragRef = useRef<ActiveDrag | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)

  // Stable mirrors of the live values that the (mount-once) pointer
  // listeners need to read without re-attaching whenever React state
  // changes mid-drag.  Includes everything the snap computation depends
  // on so a zoom or playhead change between pointerdown and pointerup
  // is reflected in the next pointermove tick.
  const liveContextRef = useRef({
    pixelsPerSec,
    videoDurationSec,
    snapEnabled,
    videoCurrentTimeSec,
    entries
  })
  useEffect(() => {
    liveContextRef.current = {
      pixelsPerSec,
      videoDurationSec,
      snapEnabled,
      videoCurrentTimeSec,
      entries
    }
  })

  // Snap guide: x-pixel position (in timeline content coordinates, i.e.
  // post-gutter) of the active snap target, or null when no snap is
  // currently anchoring the drag.  Cleared on drag release.
  const [snapGuidePx, setSnapGuidePx] = useState<number | null>(null)
  const [snapGuideKind, setSnapGuideKind] = useState<SnapResult['kind'] | null>(null)

  const handleStartDrag = useCallback(
    (kind: DragKind, entry: SubtitleEntry, clientX: number) => {
      activeDragRef.current = {
        kind,
        entryId: entry.id,
        snapshot: { ...entry, original: { ...entry.original } },
        originClientX: clientX
      }
      setDraggingId(entry.id)
      // Close any open inspector so the popover doesn't visually follow the
      // block during a resize or move.
      setOpenInspectorId((cur) => (cur === entry.id ? null : cur))
    },
    []
  )

  // Window pointermove / pointerup listeners — attached once on mount, read
  // the active drag through the ref so they don't need re-attachment.
  useEffect(() => {
    function applyDragPatch(d: ActiveDrag, e: PointerEvent): void {
      const {
        pixelsPerSec: pps,
        videoDurationSec: dur,
        snapEnabled,
        videoCurrentTimeSec: playhead,
        entries: liveEntries
      } = liveContextRef.current
      const dxPx = e.clientX - d.originClientX
      const dxSec = dxPx / pps
      const snap = d.snapshot
      const maxEnd = isFinite(dur) && dur > 0 ? dur : Number.MAX_VALUE
      let rawStart = snap.startSec
      let rawEnd   = snap.endSec
      if (d.kind === 'resize-start') {
        const ceiling = snap.endSec - MIN_BLOCK_SEC
        rawStart = Math.min(ceiling, Math.max(0, snap.startSec + dxSec))
      } else if (d.kind === 'resize-end') {
        const floor = snap.startSec + MIN_BLOCK_SEC
        rawEnd = Math.max(floor, Math.min(maxEnd, snap.endSec + dxSec))
      } else if (d.kind === 'move') {
        if (Math.abs(dxPx) < 3) return
        const duration = snap.endSec - snap.startSec
        const maxStart = Math.max(0, maxEnd - duration)
        rawStart = Math.min(maxStart, Math.max(0, snap.startSec + dxSec))
        rawEnd = rawStart + duration
      }

      // Snap pass — bypassed when the user holds Alt (Sketch / Figma
      // convention for "temporarily disable snap") or when snap is
      // turned off in the toolbar.
      let finalStart = rawStart
      let finalEnd   = rawEnd
      let guide: SnapResult | null = null
      if (snapEnabled && !e.altKey) {
        const totalForGrid = isFinite(dur) && dur > 0
          ? dur
          : Math.max(
              10,
              liveEntries.reduce((m, x) => (x.endSec > m ? x.endSec : m), 0) * 1.2
            )
        const targets = buildSnapTargets(
          liveEntries,
          d.entryId,
          playhead,
          totalForGrid,
          chooseRulerStepSec(pps)
        )
        const snapped = snapInterval(
          rawStart,
          rawEnd,
          d.kind,
          targets,
          pps,
          SNAP_DISTANCE_PX
        )
        // Re-clamp after snap so a snapped edge that would put start > end
        // or exceed video duration is corrected.  Snap targets are vetted
        // for proximity not legality.
        finalStart = Math.max(0, Math.min(maxEnd - MIN_BLOCK_SEC, snapped.startSec))
        finalEnd   = Math.max(finalStart + MIN_BLOCK_SEC, Math.min(maxEnd, snapped.endSec))
        guide = snapped.guide
      }

      // Round to centisecond precision before writing — `dxPx / pps` and the
      // subsequent additions produce float drift (e.g. 13.0700001s for a
      // round-trip drag back to 13.07s), which leaves the row visibly
      // unchanged in the cs-formatted TimeInput but flagged as edited
      // forever because the stored float ≠ original.  REQ-059.  This makes
      // drag output match the TimeEditorDialog's `roundCs` confirm path and
      // the cs-aligned values produced by the inline TimeInput.
      finalStart = roundToCs(finalStart)
      finalEnd   = roundToCs(finalEnd)

      // Visual snap guide — a 1 px vertical line in timeline-content
      // coordinates.  Cleared if no snap.
      setSnapGuidePx(guide ? guide.timeSec * pps : null)
      setSnapGuideKind(guide ? guide.kind : null)

      // Build the minimal patch — different kinds touch different fields
      // to keep history pushes meaningful (a resize-end shouldn't claim
      // it touched startSec).
      let patch: Partial<SubtitleEntry>
      if (d.kind === 'resize-start') {
        patch = { startSec: finalStart, isEdited: true }
      } else if (d.kind === 'resize-end') {
        patch = { endSec: finalEnd, isEdited: true }
      } else {
        patch = { startSec: finalStart, endSec: finalEnd, isEdited: true }
      }
      useProjectStore.getState().updateEntry(d.entryId, patch)
    }

    function onMove(e: PointerEvent) {
      const d = activeDragRef.current
      if (!d) return
      applyDragPatch(d, e)
    }
    function onUp() {
      const d = activeDragRef.current
      if (!d) return
      // Read the final entry state from the store; if nothing changed,
      // skip the history push and the commitTimeEdit re-sort.
      const cur = useProjectStore
        .getState()
        .entries.find((x) => x.id === d.entryId)
      const movedTime =
        cur !== undefined &&
        (cur.startSec !== d.snapshot.startSec || cur.endSec !== d.snapshot.endSec)
      if (cur && movedTime) {
        const before = d.snapshot
        const after = { ...cur }
        useHistoryStore.getState().push({
          label: timelineHistoryLabelRef.current,
          undo: () => {
            useProjectStore.getState().updateEntry(before.id, before)
            commitTimeEdit(before.id)
          },
          redo: () => {
            useProjectStore.getState().updateEntry(before.id, after)
            commitTimeEdit(before.id)
          }
        })
        commitTimeEdit(d.entryId)
      }
      activeDragRef.current = null
      setDraggingId(null)
      setSnapGuidePx(null)
      setSnapGuideKind(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // History label for time edits via drag — captured in a ref so the mount-
  // once pointer listeners always read a translated string.
  const timelineHistoryLabelRef = useRef('')
  useEffect(() => {
    timelineHistoryLabelRef.current = t('history.editTime')
  })

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const handleSelectBlock = useCallback((id: string, startSec: number) => {
    setFocusedRowId(id)
    setVideoSeekRequest(startSec)
    setOpenInspectorId(id)
  }, [setFocusedRowId, setVideoSeekRequest])

  const handleInspectorOpenChange = useCallback((id: string, open: boolean) => {
    // Guard the close path so a stale event (e.g. another block opened in
    // the meantime) does not unintentionally clobber the current owner.
    if (open) setOpenInspectorId(id)
    else setOpenInspectorId((prev) => (prev === id ? null : prev))
  }, [])

  const handleSeek = useCallback((sec: number) => {
    setVideoSeekRequest(sec)
  }, [setVideoSeekRequest])

  function handleTracksBackgroundClick(e: React.MouseEvent<HTMLDivElement>) {
    // Only react to clicks on the empty track background; the blocks themselves
    // stop propagation in their own onClick.
    const rect = e.currentTarget.getBoundingClientRect()
    const xPx  = e.clientX - rect.left
    handleSeek(Math.max(0, xPx / pixelsPerSec))
  }

  function handleZoomOut() {
    setPixelsPerSec(pixelsPerSec - ZOOM_STEP_PX)
  }
  function handleZoomIn() {
    setPixelsPerSec(pixelsPerSec + ZOOM_STEP_PX)
  }

  // Keep the playhead in view while playing.  Phase 1: simple "if playhead
  // leaves the viewport, scroll it back to one third".  Phase 6 can refine.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const playheadXPx = videoCurrentTimeSec * pixelsPerSec + TRACK_GUTTER_LEFT_PX
    const visibleLeft  = el.scrollLeft
    const visibleRight = visibleLeft + el.clientWidth
    if (playheadXPx < visibleLeft || playheadXPx > visibleRight - 24) {
      const target = playheadXPx - el.clientWidth / 3
      el.scrollLeft = Math.max(0, target)
    }
  }, [videoCurrentTimeSec, pixelsPerSec])

  // Consume scrollToRowId from ui-store — set by the subtitle-table when
  // a row is added or its time is adjusted.  In timeline view we honour
  // the same signal by horizontally scrolling so the entry's block lands
  // near the centre of the viewport; coming back to /step2 with a
  // pending scrollToRowId now keeps both views in sync.
  useEffect(() => {
    if (!scrollToRowId) return
    const targetId = scrollToRowId
    const entry = useProjectStore.getState().entries.find((e) => e.id === targetId)
    if (!entry) {
      setScrollToRowId(null)
      return
    }
    const el = scrollRef.current
    if (!el) return
    // Defer a tick so the layout reflects any just-changed pps / entries.
    const timer = setTimeout(() => {
      const blockX = entry.startSec * pixelsPerSec + TRACK_GUTTER_LEFT_PX
      el.scrollLeft = Math.max(0, blockX - el.clientWidth / 2)
      setScrollToRowId(null)
    }, 80)
    return () => clearTimeout(timer)
  }, [scrollToRowId, pixelsPerSec, setScrollToRowId])

  // Ctrl+wheel zoom around the mouse position.  React's onWheel is passive
  // by default so it cannot preventDefault; attach the listener manually
  // on the scroll container with `{ passive: false }` so we can suppress
  // the default ctrl+wheel "browser page zoom" behaviour as well as the
  // overflow-scroll the container would otherwise do.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey || !el) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mouseClientX = e.clientX - rect.left
      // Convert pointer position to a fixed timeline-content x, then to a
      // time in seconds at the CURRENT zoom — that anchor stays under the
      // cursor across the zoom.
      const mouseContentX = mouseClientX + el.scrollLeft
      const currentPps = liveContextRef.current.pixelsPerSec
      const timeAtMouse = (mouseContentX - TRACK_GUTTER_LEFT_PX) / currentPps
      // Geometric zoom factor — feels more natural than linear because the
      // px/sec scale spans more than a decade.  10 % per wheel tick.
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
      const nextPps = Math.min(
        TIMELINE_PPS_MAX,
        Math.max(TIMELINE_PPS_MIN, currentPps * factor)
      )
      if (nextPps === currentPps) return
      setPixelsPerSec(nextPps)
      // Adjust scrollLeft after the next paint so the same time still sits
      // under the cursor.  rAF (not setTimeout) so the visual frame is the
      // post-zoom one and the user sees no flicker.
      requestAnimationFrame(() => {
        if (!el) return
        const newContentX = timeAtMouse * nextPps + TRACK_GUTTER_LEFT_PX
        el.scrollLeft = newContentX - mouseClientX
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setPixelsPerSec])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const playheadXPx = videoCurrentTimeSec * pixelsPerSec

  const hasAnyVisible = visibleEntries.length > 0

  return (
    <div className="flex flex-col h-full bg-zinc-950">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-shrink-0 border-b border-zinc-800 bg-zinc-900 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={pixelsPerSec <= TIMELINE_PPS_MIN}
            title={t('timeline.toolbar.zoomOut')}
            aria-label={t('timeline.toolbar.zoomOut')}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md text-zinc-400',
              'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150',
              'disabled:opacity-30 disabled:pointer-events-none'
            )}
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          {/* Continuous zoom slider — REQ-063 #3.  Native <input
              type=range> instead of the commit-only OutlineThicknessSlider
              because zoom needs LIVE updates so the user sees the timeline
              re-scale while they drag.  accentColor routes the thumb through
              --primary like every other slider in the app.  Reads pixelsPerSec
              from the store (Ctrl+wheel zoom updates the same slice) so
              wheel-driven zoom drives the slider position automatically. */}
          <input
            type="range"
            min={TIMELINE_PPS_MIN}
            max={TIMELINE_PPS_MAX}
            step={1}
            value={pixelsPerSec}
            onChange={(e) => setPixelsPerSec(Number(e.target.value))}
            title={t('timeline.toolbar.zoomSlider')}
            aria-label={t('timeline.toolbar.zoomSlider')}
            className="w-32"
            style={{ accentColor: 'hsl(var(--primary))' }}
          />
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={pixelsPerSec >= TIMELINE_PPS_MAX}
            title={t('timeline.toolbar.zoomIn')}
            aria-label={t('timeline.toolbar.zoomIn')}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md text-zinc-400',
              'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150',
              'disabled:opacity-30 disabled:pointer-events-none'
            )}
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          {/* REQ-068: zoom level label moved to the END of the cluster
              ([−][slider][+][label]).  Reading order matches "control inputs
              first, then the readout that reflects the result".
              REQ-069 #1: text-[11px] → text-body-sm (body-sm tier) so the
              "px/秒" readout reads at the same scale as other status text;
              w-[64px] → w-[72px] to absorb the slightly wider 13-px digits. */}
          <span className="font-mono tabular-nums text-body-sm text-zinc-500 select-none w-[72px] text-center">
            {t('timeline.toolbar.zoomLevel', { pps: pixelsPerSec })}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* REQ-069 #2: 「Nトラック」 readout removed.  The count is a
              by-product of the greedy lane-assignment algorithm with no
              meaningful action for the user — keeping it on permanent
              chrome was noise.  Snap toggle stays (functional control). */}
          {/* Snap toggle — disabled-looking in Phase 1 (algorithm lands in Phase 5)
              but the flag is wired so behaviour change won't need a new UI later.
              REQ-069 #1: text-[11px] → text-body-sm to match the rest of the
              upgraded toolbar typography. */}
          <button
            type="button"
            onClick={() => setSnapEnabled(!snapEnabled)}
            title={t('timeline.toolbar.snapHelp')}
            className={cn(
              'flex h-7 items-center gap-1.5 px-2 rounded-md text-body-sm font-medium',
              'transition-colors duration-150',
              snapEnabled
                ? 'bg-zinc-800 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
            )}
            aria-pressed={snapEnabled}
          >
            <Magnet className="h-3 w-3" />
            {t('timeline.toolbar.snap')}
          </button>
        </div>
      </div>

      {/* Scroll container */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-auto"
      >
        {!hasAnyVisible ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-16 text-zinc-500">
            <GanttChartSquare className="h-8 w-8 text-zinc-700" />
            <p className="text-body font-medium">
              {tableFilter === 'all'
                ? t('timeline.emptyAll')
                : t('timeline.emptyFiltered')}
            </p>
          </div>
        ) : (
          <div
            className="relative"
            style={{
              width: `${TRACK_GUTTER_LEFT_PX + widthPx}px`,
              minHeight: `${RULER_HEIGHT_PX + tracksHeightPx}px`
            }}
          >
            {/* Track-label gutter — sticky to the left so labels stay visible
                while the user scrolls horizontally. */}
            <div
              className="absolute top-0 left-0 z-10 bg-zinc-900 border-r border-zinc-800"
              style={{
                width: `${TRACK_GUTTER_LEFT_PX}px`,
                height: `${RULER_HEIGHT_PX + tracksHeightPx}px`
              }}
            >
              {/* Spacer matching ruler height so labels line up with their tracks. */}
              <div style={{ height: `${RULER_HEIGHT_PX}px` }} />
              {Array.from({ length: trackCount }).map((_, i) => (
                <div
                  key={i}
                  className="flex items-center justify-center border-b border-zinc-800/50"
                  style={{ height: `${TRACK_HEIGHT_PX}px` }}
                >
                  {/* 1-based labels: video-editing tools conventionally
                      count tracks from 1 (Final Cut, Premiere, Resolve).
                      The 0-based aria-label in Block stays 0-based for
                      consistency with the placement.trackIndex value the
                      smoke scripts query. */}
                  <span className="text-[10px] font-mono text-zinc-500 select-none">
                    {t('timeline.trackLabel', { index: i + 1 })}
                  </span>
                </div>
              ))}
            </div>

            {/* Time-axis content (ruler + tracks + playhead) — offset by the gutter. */}
            <div
              className="absolute top-0"
              style={{
                left: `${TRACK_GUTTER_LEFT_PX}px`,
                width: `${widthPx}px`
              }}
            >
              <Ruler
                pixelsPerSec={pixelsPerSec}
                totalSec={totalSec}
                onSeek={handleSeek}
              />

              {/* Tracks area */}
              <div
                onClick={handleTracksBackgroundClick}
                className="relative"
                style={{
                  width: `${widthPx}px`,
                  height: `${tracksHeightPx}px`
                }}
              >
                {/* Track horizontal separators */}
                {Array.from({ length: trackCount }).map((_, i) => (
                  <div
                    key={i}
                    className="absolute left-0 right-0 border-b border-zinc-800/50"
                    style={{
                      top: `${(i + 1) * TRACK_HEIGHT_PX}px`,
                      height: '0'
                    }}
                  />
                ))}

                {/* Major-tick vertical gridlines that extend through tracks
                    for visual continuity with the ruler. */}
                {(() => {
                  const stepSec = chooseRulerStepSec(pixelsPerSec)
                  const lines = []
                  for (let s = stepSec; s < totalSec; s += stepSec) {
                    lines.push(
                      <div
                        key={s}
                        className="absolute top-0 bottom-0 w-px bg-zinc-800/50 pointer-events-none"
                        style={{ left: `${s * pixelsPerSec}px` }}
                      />
                    )
                  }
                  return lines
                })()}

                {/* Blocks */}
                {/* Blocks rendered directly inside the tracks container
                    (no per-block wrapper).  The previous wrapper had
                    `left:0 right:0` which made every entry's invisible
                    wrapper span the entire track width — multiple entries
                    on the same track ended up stacked in DOM order with
                    the latest one intercepting all clicks on the track.
                    Each Block is now absolutely positioned with its own
                    explicit left/top/width so only the visible block
                    rectangle catches pointer events. */}
                {layout.placements.map(({ entry, trackIndex }) => {
                  const leftPx  = entry.startSec * pixelsPerSec
                  const widthBl = (entry.endSec - entry.startSec) * pixelsPerSec
                  const topPx   = trackIndex * TRACK_HEIGHT_PX + BLOCK_VERTICAL_PAD_PX
                  const w       = warningsMap.get(entry.id) ?? null
                  // Overflow tint suppressed in audio-only mode (matches the
                  // table — `overflowMap` is empty there).
                  const isOverflow = !isAudioOnly && (w?.overflow ?? false)
                  return (
                    <Block
                      key={entry.id}
                      entry={entry}
                      warnings={w}
                      leftPx={leftPx}
                      widthPx={widthBl}
                      topPx={topPx}
                      trackIndex={trackIndex}
                      isFocused={focusedRowId === entry.id}
                      isOverflow={isOverflow}
                      displayIndex={indexOfEntry.get(entry.id) ?? 0}
                      isInspectorOpen={openInspectorId === entry.id}
                      isDragging={draggingId === entry.id}
                      onSelect={handleSelectBlock}
                      onInspectorOpenChange={(open) =>
                        handleInspectorOpenChange(entry.id, open)
                      }
                      onAdjustTime={onAdjustTime}
                      onStartDrag={handleStartDrag}
                    />
                  )
                })}
              </div>

              {/* Snap guide — rendered BEFORE the playhead so the red
                  playhead always wins z-order when both happen to land
                  on the same column (snap-to-playhead case).  Colour
                  varies by snap kind so the user can read what they
                  snapped to:
                    playhead → red (matches the playhead colour)
                    edge     → green-400 (subtle accent)
                    grid     → zinc-400 (muted, since the grid is itself
                               a faint reference)
              */}
              {snapGuidePx !== null && (
                <div
                  aria-hidden
                  className="absolute top-0 pointer-events-none"
                  style={{
                    left: `${snapGuidePx}px`,
                    width: '1px',
                    height: `${RULER_HEIGHT_PX + tracksHeightPx}px`,
                    background:
                      snapGuideKind === 'playhead'
                        ? 'rgba(239, 68, 68, 0.7)'
                        : snapGuideKind === 'edge'
                          ? 'rgba(74, 222, 128, 0.9)'   // green-400
                          : 'rgba(161, 161, 170, 0.7)'  // zinc-400
                  }}
                />
              )}

              {/* Playhead — vertical red line spanning ruler + tracks.
                  Rendered last so it draws over blocks. */}
              {videoCurrentTimeSec >= 0 && (
                <div
                  aria-hidden
                  className="absolute top-0 pointer-events-none"
                  style={{
                    left: `${playheadXPx}px`,
                    width: '1px',
                    height: `${RULER_HEIGHT_PX + tracksHeightPx}px`,
                    background: 'rgb(239, 68, 68)' // red-500
                  }}
                >
                  {/* Top arrow head */}
                  <div
                    className="absolute -top-px -left-1.5 h-0 w-0"
                    style={{
                      borderLeft: '6px solid transparent',
                      borderRight: '6px solid transparent',
                      borderTop: '6px solid rgb(239, 68, 68)'
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
