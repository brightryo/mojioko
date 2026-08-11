import { useMemo } from 'react'
import {
  SubtitleOverlay,
  estimateOverlayHeightPx,
} from '@/components/subtitle-overlay/subtitle-overlay'
import { getLibassScaleFor, FALLBACK_LIBASS_SCALE, getSubtitleFontFor } from '@/lib/font-metrics'
import { useSettingsStore } from '@/stores/settings-store'
import { useAppEnvStore } from '@/stores/app-env-store'
import { useFontCacheVersionStore } from '@/stores/font-cache-version-store'
import { isFontId, type FontId } from '../../../shared/fonts'
import type { SubtitleEntry } from '../../../shared/types'

/**
 * REQ-0471 §1 / REQ-0472 §1 / REQ-0476 — per-row style preview for the STEP 2
 * subtitle list.
 *
 * Owner decision (a) = 案A: reuse the SAME `SubtitleOverlay` the video panel and
 * Step 1's style sample use, so the list row is pixel-faithful to the burn-in
 * (canvas outline ring + shadow, libass scale, tofu substitution) without a
 * second rendering system — the standing principle in `subtitle-list-ui.md` §0.1.
 *
 * ## No auto-wrap, shrink-to-fit (REQ-0476)
 *
 * The list is where the user checks WHERE the line breaks are, so the preview
 * must break ONLY on `\N` — never at the column edge.  The overlay already sets
 * `white-space: pre` (no soft wrap), so line breaks come only from the `\N`
 * `<br>`s.  When a cue's LONGEST line is wider than the column, the WHOLE cue is
 * scaled down UNIFORMLY (one font size for all its lines, so the break pattern
 * is not distorted) until it fits:
 *   - `TARGET_PREVIEW_FONT_CSS_PX` (16px) is the CEILING — used whenever the cue
 *     already fits (REQ-0472's fixed size, kept for the common case).
 *   - shrink down to `MIN_PREVIEW_FONT_CSS_PX` (the floor).
 *   - if the longest line STILL overflows at the floor, each overflowing line is
 *     truncated with an ellipsis (`…`).
 *
 * Width is measured from the opentype font metrics (`getSubtitleFontFor`), NOT
 * from a DOM reflow: a per-row measure→setState→re-render loop would fight the
 * virtualizer's own `measureElement`.  The measurement re-runs when the font
 * finishes loading (via `fontCacheVersion`).
 *
 * IMPORTANT (REQ-0476 §2): the shrink is driven ONLY by the list COLUMN width.
 * It has NOTHING to do with the video-frame `overflow` warning — that judges
 * whether the burn-in exceeds the video frame, a different question.
 *
 * ## What IS still reflected (spec §0.2)
 *
 * Font (family/weight), text colour + alpha, outline colour + thickness, shadow,
 * casing, background box, keyword-emphasis COLOUR.  Emphasis SCALE is dropped
 * (`emphasisScalePercent: 100`), karaoke forced off, animation settled, rotation
 * dropped, layout overridden to a vertically-centred single block.
 */

/** The CEILING glyph size (CSS px): used whenever the cue already fits. */
const TARGET_PREVIEW_FONT_CSS_PX = 16
/**
 * The shrink FLOOR (CSS px).  A cue whose longest line does not fit even at this
 * size is truncated with an ellipsis rather than shrunk further.  8px still lets
 * a ~50-full-width-char line render whole; tune this one constant to trade
 * legibility for how long a line can be before it gets an ellipsis.
 */
const MIN_PREVIEW_FONT_CSS_PX = 8
/** Floor so an empty / one-line row still has a tappable height. */
const PREVIEW_MIN_HEIGHT_PX = 20
/** Ceiling so a many-line cue cannot make a single row dominate the viewport. */
const PREVIEW_MAX_HEIGHT_PX = 108
/** A little breathing room above/below the glyph box. */
const PREVIEW_V_PADDING_PX = 2
/**
 * Calibration/safety factor on the measured line width.  opentype advance sums
 * run ~10–13% narrower than the actual CSS render (kerning, hinting, the browser
 * rounding the scaled font size up), so the fit is computed against a slightly
 * SMALLER effective width — the preview then lands just inside the column
 * instead of a few px over.  ~15% keeps a comfortable margin; the cost is the
 * font being a hair smaller than the absolute maximum, which is imperceptible.
 */
const WIDTH_SAFETY = 1.15

/** Heuristic em-advance when the font is not parsed yet (avoids a clip flash). */
function fallbackEmAdvance(ch: string): number {
  const code = ch.codePointAt(0) ?? 0
  // ASCII / Latin ≈ 0.55em, CJK & wide ≈ 1em (rough — corrected once the font
  // parses and `fontCacheVersion` bumps this memo).
  return code < 0x2e80 ? 0.55 : 1.0
}

/** Advance of one code point in EM units (width in px = em × fontSizePx). */
function emAdvance(ch: string, font: ReturnType<typeof getSubtitleFontFor>): number {
  if (!font) return fallbackEmAdvance(ch)
  const g = font.charToGlyph(ch)
  const upem = font.unitsPerEm || 1000
  return (g?.advanceWidth ?? 0) / upem
}

/** Sum of em-advances across a line's code points. */
function lineEm(line: string, font: ReturnType<typeof getSubtitleFontFor>): number {
  let em = 0
  for (const ch of line) em += emAdvance(ch, font)
  return em
}

