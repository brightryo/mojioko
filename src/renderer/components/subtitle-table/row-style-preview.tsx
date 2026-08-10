import { useMemo } from 'react'
import {
  SubtitleOverlay,
  estimateOverlayHeightPx,
} from '@/components/subtitle-overlay/subtitle-overlay'
import { getLibassScaleFor, FALLBACK_LIBASS_SCALE } from '@/lib/font-metrics'
import { useSettingsStore } from '@/stores/settings-store'
import { useAppEnvStore } from '@/stores/app-env-store'
import { getFontMeta, isFontId, type FontId } from '../../../shared/fonts'
import type { SubtitleEntry } from '../../../shared/types'

/**
 * REQ-0471 §1 / §0 — per-row style preview for the STEP 2 subtitle list.
 *
 * Owner decision (a) = 案A: reuse the SAME `SubtitleOverlay` the video panel
 * and Step 1's style sample already use, so the list row is pixel-faithful to
 * the burn-in (canvas outline ring + shadow, libass scale, tofu substitution)
 * without a second rendering system — the standing principle in
 * `dev-docs/specs/subtitle-list-ui.md` §0.1.
 *
 * ## Layout override (spec §0.2 "conditional" axes)
 *
 * The overlay bottom-/top-anchors text against a full video frame using the
 * cue's own MarginV / `\pos`.  A list row is only tens of px tall, so a
 * bottom-anchored caption at a default MarginV would fall clean out of the
 * row.  The preview therefore renders a CLONE whose layout is overridden to a
 * vertically-centred single block: `verticalPosition: 'center'` +
 * `verticalMarginPx: 0`, pins cleared.  Horizontal alignment is preserved so
 * left/center/right still reads.  Karaoke is forced off (time-varying, needs a
 * playhead — same suppression `style-sample-preview` uses); entrance/exit
 * animation simply renders settled because no rAF driver writes the cue's
 * opacity/transform custom properties here.
 *
 * ## Size scaling (spec §0.4 method 2, density-capped)
 *
 * The overlay scales font size by `containerWidthPx / videoWidthPx`.  Feeding it
 * the raw text-column width makes a default `\fs110` caption render ~48 px tall
 * on a wide window — proportionally correct, but it defeats the density goal
 * (§2) and just reproduces the old 52 px row.  So the preview renders into a
 * width-CAPPED virtual frame (`PREVIEW_REF_WIDTH_PX`): every row shares the SAME
 * effective width and the SAME `videoWidthPx`, so the scale is a single constant
 * across rows — the relative size of one cue vs another is preserved (a `\fs220`
 * cue still reads twice the height of a `\fs110` one) — but the constant is now
 * tuned for a compact row rather than the full column.  On a narrow window the
 * real column width wins (`min`), so the preview never overflows its cell.
 *
 * ## Height (keeps the virtualizer honest)
 *
 * The overlay is `position: absolute` and contributes no height to its parent,
 * so the container is given an explicit height from `estimateOverlayHeightPx`
 * (the very function the collision-stack uses).  Height is a pure function of
 * the cue's fields, so it is IDENTICAL whether the full overlay or the
 * lightweight fallback is mounted inside — swapping between them on scroll
 * causes NO remeasure jump in `@tanstack/react-virtual`.
 */

/**
 * Width of the virtual frame the preview scales against (spec §0.4).  Chosen so
 * a default `\fs110` caption renders ~20 px tall (110 × ~0.69 libass × 512/1920
 * ≈ 20), which reads clearly in a compact row.  Larger/smaller cues scale off
 * the same constant, so relative sizes are preserved.  The real column width
 * caps this on narrow windows so the preview never exceeds its cell.
 */
const PREVIEW_REF_WIDTH_PX = 432
/** Floor so a tiny font still leaves a tappable/legible row. */
const PREVIEW_MIN_HEIGHT_PX = 18
/**
 * Ceiling so a pathological `\fs600` cue does not produce a 100+px row that
 * defeats the density goal (§2).  Beyond this the preview clips (overflow
 * hidden); the true size is still conveyed up to the cap and the exact value
 * lives in the Inspector.
 */
const PREVIEW_MAX_HEIGHT_PX = 132
/** A little breathing room above/below the glyph box. */
const PREVIEW_V_PADDING_PX = 2

/**
 * REQ-0471 §0.2 — fields the row preview overrides on a clone so a full-frame
 * cue renders sensibly inside a short row.  Typed as a `Pick` so each key is a
 * checked `SubtitleEntry` field, not a silent literal.
 */
type PreviewLayoutOverride = Pick<
  SubtitleEntry,
  'verticalPosition' | 'verticalMarginPx' | 'posX' | 'posY' | 'karaokeEnabled'
>

interface RowStylePreviewProps {
  entry: SubtitleEntry
  videoWidthPx: number
  /** Measured width of the text column, shared by every row (see JSDoc). */
  containerWidthPx: number
  /**
   * REQ-0471 §3 — during a fling scroll the parent flips this on so the row
   * drops the canvas ring (whose `useLayoutEffect` has no dep array and does a
   * synchronous layout read per render) for a cheap CSS approximation.  Height
   * is unchanged, so there is no remeasure churn.  Settles back to the full
   * overlay when scrolling stops.
   */
  lightweight: boolean
}

