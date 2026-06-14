import type { SubtitleEntry } from '../../../shared/types'
import { ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { getLibassScaleFor } from '@/lib/font-metrics'
import { useSettingsStore } from '@/stores/settings-store'
import { getFontMeta, isFontId, type FontId } from '../../../shared/fonts'
import { bumpRenderCount } from '@/lib/perf-counter'
import { pinnedAnchorTransform } from '@/lib/preview-coords'

/** Floor (in OUTPUT pixels, not on the scale factor) applied to the visible
 *  outline so the thinnest setting (= 1) remains discernible at small preview
 *  sizes.  Larger values pass through with their natural proportional scale,
 *  matching the libass output. */
const MIN_VISIBLE_OUTLINE_PX = 0.5

/**
 * Per-caption line-height ratio used by `estimateOverlayHeightPx` for the
 * stacking gap between successive captions.  Tuned for the libass burn-in,
 * NOT for the CSS box of a single caption:
 *
 *   - The root `<span>` itself paints with Tailwind's `leading-snug`
 *     (= 1.375), so the caption's own visual height is unchanged whatever
 *     value we pick here.  Only the *gap* between stacked captions moves.
 *   - libass adds its own line gap on top of font metrics when it stacks
 *     overlapping events, so a CSS-faithful 1.375 produces a stack that
 *     reads as visibly "tighter" than the burn-in.  VERIFY-20260613-001
 *     §4 confirmed this empirically (the gap discrepancy compounds with
 *     stack depth).
 *   - An over-estimate brings successive captions' centres into closer
 *     alignment with the burn-in output, at the cost of leaving a touch
 *     more empty space between captions than the CSS box would suggest.
 *     Within the "approximate preview" disclaimer (RES-20260612-003 §Q3)
 *     that trade is the right way round — under-estimating the gap
 *     silently overlapped captions (= "ghost" preview), while
 *     slightly over-estimating just spaces them out.
 *
 * REQ-20260614-001 補遺⑬: 1.6 → 1.8 に引き上げ (補遺⑫ D で確認された
 * 「複製クリップが部分的に重なるゴースト現象」を軽減するため).  既知の
 * 候補値は `1.6` (旧、ゴーストあり) / `1.8` (現、補遺⑬ で採用) / `2.0` /
 * `2.2`.  オーナーが複製・重なりサンプルでプレビューと焼き込みを並べて
 * 比較し、必要に応じてこの定数を再調整する手順 (RES-20260614-001-
 * followup13 §2).  REQ-20260613-006 §3 の「knob であり derivation では
 * ない」原則は不変。
 */
const STACK_LINE_HEIGHT_RATIO = 1.8

export interface SubtitleOverlayProps {
  entry: SubtitleEntry
  /** Native video width in pixels — denominator for the container/video scale. */
  videoWidthPx: number
  /** Rendered container width in pixels — measured by the caller via ResizeObserver. */
  containerWidthPx: number
  /**
   * REQ-20260613-004: additional pixel offset (ASS coordinate space) ABOVE
   * the entry's own `verticalMarginPx`, used so multiple simultaneous
   * captions stack the same way libass does on burn-in (first caption at
   * the entry's preferred MarginV, later captions pushed away).  Computed
   * by `computeFixedStackOffsets` in the parent and passed in here; 0 / undef
   * for a standalone caption.
   *
   * REQ-20260613-016 Phase 3: this offset is now RELATIVE to the entry's
   * own MarginV (which itself comes from `entry.verticalMarginPx`), so
   * different entries in the same alignment group with different MarginV
   * values stack correctly without the parent having to pre-mix
   * coordinate frames.
   */
  stackOffsetPx?: number
  /**
   * REQ-20260613-016 Phase 6 — pointerdown handler installed only when the
   * parent wants the overlay to be draggable.  Caller hooks pointermove
   * and pointerup via `setPointerCapture` itself; the overlay just
   * forwards the initial event.  When present, the overlay's CSS becomes
   * `pointer-events-auto` + cursor=move so the cursor signal matches.
   * When omitted (= legacy preview-only path) the overlay stays
   * `pointer-events-none` and never captures clicks.
   */
  onPointerDown?: (e: React.PointerEvent<HTMLSpanElement>, entry: SubtitleEntry) => void
}

/**
 * REQ-20260613-004: estimate the rendered pixel height of a SubtitleOverlay
 * for stacking purposes.  Pure function — no DOM measurement — so the
 * caller can compute cumulative offsets synchronously per render.
 *
 *   fontSizePx_rendered = entry.fontSizePx * libassScale * scale
 *   lineCount           = 1 + count of `\N` in entry.text
 *   height              = fontSizePx_rendered * STACK_LINE_HEIGHT_RATIO * lineCount
 *
 * This is intentionally an approximation:
 *   - It ignores the ascender / descender padding browsers add around the
 *     glyph box, so very tall outlines extend past the estimated bottom.
 *   - It assumes every line is exactly `fontSizePx * line-height` tall,
 *     which holds for Latin glyphs but not perfectly for CJK with mixed
 *     vocal-marker heights.
 *   - It does not account for libass-specific spacing between stacked
 *     captions (libass adds a small gap; we use 0 — captions touch).
 *
 * That said, the formula is exactly what the browser's CSS box height
 * resolves to (font-size * line-height * line-count) for an inline-block
 * with `leading-snug`, so within the "preview is approximate" disclaimer
 * the stacking position is faithful enough that the user can see
 *   (a) HOW MANY captions overlap,
 *   (b) IN WHAT ORDER (= same as the burn-in output), and
 *   (c) ROUGHLY WHERE each one will sit.
 * Pixel-perfect alignment with libass is explicitly out of scope per
 * REQ-20260613-004 §1.
 */
export function estimateOverlayHeightPx(
  entry: SubtitleEntry,
  activeFontId: FontId,
  videoWidthPx: number,
  containerWidthPx: number,
): number {
  const resolvedFontId = isFontId(entry.fontId) ? entry.fontId : activeFontId
  const libassScale = getLibassScaleFor(resolvedFontId)
  const scale = containerWidthPx / videoWidthPx
  const renderedFontSizePx = entry.fontSizePx * libassScale * scale
  // `\N` is the persisted line-break marker (RES-20260612-002 Q2).
  const lineCount = 1 + (entry.text.match(/\\N/g)?.length ?? 0)
  return renderedFontSizePx * STACK_LINE_HEIGHT_RATIO * lineCount
}

/**
 * CSS-based subtitle overlay rendered on top of a video preview.
 *
 * Font size is scaled by `getLibassScale()` (= unitsPerEm / winHeight ≈ 0.6906
 * for NotoSansJP-SemiBold) in addition to the container/video scale.  This
 * compensates for the difference between how the browser and libass interpret
 * font size: libass scales glyphs against OS/2 winHeight rather than unitsPerEm,
 * so without this correction the preview renders text larger than the output
 * video (≈19 chars vs 27).
 *
 * Outline rendering uses `-webkit-text-stroke` with `paint-order: stroke fill`.
 * The stroke is painted first and then the fill is drawn on top, so the inside
 * half of the (centered) stroke is covered by the fill and only the OUTSIDE
 * half remains visible.  Doubling the stroke width therefore leaves exactly
 * `outlinePx` of stroke visible outside the glyph — matching how libass paints
 * outlines around (not into) each glyph.
 *
 * Outline size uses the plain container/video `scale`, with a floor applied to
 * the resulting OUTPUT pixel value (`MIN_VISIBLE_OUTLINE_PX`) — not to the
 * scale factor itself.  Rationale:
 *   - An earlier version floored the scale (`max(scale, 0.5)`).  At typical
 *     preview scales (≈0.17–0.26) that nearly doubled the outline relative to
 *     the text, making thickness=3 look thick enough to fill the glyph while
 *     the actual output renders ≈6 % outline/cap-height ratio.
 *   - Flooring the absolute pixel value instead leaves thicknesses ≥ 2 at
 *     their natural `outlineThicknessPx * scale`, matching the libass output
 *     proportionally, and only nudges thickness = 1 up to 0.5 px so it stays
 *     barely visible (would otherwise be sub-pixel and indistinguishable
 *     from 0 at small previews).
 *
 * libassScale is intentionally NOT applied to the outline — outline thickness
 * is an absolute video-pixel measurement (relative to PlayResY) in ASS, not a
 * glyph metric.  The libass `\bord` value passes straight through and is
 * interpreted by libass in output pixels, independent of the per-glyph
 * winHeight correction.
 *
 * Renders as `position: absolute` — caller must provide a `position: relative`
 * parent that wraps the video element.
 *
 * Limitations (shown by the "近似表示" disclaimer beside the preview):
 *  - CSS and libass use different font-metrics pipelines; widths won't be pixel-perfect.
 *  - At very small preview scales the outline is amplified (see scale floor above),
 *    so the on-screen thickness slightly exceeds the proportional output thickness.
 *  - Sub-pixel hinting may shift character widths.
 */
export function SubtitleOverlay({
  entry,
  videoWidthPx,
  containerWidthPx,
  stackOffsetPx,
  onPointerDown,
}: SubtitleOverlayProps) {
  bumpRenderCount('SubtitleOverlay')
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  // Per-row font override (REQ-022 step 4): when the entry carries a
  // fontId, render with that family + its own libassScale.  Otherwise
  // fall back to the project default (activeFontId) so legacy rows and
  // freshly-added blank rows match what burn-in would produce.
  const resolvedFontId = isFontId(entry.fontId) ? entry.fontId : activeFontId
  const fontMeta = getFontMeta(resolvedFontId)
  const libassScale = getLibassScaleFor(resolvedFontId)
  const scale      = containerWidthPx / videoWidthPx
  const fontSizePx = entry.fontSizePx        * libassScale * scale
  // REQ-20260613-016 Phase 3: layout is now driven by the entry itself
  // (no more `burnin` prop).  Each entry carries its own
  // horizontalPosition / verticalPosition / verticalMarginPx — seeded by
  // Phase 1 and editable per row in Phase 4/5.
  const marginVPx  = entry.verticalMarginPx * scale
  const marginHPx  = ASS_MARGIN_LR_PX       * scale

  // Outline width (visible outside the glyph), in preview pixels.  Scaled by
  // the same `scale` as the text so the outline/glyph ratio matches the libass
  // output.  Only the absolute minimum is floored — see JSDoc.
  const outlineRaw    = entry.outlineThicknessPx * scale
  const outlinePx     = outlineRaw > 0 ? Math.max(outlineRaw, MIN_VISIBLE_OUTLINE_PX) : 0
  // 2× because paint-order: stroke fill paints fill on top of the centered
  // stroke, hiding the inside half — only outlinePx is visible outside.
  const strokeWidthPx = outlinePx * 2

  // REQ-20260613-016 Phase 6 — pinned rows render at their own ASS-space
  // (posX, posY), independent of MarginV / alignment.  The alignment
  // still drives the anchor (which corner of the text box sits at the
  // pinned point), implemented via CSS transform.
  const isPinned = entry.posX !== undefined && entry.posY !== undefined

  // REQ-20260613-004 + REQ-20260613-016 Phase 3: `stackOffsetPx` is the
  // collision offset (in ASS coordinate space) BEYOND `entry.verticalMarginPx`.
  // The CSS `bottom` / `top` therefore = (entry's own MarginV + collision
  // offset) * scale.  When undef → 0 → standalone caption sits at its own
  // MarginV exactly.  Pinned rows skip stack offset entirely (excluded from
  // computeFixedStackOffsets per Phase 3).
  const stackOffset = (stackOffsetPx ?? 0) * scale

  const textAlign = (
    entry.horizontalPosition === 'center' ? 'center' :
    entry.horizontalPosition === 'right'  ? 'right'  : 'left'
  ) as React.CSSProperties['textAlign']

  let vStyle: React.CSSProperties
  let hStyle: React.CSSProperties
  let transform: string | undefined

  if (isPinned) {
    // Pinned: left/top = posX/posY in preview pixels.  CSS transform shifts
    // the text box so the alignment-defined anchor sits at the pinned
    // coordinate (matching libass's \pos anchor semantics).
    vStyle = { top: `${(entry.posY ?? 0) * scale}px` }
    hStyle = { left: `${(entry.posX ?? 0) * scale}px`, textAlign }
    transform = pinnedAnchorTransform(entry.horizontalPosition, entry.verticalPosition)
  } else {
    vStyle = entry.verticalPosition === 'bottom'
      ? { bottom: `${marginVPx + stackOffset}px` }
      : { top:    `${marginVPx + stackOffset}px` }
    hStyle = { left: `${marginHPx}px`, right: `${marginHPx}px`, textAlign }
    transform = undefined
  }

  // CSS background approximation for the subtitle preview — entry's own
  // subtitleBackground (REQ-20260613-016 Phase 3) replaces the global prop.
  const bg = entry.subtitleBackground
  const bgEnabled = bg.enabled
  const bgOpacity = bgEnabled ? (bg.opacityPercent / 100) : 0
  const bgColor   = bgEnabled
    ? (bg.color === 'white'
        ? `rgba(255, 255, 255, ${bgOpacity})`
        : `rgba(0, 0, 0, ${bgOpacity})`)
    : undefined

  // Outline is suppressed while the background panel is enabled — same rule as
  // libass (an opaque panel makes the outline visually redundant).
  const showOutline = !bgEnabled && outlinePx > 0

  // REQ-20260613-016 Phase 6 — when the parent supplies onPointerDown the
  // overlay becomes interactive: cursor=move, pointer-events-auto, and the
  // raw pointer-down event is forwarded with the bound entry so the
  // parent can start its drag bookkeeping.  When undef the overlay stays
  // strictly visual.
  const interactive = onPointerDown !== undefined

  return (
    <span
      className={
        interactive
          ? 'absolute leading-snug pointer-events-auto cursor-move select-none'
          : 'absolute leading-snug pointer-events-none'
      }
      onPointerDown={interactive
        ? (e) => onPointerDown!(e, entry)
        : undefined}
      style={{
        ...vStyle,
        ...hStyle,
        fontFamily: `'${fontMeta.cssFontFamily}'`,
        fontWeight: fontMeta.weight,
        fontSize:   `${fontSizePx}px`,
        color:      entry.textColorHex,
        WebkitTextStrokeWidth: showOutline ? `${strokeWidthPx}px` : undefined,
        WebkitTextStrokeColor: showOutline ? entry.outlineColorHex : undefined,
        paintOrder: 'stroke fill',
        whiteSpace: 'pre',
        transform,
      }}
    >
      {bgEnabled ? (
        /* Inner inline span so the background fits the text, not the full block width. */
        <span
          style={{
            display:                'inline',
            backgroundColor:        bgColor,
            padding:                `${2 * scale}px ${6 * scale}px`,
            borderRadius:           '2px',
            boxDecorationBreak:     'clone',
            WebkitBoxDecorationBreak: 'clone',
          } as React.CSSProperties}
        >
          {entry.text.replace(/\\N/g, '\n')}
        </span>
      ) : (
        entry.text.replace(/\\N/g, '\n')
      )}
    </span>
  )
}
