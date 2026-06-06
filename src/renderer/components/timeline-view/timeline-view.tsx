import { memo, useMemo, useRef, useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ZoomIn, ZoomOut, Magnet, GanttChartSquare, Scissors, X,
  ChevronFirst, ChevronLast, ChevronLeft, ChevronRight
} from 'lucide-react'
import { toast } from 'sonner'
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
import { formatTimecode } from '@/lib/time'
import {
  layoutEntries,
  chooseRulerStepSec,
  formatRulerLabel,
  LAYOUT_MIN_BLOCK_SEC
} from '@/lib/timeline-layout'
import { type SnapResult } from '@/lib/timeline-snap'
import { computeDragPatch } from '@/lib/timeline-drag'
import {
  editedDuration,
  editedToOrig,
  origToEdited,
  type CutList
} from '../../../shared/cuts'
import {
  buildBoundarySet,
  findPrevBoundary,
  findNextBoundary
} from '@/lib/timeline-boundaries'
import type { EntryWarnings } from '@/lib/entry-warnings'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { TimelineBlockInspector } from './timeline-block-inspector'
import { bumpRenderCount } from '@/lib/perf-counter'
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
 * REQ-071 Phase 3.6: in-block timecodes lifted text-micro (10 px) → text-caption
 * (12 px) so the digits are actually readable.  Budget recomputed:
 *   - "00:00:06.92" = 11 chars × ~7.5 px (12-px mono tabular) ≈ 83 px each
 *   - 2 × 83 + ≥ 4-char visible gap (28 px at 12 px) + px-2 padding (16 px)
 *   - 83 + 83 + 28 + 16 ≈ 210 → rounded up to 220 px for subpixel headroom
 * The block-text row beneath (text-body-sm 13/leading-tight) sits on the
 * same 64-px BLOCK_HEIGHT_PX without change: caption 12 + body-sm 13 ×
 * leading-tight ≈ 12 + 16 = 28 px content, well inside 64.
 */
const TIME_ROW_MIN_BLOCK_WIDTH_PX = 220
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

function RulerImpl({ pixelsPerSec, totalSec, onSeek }: RulerProps) {
  bumpRenderCount('Ruler')
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
        {/* REQ-071 Phase 3.6: ruler labels lifted text-micro (10) ->
            text-caption (12) so the tick numbers (0:00, 0:02, ...) are
            actually readable.  chooseRulerStepSec keeps a ~100-px gap
            between ticks; a 12-px "0:00.0" label is ~45 px wide, so labels
            still don't collide at the densest sub-second zoom levels.  No
            change to chooseRulerStepSec was needed. */}
        <span className="absolute top-1 left-1 text-caption font-mono tabular-nums text-zinc-500 select-none">
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

/**
 * React.memo'd Ruler — same reasoning as `Block`: the parent re-renders on
 * every playhead tick, but Ruler's props (pixelsPerSec, totalSec, onSeek)
 * are stable as long as zoom and duration are stable.  REQ-071 Phase 3.9.
 */
const Ruler = memo(RulerImpl)

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
  /** Note the (id, open) signature — Block calls back with its own id so the
   *  parent does not need to bake a fresh closure per Block per render.  A
   *  closure-per-Block defeats React.memo's shallow prop compare and brings
   *  the playhead-tick stutter back. */
  onInspectorOpenChange: (id: string, open: boolean) => void
  onAdjustTime: (entryId: string) => void
  /** Start a drag (resize or move) — TimelineView attaches window listeners. */
  onStartDrag: (kind: DragKind, entry: SubtitleEntry, clientX: number) => void
}