/**
 * REQ-0471 §0.2 / REQ-0472 §1 — fields overridden on the preview clone.  Typed
 * as a `Pick` so each key is a checked `SubtitleEntry` field.
 */
type PreviewOverride = Pick<
  SubtitleEntry,
  | 'verticalPosition'
  | 'verticalMarginPx'
  | 'posX'
  | 'posY'
  | 'karaokeEnabled'
  | 'emphasisScalePercent'
  | 'rotation'
>

interface RowStylePreviewProps {
  entry: SubtitleEntry
  /** Measured width of the text column (already capped in the table). */
  containerWidthPx: number
}

export function RowStylePreview({ entry, containerWidthPx }: RowStylePreviewProps) {
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false
  // Re-run the fit measurement when a font finishes parsing (the metrics change
  // from the heuristic fallback to exact advances).
  const fontCacheVersion = useFontCacheVersionStore((s) => s.version)

  const resolvedFontId: FontId = isFontId(entry.fontId) ? entry.fontId : activeFontId
  const uppercase = entry.casing === 'uppercase'

  const previewEntry = useMemo<SubtitleEntry>(() => {
    const override: PreviewOverride = {
      verticalPosition: 'center',
      verticalMarginPx: 0,
      posX: undefined,
      posY: undefined,
      karaokeEnabled: false,
      emphasisScalePercent: 100,
      rotation: 0,
    }
    return { ...entry, ...override }
  }, [entry])

  const libassScale = getLibassScaleFor(resolvedFontId) || FALLBACK_LIBASS_SCALE

  // Shrink-to-fit: pick the font size (≤ ceiling) at which the widest `\N`-line
  // fits `containerWidthPx`; below the floor, truncate overflowing lines.  Pure
  // metric maths — no DOM reflow.
  const fit = useMemo(() => {
    // Effective width the text must fit inside (WIDTH_SAFETY-shrunk so the
    // opentype-measured fit lands just inside the real CSS render).
    const W = containerWidthPx / WIDTH_SAFETY
    const font = getSubtitleFontFor(resolvedFontId)
    // Measure against the CASED text (the overlay renders text-transform, so the
    // rendered width is the uppercase width for an ALL-CAPS cue).
    const measureText = uppercase ? previewEntry.text.toUpperCase() : previewEntry.text
    const measureLines = measureText.split('\\N')
    let widestEm = 0
    for (const line of measureLines) widestEm = Math.max(widestEm, lineEm(line, font))

    if (widestEm <= 0 || W <= 0) {
      return { fontPx: TARGET_PREVIEW_FONT_CSS_PX, text: previewEntry.text }
    }
    // Font px at which the widest line exactly fills W.
    const fitToFill = W / widestEm
    let fontPx = Math.min(TARGET_PREVIEW_FONT_CSS_PX, fitToFill)
    if (fontPx >= MIN_PREVIEW_FONT_CSS_PX) {
      return { fontPx, text: previewEntry.text }
    }
    // Even at the floor the widest line overflows → truncate overflowing lines.
    fontPx = MIN_PREVIEW_FONT_CSS_PX
    const maxEm = W / fontPx
    const ellEm = emAdvance('…', font)
    const origLines = previewEntry.text.split('\\N')
    const truncated = origLines.map((orig) => {
      const measured = uppercase ? orig.toUpperCase() : orig
      if (lineEm(measured, font) <= maxEm) return orig
      let em = 0
      let out = ''
      for (const ch of orig) {
        const adv = emAdvance(uppercase ? ch.toUpperCase() : ch, font)
        if (em + adv + ellEm > maxEm) break
        em += adv
        out += ch
      }
      return out + '…'
    })
    return { fontPx, text: truncated.join('\\N') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewEntry.text, containerWidthPx, resolvedFontId, uppercase, fontCacheVersion])

  // The overlay derives its scale from containerWidthPx/videoWidthPx; pick the
  // ratio that renders the cue's font at `fit.fontPx`.
  const fontSizePx = Math.max(1, previewEntry.fontSizePx)
  const scale = fit.fontPx / (fontSizePx * libassScale)
  const overlayVideoWidthPx = containerWidthPx / scale

  // Render clone: the (possibly truncated) display text.
  const displayEntry = useMemo<SubtitleEntry>(
    () => (fit.text === previewEntry.text ? previewEntry : { ...previewEntry, text: fit.text }),
    [previewEntry, fit.text],
  )

  const heightPx = useMemo(() => {
    const raw =
      estimateOverlayHeightPx(
        displayEntry,
        resolvedFontId,
        overlayVideoWidthPx,
        containerWidthPx,
        isMsix,
      ) + PREVIEW_V_PADDING_PX
    return Math.max(
      PREVIEW_MIN_HEIGHT_PX,
      Math.min(PREVIEW_MAX_HEIGHT_PX, Math.round(raw)),
    )
  }, [displayEntry, resolvedFontId, overlayVideoWidthPx, containerWidthPx, isMsix])

  return (
    <div
      // `isolate` contains the cue's z-index.  `overflow-hidden` is a safety net
      // (shrink-to-fit already keeps content inside), never the wrap mechanism.
      className="relative w-full overflow-hidden isolate"
      style={{ height: `${heightPx}px` }}
    >
      {containerWidthPx > 0 && (
        <SubtitleOverlay
          entry={displayEntry}
          videoWidthPx={overlayVideoWidthPx}
          containerWidthPx={containerWidthPx}
        />
      )}
    </div>
  )
}