export function RowStylePreview({
  entry,
  videoWidthPx,
  containerWidthPx,
  lightweight,
}: RowStylePreviewProps) {
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false

  const resolvedFontId: FontId = isFontId(entry.fontId) ? entry.fontId : activeFontId

  // Width-capped virtual frame (see PREVIEW_REF_WIDTH_PX docblock).
  const effectiveWidthPx = Math.min(containerWidthPx, PREVIEW_REF_WIDTH_PX)

  const previewEntry = useMemo<SubtitleEntry>(() => {
    const override: PreviewLayoutOverride = {
      verticalPosition: 'center',
      verticalMarginPx: 0,
      posX: undefined,
      posY: undefined,
      karaokeEnabled: false,
    }
    return { ...entry, ...override }
  }, [entry])

  const heightPx = useMemo(() => {
    const raw =
      estimateOverlayHeightPx(
        previewEntry,
        resolvedFontId,
        videoWidthPx,
        effectiveWidthPx,
        isMsix,
      ) + PREVIEW_V_PADDING_PX
    return Math.max(
      PREVIEW_MIN_HEIGHT_PX,
      Math.min(PREVIEW_MAX_HEIGHT_PX, Math.round(raw)),
    )
  }, [previewEntry, resolvedFontId, videoWidthPx, effectiveWidthPx, isMsix])

  return (
    <div className="w-full flex items-center" style={{ height: `${heightPx}px` }}>
      {/* Width-capped virtual frame the overlay scales against.  Left-aligned
          in the (wider) cell; `isolate` contains the cue's z-index; overflow
          clips a capped oversize cue. */}
      <div
        className="relative overflow-hidden isolate"
        style={{ width: `${effectiveWidthPx}px`, height: `${heightPx}px` }}
      >
        {effectiveWidthPx > 0 &&
          (lightweight ? (
            <LightweightPreview
              entry={previewEntry}
              resolvedFontId={resolvedFontId}
              videoWidthPx={videoWidthPx}
              containerWidthPx={effectiveWidthPx}
            />
          ) : (
            <SubtitleOverlay
              entry={previewEntry}
              videoWidthPx={videoWidthPx}
              containerWidthPx={effectiveWidthPx}
            />
          ))}
      </div>
    </div>
  )
}

/**
 * REQ-0471 §0.5 — the CSS-only fallback rendered during active scrolling.
 *
 * Deliberately DROPS the two canvases (outline ring + shadow): it renders just
 * the styled text with `-webkit-text-stroke` as a rough outline stand-in.  The
 * ring is centred (so it reads ~2× too thick and eats hollow interiors at high
 * `\bord`) — acceptable for the fraction of a second the list is flinging, and
 * it costs no `getClientRects` / `strokeText` per frame.  Font size uses the
 * cached libass scale so the glyphs land at roughly the overlay's size and the
 * swap is visually stable.
 */
function LightweightPreview({
  entry,
  resolvedFontId,
  videoWidthPx,
  containerWidthPx,
}: {
  entry: SubtitleEntry
  resolvedFontId: FontId
  videoWidthPx: number
  containerWidthPx: number
}) {
  const meta = getFontMeta(resolvedFontId)
  const scale = containerWidthPx / videoWidthPx
  const libassScale = getLibassScaleFor(resolvedFontId) || FALLBACK_LIBASS_SCALE
  const fontPx = Math.max(1, entry.fontSizePx * libassScale * scale)
  const outlinePx = Math.max(0, entry.outlineThicknessPx * scale)

  const textAlign: React.CSSProperties['textAlign'] =
    entry.horizontalPosition === 'center'
      ? 'center'
      : entry.horizontalPosition === 'right'
        ? 'right'
        : 'left'

  const textAlpha = (entry.textAlpha ?? 100) / 100
  const bg = entry.subtitleBackground
  const casing: React.CSSProperties['textTransform'] =
    entry.casing === 'uppercase' ? 'uppercase' : 'none'

  return (
    <div
      className="absolute inset-0 flex items-center px-1"
      style={{
        justifyContent:
          textAlign === 'center'
            ? 'center'
            : textAlign === 'right'
              ? 'flex-end'
              : 'flex-start',
      }}
    >
      <span
        className="whitespace-pre-wrap break-words"
        style={{
          fontFamily: `'${meta.cssFontFamily}'`,
          fontSize: `${fontPx}px`,
          lineHeight: 1.1,
          textAlign,
          color: entry.textColorHex,
          opacity: textAlpha,
          textTransform: casing,
          WebkitTextStrokeWidth: outlinePx > 0 ? `${outlinePx}px` : undefined,
          WebkitTextStrokeColor: outlinePx > 0 ? entry.outlineColorHex : undefined,
          ...(bg.enabled
            ? {
                backgroundColor:
                  bg.color === 'white'
                    ? `rgba(255,255,255,${bg.opacityPercent / 100})`
                    : `rgba(0,0,0,${bg.opacityPercent / 100})`,
                padding: '0 2px',
              }
            : null),
        }}
      >
        {entry.text.replace(/\\N/g, '\n')}
      </span>
    </div>
  )
}