function BlockImpl({
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
  bumpRenderCount('Block')
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
        onInspectorOpenChange(entry.id, open)
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
              'focus:outline-none focus-visible:outline-none',
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
              <div className="flex w-full items-baseline justify-between text-caption font-mono tabular-nums text-zinc-300/80 leading-none">
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
          onClose={() => onInspectorOpenChange(entry.id, false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * React.memo'd export of Block — the parent TimelineView re-renders on
 * every videoCurrentTimeSec tick (playback) and every timelinePixelsPerSec
 * tick (zoom drag); without memoization React reconciles all N blocks on
 * each of those renders even when block props haven't changed.  The
 * playhead case in particular has zero block-prop deltas, so memo cuts
 * those Block renders to zero.  REQ-071 Phase 3.9.
 */
const Block = memo(BlockImpl)

// ---------------------------------------------------------------------------
// Playhead — independent memo'd sub-component (REQ-094 case B)
// ---------------------------------------------------------------------------

interface PlayheadProps {
  /** Cuts list — needed to translate Original → Edited axis. */
  cuts: CutList
  /** Current zoom (px / sec). */
  pixelsPerSec: number
  /** Combined height of ruler + tracks, in pixels. */
  totalHeightPx: number
}

/**
 * REQ-094 case B — the playhead is the ONE piece of timeline JSX whose
 * position genuinely has to update every video tick.  Splitting it into
 * its own memo'd component that subscribes to `videoCurrentTimeSec`
 * directly lets TimelineView stop subscribing entirely.  The render
 * volume shifts from "TimelineView + every memo + every Block prop
 * recompare" per tick to "this tiny sub-tree" per tick.
 *
 * The wrapping `memo` guards against `cuts` / `pixelsPerSec` /
 * `totalHeightPx` props churning identity on unrelated re-renders;
 * the body subscribes to the playhead slice so only playhead-driven
 * updates land in this component.
 */
function PlayheadImpl({ cuts, pixelsPerSec, totalHeightPx }: PlayheadProps) {
  bumpRenderCount('Playhead')
  const videoCurrentTimeSec = useUiStore((s) => s.videoCurrentTimeSec)
  if (videoCurrentTimeSec < 0) return null
  const leftPx = origToEdited(videoCurrentTimeSec, cuts) * pixelsPerSec
  return (
    <div
      aria-hidden
      className="absolute top-0 pointer-events-none"
      style={{
        left: `${leftPx}px`,
        width: '1px',
        height: `${totalHeightPx}px`,
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
  )
}
const Playhead = memo(PlayheadImpl)

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
  bumpRenderCount('TimelineView')
  const { t } = useTranslation(['step2'])
  const entries = useProjectStore((s) => s.entries)
  const cuts = useProjectStore((s) => s.cuts)
  const addCut = useProjectStore((s) => s.addCut)
  const removeCut = useProjectStore((s) => s.removeCut)
  const pendingCutInSec = useUiStore((s) => s.pendingCutInSec)
  const pendingCutOutSec = useUiStore((s) => s.pendingCutOutSec)
  const setPendingCutIn = useUiStore((s) => s.setPendingCutIn)
  const setPendingCutOut = useUiStore((s) => s.setPendingCutOut)
  const clearPendingCut = useUiStore((s) => s.clearPendingCut)
  const tableFilter = useUiStore((s) => s.tableFilter)
  const focusedRowId = useUiStore((s) => s.focusedRowId)
  const setFocusedRowId = useUiStore((s) => s.setFocusedRowId)
  const setVideoSeekRequest = useUiStore((s) => s.setVideoSeekRequest)
  // REQ-094 case B: TimelineView no longer subscribes to
  // `videoCurrentTimeSec`.  The playhead lives in its own memo'd
  // sub-component (<Playhead>, defined above), which subscribes
  // internally and re-renders only itself per tick.  TimelineView's
  // remaining playhead-aware code reads `getState().videoCurrentTimeSec`
  // at the moment it is needed (drag, trim In/Out, auto-scroll), which
  // sidesteps subscription entirely.
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
    () => layoutEntries(visibleEntries, fallbackDurationSec, LAYOUT_MIN_BLOCK_SEC),
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
  // REQ-074 1c: ruler / playhead / blocks now live on the EDITED axis.
  // `editedTotalSec` is the visible timeline length after ripple cuts
  // (= originalDuration - Σ cut lengths).  When cuts is empty this equals
  // `totalSec` exactly, so the legacy non-trim behaviour is byte-identical.
  const editedTotalSec = useMemo(
    () => editedDuration(totalSec, cuts),
    [totalSec, cuts]
  )
  const widthPx    = editedTotalSec * pixelsPerSec
  const tracksHeightPx = trackCount * TRACK_HEIGHT_PX

  /**
   * Pre-computed Edited-axis position for each placed entry.
   * Computed ONCE per [layout.placements, cuts, pixelsPerSec] change, so a
   * playhead tick (which only updates `videoCurrentTimeSec`) does not
   * recompute origToEdited per Block — protects the REQ-071 Phase 3.9
   * `Block` re-render budget.
   *
   * When cuts is empty, origToEdited(t, []) === t, so the map collapses to
   * the legacy `entry.startSec * pixelsPerSec` values exactly.
   */
  const editedBlockPositions = useMemo(() => {
    const map = new Map<string, { leftPx: number; widthPx: number }>()
    for (const { entry } of layout.placements) {
      const leftEdited = origToEdited(entry.startSec, cuts)
      const rightEdited = origToEdited(entry.endSec, cuts)
      map.set(entry.id, {
        leftPx: leftEdited * pixelsPerSec,
        widthPx: (rightEdited - leftEdited) * pixelsPerSec,
      })
    }
    return map
  }, [layout.placements, cuts, pixelsPerSec])

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
  // on so a zoom change between pointerdown and pointerup is reflected
  // in the next pointermove tick.  REQ-094 case B: `videoCurrentTimeSec`
  // is read from `useUiStore.getState()` at applyDragPatch call time
  // (below) instead of being mirrored here, so TimelineView no longer
  // re-runs the `liveContextRef` updater effect on every playhead tick.
  const liveContextRef = useRef({
    pixelsPerSec,
    videoDurationSec,
    snapEnabled,
    entries
  })
  useEffect(() => {
    liveContextRef.current = {
      pixelsPerSec,
      videoDurationSec,
      snapEnabled,
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
        entries: liveEntries
      } = liveContextRef.current
      // REQ-094 case B: read playhead fresh at drag-tick time so that
      // TimelineView does not need to subscribe to videoCurrentTimeSec.
      const playhead = useUiStore.getState().videoCurrentTimeSec
      const dxPx = e.clientX - d.originClientX

      // REQ-085 #1: the previous inline snap / clamp / round pipeline was
      // declared "verified" in RES-084 §1.1 on the strength of the snap-
      // algorithm unit tests, but those tests covered the snap functions
      // in isolation — they never asserted the production wiring actually
      // ran them.  The owner reported snap "全く吸い付かず" both before and
      // after REQ-084's 6 → 12 px threshold bump, which proved the bug was
      // not the threshold.  Extracting the whole patch computation into
      // `computeDragPatch` lets the 10 tests in
      // `tests/unit/timeline-drag.test.ts` drive the EXACT same code path
      // production uses, and prevents future "tests-pass-but-production-
      // breaks" regressions in this lane.
      const result = computeDragPatch({
        snapshot: d.snapshot,
        kind: d.kind,
        dxPx,
        pps,
        dur,
        minBlockSec: MIN_BLOCK_SEC,
        snapEnabled,
        playhead,
        liveEntries,
        draggingEntryId: d.entryId,
      })
      if (result === null) return  // sub-3 px move noop

      // Visual snap guide — 1 px vertical line at the snap target's
      // pixel position.  Cleared when no snap was applied.
      setSnapGuidePx(result.guideTimeSec !== null ? result.guideTimeSec * pps : null)
      setSnapGuideKind(result.guideKind)

      // Build the minimal patch — different kinds touch different
      // fields to keep history pushes meaningful (a resize-end
      // shouldn't claim it touched startSec).
      let patch: Partial<SubtitleEntry>
      if (d.kind === 'resize-start') {
        patch = { startSec: result.startSec, isEdited: true }
      } else if (d.kind === 'resize-end') {
        patch = { endSec: result.endSec, isEdited: true }
      } else {
        patch = { startSec: result.startSec, endSec: result.endSec, isEdited: true }
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

  // REQ-071 Phase 3.9: signature is (id, open) so the parent can pass a
  // SINGLE stable callback to every Block (rather than baking a
  // `(open) => handleInspectorOpenChange(entry.id, open)` closure per row
  // per render — that defeated React.memo's prop compare and brought back
  // the all-blocks-re-render-on-playhead-tick stutter).
  const handleInspectorOpenChange = useCallback((id: string, open: boolean) => {
    // Guard the close path so a stale event (e.g. another block opened in
    // the meantime) does not unintentionally clobber the current owner.
    if (open) setOpenInspectorId(id)
    else setOpenInspectorId((prev) => (prev === id ? null : prev))
  }, [])

  /**
   * REQ-074 1c: Ruler scrub + tracks background click + nav buttons all
   * deliver an EDITED-axis time.  `<video>.currentTime` (and therefore
   * `videoSeekRequestSec`) is the ORIGINAL axis, so translate via
   * `editedToOrig` before forwarding.  Boundary convention (post-cut
   * side) is baked into `editedToOrig` itself.
   *
   * REQ-079 #1: no upper-side clamp.  The earlier `SCRUB_END_EPS_SEC`
   * margin was an attempt to keep currentTime < duration so the 'ended'
   * event would not fire and warp the playhead to 0.  With the warp
   * now removed (see VideoPreviewPanel.handleEnded), reaching exactly
   * duration just leaves the playhead at the right edge — exactly the
   * desired behaviour for ⏭ / right-end scrub.  Negative inputs are
   * still pinned to 0 to keep `editedToOrig` in its valid domain.
   */
  const handleSeek = useCallback((editedSec: number) => {
    setVideoSeekRequest(editedToOrig(Math.max(0, editedSec), cuts))
  }, [setVideoSeekRequest, cuts])

  /**
   * REQ-077 #4: four playhead navigation buttons.  All four read live
   * project + ui state via `getState()` so the callback identity stays
   * constant across renders — playhead ticks (which re-render
   * TimelineView 50× during the perf e2e) must NOT invalidate these
   * callbacks, otherwise Block's React.memo would shake loose.
   */
  const handleNavFirst = useCallback(() => {
    handleSeek(0)
  }, [handleSeek])
  const handleNavLast = useCallback(() => {
    handleSeek(editedTotalSec)
  }, [handleSeek, editedTotalSec])
  const handleNavPrev = useCallback(() => {
    const liveCuts = useProjectStore.getState().cuts
    const liveEntries = useProjectStore.getState().entries
    const livePlayhead = origToEdited(
      useUiStore.getState().videoCurrentTimeSec,
      liveCuts
    )
    const boundaries = buildBoundarySet(liveEntries, liveCuts)
    const prev = findPrevBoundary(livePlayhead, boundaries)
    handleSeek(prev !== null ? prev : 0)
  }, [handleSeek])
  const handleNavNext = useCallback(() => {
    const liveCuts = useProjectStore.getState().cuts
    const liveEntries = useProjectStore.getState().entries
    const livePlayhead = origToEdited(
      useUiStore.getState().videoCurrentTimeSec,
      liveCuts
    )
    const boundaries = buildBoundarySet(liveEntries, liveCuts)
    const next = findNextBoundary(livePlayhead, boundaries)
    handleSeek(next !== null ? next : editedTotalSec)
  }, [handleSeek, editedTotalSec])

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

  // REQ-094 case E: zoom slider RAF throttle.  Native <input
  // type="range"> dispatches one `input` event per pointermove
  // sample, which on a high-precision pointer can exceed the
  // display refresh rate.  Each event committed straight to the
  // store would trigger a TimelineView + Ruler + 11×Block render
  // (the existing perf-counter Scenario A measurement); coalescing
  // multiple events that arrive within the same frame into one
  // setPixelsPerSec call caps the render volume at the frame rate.
  //
  // Buttons + programmatic store writes are unaffected because
  // they bypass the slider handler.  The slider remains a
  // CONTROLLED input (`value={pixelsPerSec}`) so the thumb still
  // tracks the committed value — but commits happen at most once
  // per rAF, so the thumb advances in frame-aligned steps instead
  // of one step per input event.
  const sliderRafIdRef = useRef<number | null>(null)
  const sliderPendingValueRef = useRef<number | null>(null)
  function handleSliderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = Number(e.target.value)
    sliderPendingValueRef.current = next
    bumpRenderCount('PpsSliderInput')
    if (sliderRafIdRef.current !== null) return
    sliderRafIdRef.current = requestAnimationFrame(() => {
      sliderRafIdRef.current = null
      const v = sliderPendingValueRef.current
      sliderPendingValueRef.current = null
      if (v !== null) {
        bumpRenderCount('PpsSliderCommit')
        setPixelsPerSec(v)
      }
    })
  }
  // Cancel any pending rAF on unmount to avoid a stray commit firing
  // against a torn-down React tree.
  useEffect(() => {
    return () => {
      if (sliderRafIdRef.current !== null) {
        cancelAnimationFrame(sliderRafIdRef.current)
        sliderRafIdRef.current = null
      }
    }
  }, [])

  // REQ-074 1e: trim controls.  In / Out / Confirm derive from the
  // current playhead (Original axis) so the operation model is
  // identical to NLE "set in / set out / extract".  History pushes
  // happen on confirm only — pending In / Out are not undoable.
  //
  // REQ-075 #3: each set-point button TOGGLES — pressing 始点 again
  // when it is already set clears that point.  Lets the user retract a
  // single end without nuking the other one (the Clear-all X stays for
  // wiping both at once when both are set).
  //
  // REQ-076 #2: set-time validation.  When the OTHER point is already
  // set, reject the proposed value with a toast if it lands at the
  // same position or on the wrong side.  Keeps the user out of states
  // the confirm button could not act on (and replaces the silent
  // disabled-confirm-without-reason UX).
  // REQ-094 case B: `videoCurrentTimeSec` is read from `getState()`
  // at click time rather than closed over from a TimelineView-level
  // subscription.  That keeps both these callbacks' identities stable
  // across playhead ticks (deps no longer mention the playhead) AND
  // removes the reason for TimelineView to re-render on every tick.
  // The click reads the same store value the subscription would have
  // surfaced, so semantics are unchanged.
  const handleSetIn = useCallback(() => {
    if (pendingCutInSec !== null) {
      // Toggle off — clearing is always safe.
      setPendingCutIn(null)
      return
    }
    const candidate = useUiStore.getState().videoCurrentTimeSec
    if (pendingCutOutSec !== null) {
      if (candidate === pendingCutOutSec) {
        toast.error(t('timeline.trim.errorSamePosition'))
        return
      }
      if (candidate > pendingCutOutSec) {
        toast.error(t('timeline.trim.errorInAfterOut'))
        return
      }
    }
    setPendingCutIn(candidate)
  }, [pendingCutInSec, pendingCutOutSec, setPendingCutIn, t])
  const handleSetOut = useCallback(() => {
    if (pendingCutOutSec !== null) {
      setPendingCutOut(null)
      return
    }
    const candidate = useUiStore.getState().videoCurrentTimeSec
    if (pendingCutInSec !== null) {
      if (candidate === pendingCutInSec) {
        toast.error(t('timeline.trim.errorSamePosition'))
        return
      }
      if (candidate < pendingCutInSec) {
        toast.error(t('timeline.trim.errorOutBeforeIn'))
        return
      }
    }
    setPendingCutOut(candidate)
  }, [pendingCutInSec, pendingCutOutSec, setPendingCutOut, t])
  const handleConfirmCut = useCallback(() => {
    if (pendingCutInSec === null || pendingCutOutSec === null) return
    if (!(pendingCutInSec < pendingCutOutSec)) {
      toast.error(t('timeline.trim.invalidRange'))
      return
    }
    const newCut = {
      startSec: pendingCutInSec,
      endSec: pendingCutOutSec,
      id: (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? crypto.randomUUID()
        : `cut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    }
    const snapshotBefore = useProjectStore.getState().cuts
    addCut(newCut)
    const snapshotAfter = useProjectStore.getState().cuts
    useHistoryStore.getState().push({
      label: t('timeline.trim.confirmCut'),
      undo: () => useProjectStore.getState().setCuts(snapshotBefore),
      redo: () => useProjectStore.getState().setCuts(snapshotAfter)
    })
    clearPendingCut()
  }, [pendingCutInSec, pendingCutOutSec, addCut, clearPendingCut, t])
  const handleRemoveCut = useCallback((id: string) => {
    const snapshotBefore = useProjectStore.getState().cuts
    removeCut(id)
    const snapshotAfter = useProjectStore.getState().cuts
    useHistoryStore.getState().push({
      label: t('timeline.trim.confirmCut'),
      undo: () => useProjectStore.getState().setCuts(snapshotBefore),
      redo: () => useProjectStore.getState().setCuts(snapshotAfter)
    })
  }, [removeCut, t])

  // Keep the playhead in view while playing.  Phase 1: simple "if playhead
  // leaves the viewport, scroll it back to one third".  Phase 6 can refine.
  //
  // REQ-094 case B: subscribe to `videoCurrentTimeSec` directly via
  // `useUiStore.subscribe` instead of `useUiStore(selector)`.  The
  // selector-form would re-render TimelineView on every playhead tick,
  // which is the exact problem case B set out to fix.  The
  // `subscribe`-form fires the side-effect (compare & possibly scroll)
  // without touching React's render cycle.  The effect's deps capture
  // `pixelsPerSec` and `cuts` so the subscription rebuilds with fresh
  // closure values when zoom or cuts change.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function maybeScrollPlayheadIntoView(playhead: number): void {
      const el = scrollRef.current
      if (!el) return
      // Playhead lives on the EDITED axis here (videoCurrentTimeSec is
      // the <video>.currentTime = Original; translate for the visual
      // position).  Empty cuts → identity.
      const playheadEditedSec = origToEdited(playhead, cuts)
      const playheadXPx = playheadEditedSec * pixelsPerSec + TRACK_GUTTER_LEFT_PX
      const visibleLeft  = el.scrollLeft
      const visibleRight = visibleLeft + el.clientWidth
      if (playheadXPx < visibleLeft || playheadXPx > visibleRight - 24) {
        const target = playheadXPx - el.clientWidth / 3
        el.scrollLeft = Math.max(0, target)
      }
    }
    // Run once with the current value so a zoom/cuts change re-aligns
    // the playhead even without the user playing.
    maybeScrollPlayheadIntoView(useUiStore.getState().videoCurrentTimeSec)
    // Subscribe to videoCurrentTimeSec changes (no re-render of
    // TimelineView).  The callback receives the FULL state; we
    // hand-pick the slice and bail when it didn't change.
    let prev = useUiStore.getState().videoCurrentTimeSec
    return useUiStore.subscribe((state) => {
      const next = state.videoCurrentTimeSec
      if (next === prev) return
      prev = next
      maybeScrollPlayheadIntoView(next)
    })
  }, [pixelsPerSec, cuts])

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
      // Block's Edited-axis position — entry.startSec is Original.
      const blockEditedStartSec = origToEdited(entry.startSec, cuts)
      const blockX = blockEditedStartSec * pixelsPerSec + TRACK_GUTTER_LEFT_PX
      el.scrollLeft = Math.max(0, blockX - el.clientWidth / 2)
      setScrollToRowId(null)
    }, 80)
    return () => clearTimeout(timer)
  }, [scrollToRowId, pixelsPerSec, setScrollToRowId, cuts])

  // Wheel handling on the timeline scroll container:
  //   - Ctrl+wheel    → preventDefault.  Suppresses Chromium's built-in
  //                     page-zoom (REQ-083 #2) without doing anything else.
  //   - plain wheel   → REQ-084 #3.  Route deltaY explicitly to scrollTop
  //                     so multi-track timelines scroll vertically with
  //                     the wheel.  Without this override Chromium's
  //                     scroll-chaining fallback can route deltaY to
  //                     scrollLeft (= horizontal scroll) when the
  //                     container is wider than tall, which is the
  //                     timeline's default geometry — the user wanted
  //                     wheel = vertical even then.  Horizontal scroll
  //                     stays on the bottom scrollbar (and trackpad
  //                     deltaX is left alone).
  //
  // `passive: false` is required so `preventDefault()` actually fires;
  // React's onWheel prop attaches with `passive: true` which silently
  // ignores the cancel.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    function onWheel(e: WheelEvent) {
      if (!el) return
      if (e.ctrlKey) {
        e.preventDefault()
        return
      }
      // Plain wheel with a vertical component → force vertical scroll.
      // Skip when there is no vertical overflow (single-track timelines
      // fit in the viewport, in which case there's nothing to scroll
      // and the browser default is fine).
      if (e.deltaY !== 0 && el.scrollHeight > el.clientHeight) {
        el.scrollTop += e.deltaY
        e.preventDefault()
      }
      // deltaX (trackpad horizontal swipe) → leave to browser default
      // so horizontal trackpad scrolling continues to work.
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // REQ-094 case B: the playhead position is computed inside the
  // <Playhead> sub-component (which owns the videoCurrentTimeSec
  // subscription).  TimelineView no longer recomputes
  // `playheadXPx` here, so playhead-driven re-renders stop at the
  // sub-component boundary.

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
              from the store, so the slider stays in sync if some other
              caller mutates the zoom (currently only the [−] / [+] buttons). */}
          <input
            type="range"
            min={TIMELINE_PPS_MIN}
            max={TIMELINE_PPS_MAX}
            step={1}
            value={pixelsPerSec}
            onChange={handleSliderChange}
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
              w-[64px] → w-[72px] to absorb the slightly wider 13-px digits.
              Phase 3.5: bumped 13 → body (15) so the readout — which IS the
              value the user reads off the toolbar — stops sitting one tier
              below the body text on the rest of the screen.  w-[72px] →
              w-[84px] for the wider 15-px tabular digits ("130 px/秒" was
              previously ~70px, now ~80px). */}
          <span className="font-mono tabular-nums text-body text-zinc-500 select-none w-[84px] text-center">
            {t('timeline.toolbar.zoomLevel', { pps: pixelsPerSec })}
          </span>
        </div>

          {/* REQ-078 #2 — toolbar even-spacing.  Lifted the playhead-nav
              cluster, the trim cluster, and the snap toggle out of their
              former wrapping <div className="flex gap-3">; with
              `justify-between` on the toolbar itself, the four top-level
              children (zoom on the left, nav, trim, snap) now distribute
              evenly across the row — zoom hugs the left edge, snap hugs
              the right, and nav + trim sit at evenly spaced points in
              between.  Nothing else moved. */}
          {/* REQ-077 #4 — playhead navigation cluster.
              [先頭へ] [前境界へ] [次境界へ] [末尾へ] */}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={handleNavFirst}
              title={t('timeline.nav.first')}
              aria-label={t('timeline.nav.first')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md text-zinc-400',
                'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150'
              )}
            >
              <ChevronFirst className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNavPrev}
              title={t('timeline.nav.prevBoundary')}
              aria-label={t('timeline.nav.prevBoundary')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md text-zinc-400',
                'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150'
              )}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNavNext}
              title={t('timeline.nav.nextBoundary')}
              aria-label={t('timeline.nav.nextBoundary')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md text-zinc-400',
                'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150'
              )}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={handleNavLast}
              title={t('timeline.nav.last')}
              aria-label={t('timeline.nav.last')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md text-zinc-400',
                'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150'
              )}
            >
              <ChevronLast className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* REQ-077 #1 — trim toolbar.
              The REQ-076 legend-style label (absolute on the top border)
              bloated the toolbar vertically and conflicted with REQ-075's
              vertical-budget goals.  Reverted to an inline left-anchored
              label inside the bordered group, py-0.5 so the outer height
              matches the other h-7 toolbar segments (zoom buttons, snap
              toggle).  The label stays on the LEFT inside the box per
              the user's "枠の左側に来ること" requirement. */}
          <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 px-2 py-0.5">
            <span className="text-label font-medium uppercase tracking-wider text-zinc-500 select-none">
              {t('timeline.trim.toolbarLabel')}
            </span>
            {/* REQ-080 #2 — 始点 / 終点 / カット: always look like
                buttons (base bg + border).  No "−" placeholder when
                unset — the time chip simply doesn't render until the
                point is captured.  Set state amber-tints the background
                AND the border so the "pressed" affordance reads at a
                glance. */}
            <button
              type="button"
              onClick={handleSetIn}
              title={t('timeline.trim.setInTooltip')}
              aria-pressed={pendingCutInSec !== null}
              className={cn(
                'flex h-7 items-center gap-1.5 px-2.5 rounded-md text-body-sm font-medium',
                'border transition-colors duration-150',
                pendingCutInSec !== null
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
                  : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600 hover:text-zinc-100'
              )}
            >
              <span>{t('timeline.trim.setIn')}</span>
              {pendingCutInSec !== null && (
                <span className="font-mono tabular-nums text-caption text-amber-300/80">
                  {formatTimecode(pendingCutInSec)}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleSetOut}
              title={t('timeline.trim.setOutTooltip')}
              aria-pressed={pendingCutOutSec !== null}
              className={cn(
                'flex h-7 items-center gap-1.5 px-2.5 rounded-md text-body-sm font-medium',
                'border transition-colors duration-150',
                pendingCutOutSec !== null
                  ? 'bg-amber-500/15 text-amber-300 border-amber-500/40 hover:bg-amber-500/25'
                  : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:bg-zinc-700 hover:border-zinc-600 hover:text-zinc-100'
              )}
            >
              <span>{t('timeline.trim.setOut')}</span>
              {pendingCutOutSec !== null && (
                <span className="font-mono tabular-nums text-caption text-amber-300/80">
                  {formatTimecode(pendingCutOutSec)}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleConfirmCut}
              disabled={
                pendingCutInSec === null ||
                pendingCutOutSec === null ||
                !(pendingCutInSec < pendingCutOutSec)
              }
              title={t('timeline.trim.confirmCutTooltip')}
              className={cn(
                'flex h-7 items-center px-3 rounded-md text-body-sm font-semibold',
                'border transition-colors duration-150',
                // 3.8 invariant: green-button text MUST be zinc-950
                // (rgb(9,9,11)) on green-500 (rgb(34,197,94)).  Verified
                // by green-button-color.spec.ts; the styling here keeps
                // that pairing across every state.
                'bg-green-500 text-zinc-950 border-green-400 hover:bg-green-400',
                'disabled:bg-zinc-800 disabled:text-zinc-500 disabled:border-zinc-700 disabled:hover:bg-zinc-800 disabled:cursor-not-allowed'
              )}
            >
              {t('timeline.trim.confirmCut')}
            </button>
            {pendingCutInSec !== null && pendingCutOutSec !== null && (
              <button
                type="button"
                onClick={clearPendingCut}
                title={t('timeline.trim.clearPendingTooltip')}
                className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors duration-150"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Snap toggle — unchanged, kept after the trim cluster so its
              location relative to the right edge of the toolbar stays
              consistent across sessions. */}
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
                  <span className="text-caption font-mono text-zinc-500 select-none">
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
                totalSec={editedTotalSec}
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
                    for visual continuity with the ruler.  Edited axis. */}
                {(() => {
                  const stepSec = chooseRulerStepSec(pixelsPerSec)
                  const lines = []
                  for (let s = stepSec; s < editedTotalSec; s += stepSec) {
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
                  // REQ-074 1c: read pre-computed Edited-axis position
                  // (origToEdited * pps).  Empty cuts → identical to the
                  // legacy `entry.startSec * pixelsPerSec` calculation.
                  const pos = editedBlockPositions.get(entry.id)
                  const leftPx  = pos?.leftPx ?? entry.startSec * pixelsPerSec
                  const widthBl = pos?.widthPx ?? (entry.endSec - entry.startSec) * pixelsPerSec
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
                      onInspectorOpenChange={handleInspectorOpenChange}
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

              {/* REQ-074 1e — confirmed cuts.  Each cut collapses to a
                  single Edited-axis point (its frames are gone from the
                  concat output), so we render it as a thin vertical
                  scissors marker on top of the ruler + tracks.  Clicking
                  removes the cut (with undo via useHistoryStore). */}
              {cuts.map((c) => {
                const xPx = origToEdited(c.startSec, cuts) * pixelsPerSec
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => handleRemoveCut(c.id)}
                    title={t('timeline.trim.cutMarkerTitle', {
                      start: formatTimecode(c.startSec),
                      end: formatTimecode(c.endSec)
                    })}
                    className="absolute top-0 z-20 flex flex-col items-center pointer-events-auto"
                    style={{
                      left: `${xPx - 7}px`,
                      width: '14px',
                      height: `${RULER_HEIGHT_PX + tracksHeightPx}px`
                    }}
                  >
                    <div className="flex h-4 w-4 items-center justify-center rounded-sm bg-zinc-800 text-amber-300 hover:bg-amber-500/30 hover:text-amber-100 transition-colors duration-150">
                      <Scissors className="h-3 w-3" />
                    </div>
                    <div
                      className="w-px bg-amber-400/60 pointer-events-none"
                      style={{ height: `${RULER_HEIGHT_PX + tracksHeightPx - 16}px` }}
                    />
                  </button>
                )
              })}

              {/* REQ-074 1e — pending In/Out ghosts.  Drawn at the Edited
                  positions of the captured Original times so the user can
                  see what they're about to cut.  A semi-transparent band
                  spans between them when both are set and valid. */}
              {pendingCutInSec !== null && pendingCutOutSec !== null &&
                pendingCutInSec < pendingCutOutSec && (
                  <div
                    aria-hidden
                    className="absolute top-0 pointer-events-none"
                    style={{
                      left: `${origToEdited(pendingCutInSec, cuts) * pixelsPerSec}px`,
                      width: `${
                        (origToEdited(pendingCutOutSec, cuts) -
                          origToEdited(pendingCutInSec, cuts)) *
                        pixelsPerSec
                      }px`,
                      height: `${RULER_HEIGHT_PX + tracksHeightPx}px`,
                      background: 'rgba(245, 158, 11, 0.15)' // amber-500/15
                    }}
                  />
                )}
              {pendingCutInSec !== null && (
                <div
                  aria-hidden
                  className="absolute top-0 pointer-events-none"
                  style={{
                    left: `${origToEdited(pendingCutInSec, cuts) * pixelsPerSec}px`,
                    width: '1px',
                    height: `${RULER_HEIGHT_PX + tracksHeightPx}px`,
                    background: 'rgba(245, 158, 11, 0.9)' // amber-500
                  }}
                />
              )}
              {pendingCutOutSec !== null && (
                <div
                  aria-hidden
                  className="absolute top-0 pointer-events-none"
                  style={{
                    left: `${origToEdited(pendingCutOutSec, cuts) * pixelsPerSec}px`,
                    width: '1px',
                    height: `${RULER_HEIGHT_PX + tracksHeightPx}px`,
                    background: 'rgba(245, 158, 11, 0.9)'
                  }}
                />
              )}

              {/* REQ-094 case B: playhead is an independent memo'd
                  sub-component.  It subscribes to videoCurrentTimeSec
                  internally so TimelineView's own subscription can be
                  dropped — only this small subtree re-renders on
                  every tick. */}
              <Playhead
                cuts={cuts}
                pixelsPerSec={pixelsPerSec}
                totalHeightPx={RULER_HEIGHT_PX + tracksHeightPx}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
