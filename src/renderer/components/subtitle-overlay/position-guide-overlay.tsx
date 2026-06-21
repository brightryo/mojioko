import { useLayoutEffect, useState } from 'react'
import { getAnchorAssPosition } from '@/lib/preview-coords'
import type { SubtitleEntry } from '../../../shared/types'

/**
 * REQ-20260615-038 C — OBS-style position guide overlay.
 *
 * Sibling of `SubtitleOverlay` inside the video container, rendered for the
 * inspector-selected row and for the row that is currently being dragged.
 * Measures the rendered overlay span (passed in as `targetEl`) and draws:
 *
 *   1. A thin bounding box around the text.
 *   2. Four distance "rulers" from the bbox edges to the four frame edges,
 *      each labeled in **OUTPUT pixels** (= ASS pixels, same coord space as
 *      the burn-in writer) so the user sees the numbers that will land in
 *      the rendered video.
 *   3. An "X: ±n  Y: ±n" badge near the top-left of the bbox showing the
 *      current visible offset against the alignment-based anchor.
 *
 * Pure display.  No pointer events, no state writes — the parent's drag
 * handlers stay in charge of mutating posX/posY.
 */
export interface PositionGuideOverlayProps {
  entry: SubtitleEntry
  /** The rendered `<SubtitleOverlay>` span we are guiding around. */
  targetEl: HTMLSpanElement | null
  /** The `videoContainerRef` element — coordinate frame for the guide. */
  containerEl: HTMLDivElement | null
  /** Native video width / height (= ASS PlayResX/Y, = output pixels). */
  videoWidthPx: number
  videoHeightPx: number
  /** Container (= preview frame) width in CSS pixels. */
  containerWidthPx: number
  /** Container (= preview frame) height in CSS pixels. */
  containerHeightPx: number
}

interface MeasuredRect {
  /** Container-relative top/left/right/bottom in CSS pixels. */
  top: number
  left: number
  right: number
  bottom: number
  width: number
  height: number
}

function measure(target: HTMLSpanElement, container: HTMLDivElement): MeasuredRect {
  const t = target.getBoundingClientRect()
  const c = container.getBoundingClientRect()
  return {
    top: t.top - c.top,
    left: t.left - c.left,
    right: t.right - c.left,
    bottom: t.bottom - c.top,
    width: t.width,
    height: t.height,
  }
}

