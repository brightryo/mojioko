import type { SubtitleEntry, BurninPosition, SubtitleBackground } from '../../../shared/types'
import { ASS_MARGIN_LR_PX } from '../../../shared/constants'
import { getLibassScale } from '@/lib/font-metrics'
import { useSettingsStore } from '@/stores/settings-store'
import { getFontMeta } from '../../../shared/fonts'

/** Floor (in OUTPUT pixels, not on the scale factor) applied to the visible
 *  outline so the thinnest setting (= 1) remains discernible at small preview
 *  sizes.  Larger values pass through with their natural proportional scale,
 *  matching the libass output. */
const MIN_VISIBLE_OUTLINE_PX = 0.5

export interface SubtitleOverlayProps {
  entry: SubtitleEntry
  burnin: BurninPosition
  /** Native video width in pixels — denominator for the container/video scale. */
  videoWidthPx: number
  /** Rendered container width in pixels — measured by the caller via ResizeObserver. */
  containerWidthPx: number
  subtitleBackground?: SubtitleBackground
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
  burnin,
  videoWidthPx,
  containerWidthPx,
  subtitleBackground,
}: SubtitleOverlayProps) {
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const fontMeta = getFontMeta(activeFontId)
  const libassScale = getLibassScale()
  const scale      = containerWidthPx / videoWidthPx
  const fontSizePx = entry.fontSizePx        * libassScale * scale

  // Diagnostic: log every render alongside the resolved font.  Lets us
  // verify in DevTools that activeFontId propagates correctly into the
  // step 2 SubtitleOverlay path (the v1.1.1 regression manifested as
  // "step1 dialog shows Dela but step2 video preview shows fallback").
  if (typeof window !== 'undefined') {
    // Cheap to compute, only logged once per render so it does not flood.
    // eslint-disable-next-line no-console
    console.debug(`[subtitle-overlay] render — activeFontId=${activeFontId}, fontFamily=${fontMeta.cssFontFamily}, weight=${fontMeta.weight}`)
  }
  const marginVPx  = burnin.verticalMarginPx * scale
  const marginHPx  = ASS_MARGIN_LR_PX        * scale

  // Outline width (visible outside the glyph), in preview pixels.  Scaled by
  // the same `scale` as the text so the outline/glyph ratio matches the libass
  // output.  Only the absolute minimum is floored — see JSDoc.
  const outlineRaw    = entry.outlineThicknessPx * scale
  const outlinePx     = outlineRaw > 0 ? Math.max(outlineRaw, MIN_VISIBLE_OUTLINE_PX) : 0
  // 2× because paint-order: stroke fill paints fill on top of the centered
  // stroke, hiding the inside half — only outlinePx is visible outside.
  const strokeWidthPx = outlinePx * 2

  const vStyle = burnin.verticalPosition === 'bottom'
    ? { bottom: `${marginVPx}px` }
    : { top:    `${marginVPx}px` }

  const textAlign = (
    burnin.horizontalPosition === 'center' ? 'center' :
    burnin.horizontalPosition === 'right'  ? 'right'  : 'left'
  ) as React.CSSProperties['textAlign']

  const hStyle = { left: `${marginHPx}px`, right: `${marginHPx}px`, textAlign }

  // CSS background approximation for the subtitle preview
  const bgEnabled = subtitleBackground?.enabled === true
  const bgOpacity = bgEnabled ? (subtitleBackground!.opacityPercent / 100) : 0
  const bgColor   = bgEnabled
    ? (subtitleBackground!.color === 'white'
        ? `rgba(255, 255, 255, ${bgOpacity})`
        : `rgba(0, 0, 0, ${bgOpacity})`)
    : undefined

  // Outline is suppressed while the background panel is enabled — same rule as
  // libass (an opaque panel makes the outline visually redundant).
  const showOutline = !bgEnabled && outlinePx > 0

  return (
    <span
      className="absolute leading-snug pointer-events-none"
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
