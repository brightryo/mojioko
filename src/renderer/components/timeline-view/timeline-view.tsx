import { useMemo, useRef, useEffect, useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ZoomIn, ZoomOut, Magnet, GanttChartSquare } from 'lucide-react'
import { useProjectStore } from '@/stores/project-store'
import {
  useUiStore,
  TIMELINE_PPS_MIN,
  TIMELINE_PPS_MAX
} from '@/stores/ui-store'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { cn } from '@/lib/utils'
import { filterEntries } from '@/lib/subtitle-filter'
import {
  layoutEntries,
  chooseRulerStepSec,
  formatRulerLabel
} from '@/lib/timeline-layout'
import type { EntryWarnings } from '@/lib/entry-warnings'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { TimelineBlockInspector } from './timeline-block-inspector'

// ---------------------------------------------------------------------------
// Layout constants (pixels)
// ---------------------------------------------------------------------------

const RULER_HEIGHT_PX        = 28
const TRACK_HEIGHT_PX        = 44
const BLOCK_HEIGHT_PX        = 32
const BLOCK_VERTICAL_PAD_PX  = (TRACK_HEIGHT_PX - BLOCK_HEIGHT_PX) / 2
const TRACK_GUTTER_LEFT_PX   = 56   // left gutter for track labels (T0, T1, …)
const ZOOM_STEP_PX           = 10

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface RulerProps {
  pixelsPerSec: number
  totalSec: number
  /** Click on ruler → seek video to that time. */
  onSeek: (sec: number) => void
}

function Ruler({ pixelsPerSec, totalSec, onSeek }: RulerProps) {
  const stepSec = chooseRulerStepSec(pixelsPerSec)
  const tickCount = Math.ceil(totalSec / stepSec) + 1
  const widthPx = totalSec * pixelsPerSec

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    const xPx = e.clientX - rect.left
    onSeek(Math.max(0, xPx / pixelsPerSec))
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
      onClick={handleClick}
      className="relative cursor-pointer bg-zinc-900 border-b border-zinc-800"
      style={{ width: `${widthPx}px`, height: `${RULER_HEIGHT_PX}px` }}
    >
      {ticks}
    </div>
  )
}

interface BlockProps {
  entry: import('../../../shared/types').SubtitleEntry
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
  /** Click handler — focus the row + seek the video + open the inspector. */
  onSelect: (id: string, startSec: number) => void
  onInspectorOpenChange: (open: boolean) => void
  onAdjustTime: (entryId: string) => void
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
  onSelect,
  onInspectorOpenChange,
  onAdjustTime
}: BlockProps) {
  const { t } = useTranslation(['step2'])
  // Visual aria-label uses the 1-based display index from the parent (table-
  // order N) plus track index for accessibility.
  const ariaLabel = t('timeline.block.ariaLabel', {
    track: trackIndex,
    index: displayIndex
  })

  // Display text — strip ASS \N line breaks; line-clamp keeps it on one row.
  const displayText = entry.text.replace(/\\N/g, ' ').trim()

  return (
    <Popover open={isInspectorOpen} onOpenChange={onInspectorOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(entry.id, entry.startSec)
          }}
          title={displayText}
          className={cn(
            'absolute flex items-center px-2 rounded-md text-left text-[12px] leading-none',
            'transition-colors duration-150 truncate select-none overflow-hidden',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40',
            // Base palette — light zinc with a small inset shadow so adjacent
            // blocks read as separate units even when they touch.
            'bg-zinc-700/70 text-zinc-100 border border-zinc-600/70',
            'hover:bg-zinc-700 hover:border-zinc-500',
            // State tints — keep them additive (focus wins for border, semantic
            // tints add bg overlays).  Mirrors subtitle-table row palette.
            entry.isEdited && !entry.isDeleted && 'bg-amber-400/15 border-amber-400/40 hover:bg-amber-400/25',
            isOverflow && !entry.isDeleted && 'bg-red-500/15 border-red-500/40 hover:bg-red-500/25',
            isFocused && 'ring-2 ring-green-500 border-green-500 bg-green-500/15 text-zinc-50',
            entry.isDeleted && 'opacity-40 line-through'
          )}
          style={{
            left: `${leftPx}px`,
            // Floor width to 2 px so 0-duration entries are still clickable.
            width: `${Math.max(2, widthPx)}px`,
            height: `${BLOCK_HEIGHT_PX}px`,
            top: `${topPx}px`
          }}
        >
          <span className="truncate">{displayText || '·'}</span>
        </button>
      </PopoverTrigger>
      {/* `side="top"` by default; Radix collision detection flips to bottom
          near the viewport top edge.  align="start" keeps the popover's left
          edge near the block's left edge — feels rooted to the timestamp
          rather than floating in the middle. */}
      <PopoverContent side="top" align="start" sideOffset={8} className="p-3">
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
          <span className="font-mono tabular-nums text-[11px] text-zinc-500 select-none w-[64px] text-center">
            {t('timeline.toolbar.zoomLevel', { pps: pixelsPerSec })}
          </span>
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
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[11px] text-zinc-500 flex items-center gap-1.5 select-none">
            <GanttChartSquare className="h-3 w-3" />
            {t('timeline.toolbar.trackCount', { count: trackCount })}
          </span>
          {/* Snap toggle — disabled-looking in Phase 1 (algorithm lands in Phase 5)
              but the flag is wired so behaviour change won't need a new UI later. */}
          <button
            type="button"
            onClick={() => setSnapEnabled(!snapEnabled)}
            title={t('timeline.toolbar.snapHelp')}
            className={cn(
              'flex h-7 items-center gap-1.5 px-2 rounded-md text-[11px] font-medium',
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
            <p className="text-[13px] font-medium">
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
                  <span className="text-[10px] font-mono text-zinc-500 select-none">
                    {t('timeline.trackLabel', { index: i })}
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
                      onSelect={handleSelectBlock}
                      onInspectorOpenChange={(open) =>
                        handleInspectorOpenChange(entry.id, open)
                      }
                      onAdjustTime={onAdjustTime}
                    />
                  )
                })}
              </div>

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