export function PositionGuideOverlay({
  entry,
  targetEl,
  containerEl,
  videoWidthPx,
  videoHeightPx,
  containerWidthPx,
  containerHeightPx,
}: PositionGuideOverlayProps) {
  const [rect, setRect] = useState<MeasuredRect | null>(null)
  // Re-measure after every commit so the guide tracks pos / size changes
  // during drag without needing its own observer for every kind of mutation.
  // useLayoutEffect (not effect) so the measurement lands before the next
  // paint, avoiding a single-frame flash where the bbox is one drag delta
  // behind the text.  The equality short-circuit inside `setRect` is what
  // prevents the "no-deps + setState" loop the linter warns about: when
  // the measured rect is unchanged we return `prev` and React skips the
  // re-render, so we never re-enter the effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!targetEl || !containerEl) {
      setRect(null)
      return
    }
    const next = measure(targetEl, containerEl)
    setRect((prev) => {
      if (
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.right === next.right &&
        prev.bottom === next.bottom
      ) {
        return prev
      }
      return next
    })
  })
  // Also resize-observe both elements so font load / pane resize that
  // doesn't re-render the parent still updates the guide.
  useLayoutEffect(() => {
    if (!targetEl || !containerEl) return
    const update = () => setRect(measure(targetEl, containerEl))
    const ro = new ResizeObserver(update)
    ro.observe(targetEl)
    ro.observe(containerEl)
    return () => ro.disconnect()
  }, [targetEl, containerEl])

  if (
    !rect ||
    containerWidthPx <= 0 ||
    containerHeightPx <= 0 ||
    videoWidthPx <= 0 ||
    videoHeightPx <= 0
  ) {
    return null
  }
  const scale = containerWidthPx / videoWidthPx
  const toOutputPx = (cssPx: number) => Math.max(0, Math.round(cssPx / scale))

  const dTop = rect.top
  const dLeft = rect.left
  const dRight = containerWidthPx - rect.right
  const dBottom = containerHeightPx - rect.bottom

  const anchor = getAnchorAssPosition(
    entry.horizontalPosition,
    entry.verticalPosition,
    entry.verticalMarginPx,
    videoWidthPx,
    videoHeightPx,
  )
  const isPinned = entry.posX !== undefined && entry.posY !== undefined
  const offsetX = isPinned ? Math.round((entry.posX as number) - anchor.x) : 0
  const offsetY = isPinned ? Math.round((entry.posY as number) - anchor.y) : 0

  const guideLineColor = 'rgba(34, 197, 94, 0.85)'
  const guideBoxColor = 'rgba(34, 197, 94, 0.85)'
  const labelStyle: React.CSSProperties = {
    position: 'absolute',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    lineHeight: 1,
    padding: '2px 4px',
    borderRadius: '3px',
    color: '#ffffff',
    background: 'rgba(15, 23, 42, 0.85)',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  }

  return (
    <div
      aria-hidden="true"
      className="absolute inset-0 pointer-events-none select-none"
    >
      {/* Bbox border */}
      <div
        style={{
          position: 'absolute',
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
          border: `1px solid ${guideBoxColor}`,
          borderRadius: '1px',
        }}
      />
      {/* Top ruler */}
      <div
        style={{
          position: 'absolute',
          left: `${rect.left + rect.width / 2}px`,
          top: 0,
          width: '1px',
          height: `${Math.max(0, dTop)}px`,
          background: guideLineColor,
        }}
      />
      <div
        style={{
          ...labelStyle,
          left: `${rect.left + rect.width / 2}px`,
          top: `${Math.max(0, dTop / 2 - 8)}px`,
          transform: 'translate(-50%, 0)',
        }}
      >
        {toOutputPx(dTop)} px
      </div>
      {/* Bottom ruler */}
      <div
        style={{
          position: 'absolute',
          left: `${rect.left + rect.width / 2}px`,
          top: `${rect.bottom}px`,
          width: '1px',
          height: `${Math.max(0, dBottom)}px`,
          background: guideLineColor,
        }}
      />
      <div
        style={{
          ...labelStyle,
          left: `${rect.left + rect.width / 2}px`,
          top: `${rect.bottom + Math.max(0, dBottom / 2 - 6)}px`,
          transform: 'translate(-50%, 0)',
        }}
      >
        {toOutputPx(dBottom)} px
      </div>
      {/* Left ruler */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: `${rect.top + rect.height / 2}px`,
          width: `${Math.max(0, dLeft)}px`,
          height: '1px',
          background: guideLineColor,
        }}
      />
      <div
        style={{
          ...labelStyle,
          left: `${Math.max(0, dLeft / 2)}px`,
          top: `${rect.top + rect.height / 2}px`,
          transform: 'translate(-50%, -50%)',
        }}
      >
        {toOutputPx(dLeft)} px
      </div>
      {/* Right ruler */}
      <div
        style={{
          position: 'absolute',
          left: `${rect.right}px`,
          top: `${rect.top + rect.height / 2}px`,
          width: `${Math.max(0, dRight)}px`,
          height: '1px',
          background: guideLineColor,
        }}
      />
      <div
        style={{
          ...labelStyle,
          left: `${rect.right + Math.max(0, dRight / 2)}px`,
          top: `${rect.top + rect.height / 2}px`,
          transform: 'translate(-50%, -50%)',
        }}
      >
        {toOutputPx(dRight)} px
      </div>
      {/* Offset X/Y label.  Sits just above the bbox top-left when there is
          room; otherwise drops to just below it so it never escapes the
          container.  Always shown — when not pinned the value reads "0/0",
          which still conveys "this row sits at the alignment-based home". */}
      <div
        style={{
          ...labelStyle,
          left: `${rect.left}px`,
          top: rect.top >= 18 ? `${rect.top - 18}px` : `${rect.bottom + 4}px`,
          background: 'rgba(34, 197, 94, 0.95)',
          color: '#062314',
          fontWeight: 600,
        }}
      >
        X: {offsetX >= 0 ? `+${offsetX}` : offsetX}
        {' '}
        Y: {offsetY >= 0 ? `+${offsetY}` : offsetY}
      </div>
    </div>
  )
}
