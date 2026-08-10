import { useMemo } from 'react'
import {
  SubtitleOverlay,
  estimateOverlayHeightPx,
} from '@/components/subtitle-overlay/subtitle-overlay'
import { getLibassScaleFor, FALLBACK_LIBASS_SCALE } from '@/lib/font-metrics'
import { useSettingsStore } from '@/stores/settings-store'
import { useAppEnvStore } from '@/stores/app-env-store'
import { isFontId, type FontId } from '../../../shared/fonts'
import type { SubtitleEntry } from '../../../shared/types'

/**
 * REQ-0471 §1 / REQ-0472 §1 — per-row style preview for the STEP 2 subtitle
 * list.
 *
 * Owner decision (a) = 案A: reuse the SAME `SubtitleOverlay` the video panel
 * and Step 1's style sample already use, so the list row is pixel-faithful to
 * the burn-in (canvas outline ring + shadow, libass scale, tofu substitution)
 * without a second rendering system — the standing principle in
 * `dev-docs/specs/subtitle-list-ui.md` §0.1.
 *
 * ## FIXED font size (REQ-0472 §1 — supersedes REQ-0471's proportional scale)
 *
 * REQ-0471 rendered the preview at a scale that PRESERVED each cue's relative
 * size (`PREVIEW_REF_WIDTH_PX`).  On 4K material a caption's `fontSizePx` is
 * several hundred px, so "relative sizes" made rows unreadably tall — and it
 * was the source of the fling-scroll "giant text" report.  The list is a
 * read/select surface, so the preview now renders every cue's text at a
 * CONSTANT on-screen size, independent of:
 *   - the cue's `fontSizePx`,
 *   - the video resolution,
 *   - the keyword-emphasis scale (`emphasisScalePercent`).
 *
 * Mechanism: the overlay derives its scale as `containerWidthPx / videoWidthPx`
 * (its ONLY two uses of `videoWidthPx` — verified — are this ratio and the
 * height estimate, which uses the same ratio).  So we pick a per-cue effective
 * scale `S = TARGET_PREVIEW_FONT_CSS_PX / (fontSizePx × libassScale)` that
 * lands the rendered glyph at exactly `TARGET_PREVIEW_FONT_CSS_PX`, then hand
 * the overlay `containerWidthPx = W` (the real cell width, for wrapping) and
 * `videoWidthPx = W / S` so the ratio comes out to `S`.  Because the outline,
 * shadow and line pitch all ride the same `scale`, they shrink together — the
 * outline stays visually proportional to the fixed-size glyph rather than to
 * the original (possibly 4K) video.  Row height therefore depends only on the
 * line count (constant per-line pitch), never on `fontSizePx`.
 *
 * ## What IS still reflected (spec §0.2)
 *
 * Font (family/weight), text colour + alpha, outline colour + thickness,
 * shadow, casing, background box, and the keyword-emphasis COLOUR.  The
 * emphasis SCALE is deliberately dropped (clone sets `emphasisScalePercent:
 * 100`) so an emphasised word does not blow the row height on 4K cues — only
 * its colour distinguishes it, which is enough to "read/select".  Karaoke is
 * forced off (time-varying, needs a playhead); entrance/exit animation renders
 * settled (no rAF driver here).  Layout is overridden to a vertically-centred
 * single block so a bottom-anchored 4K caption does not fall out of the row.
 */

/** The constant on-screen glyph height (CSS px) for every row preview. */
const TARGET_PREVIEW_FONT_CSS_PX = 16
/** Floor so an empty / one-line row still has a tappable height. */
const PREVIEW_MIN_HEIGHT_PX = 20
/** Ceiling so a many-line cue cannot make a single row dominate the viewport. */
const PREVIEW_MAX_HEIGHT_PX = 96
/** A little breathing room above/below the glyph box. */
const PREVIEW_V_PADDING_PX = 2

/**
 * REQ-0471 §0.2 / REQ-0472 §1 — fields overridden on the preview clone.  Typed
 * as a `Pick` so each key is a checked `SubtitleEntry` field, not a silent
 * literal.  `emphasisScalePercent: 100` keeps the emphasis colour while
 * dropping the size bump.
 */
type PreviewOverride = Pick<
  SubtitleEntry,
  | 'verticalPosition'
  | 'verticalMarginPx'
  | 'posX'
  | 'posY'
  | 'karaokeEnabled'
  | 'emphasisScalePercent'
>

interface RowStylePreviewProps {
  entry: SubtitleEntry
  /** Measured width of the text column, shared by every row (for wrapping). */
  containerWidthPx: number
}

export function RowStylePreview({ entry, containerWidthPx }: RowStylePreviewProps) {
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false

  const resolvedFontId: FontId = isFontId(entry.fontId) ? entry.fontId : activeFontId

  const previewEntry = useMemo<SubtitleEntry>(() => {
    const override: PreviewOverride = {
      verticalPosition: 'center',
      verticalMarginPx: 0,
      posX: undefined,
      posY: undefined,
      karaokeEnabled: false,
      // Keep emphasis COLOUR (enabled + spans + colour) but drop the size bump.
      emphasisScalePercent: 100,
    }
    return { ...entry, ...override }
  }, [entry])

  // Per-cue effective scale that lands the glyph at TARGET_PREVIEW_FONT_CSS_PX
  // regardless of fontSizePx / video resolution.  See the docblock.
  const libassScale = getLibassScaleFor(resolvedFontId) || FALLBACK_LIBASS_SCALE
  const fontSizePx = Math.max(1, previewEntry.fontSizePx)
  const scale = TARGET_PREVIEW_FONT_CSS_PX / (fontSizePx * libassScale)
  const overlayVideoWidthPx = containerWidthPx / scale

  const heightPx = useMemo(() => {
    const raw =
      estimateOverlayHeightPx(
        previewEntry,
        resolvedFontId,
        overlayVideoWidthPx,
        containerWidthPx,
        isMsix,
      ) + PREVIEW_V_PADDING_PX
    return Math.max(
      PREVIEW_MIN_HEIGHT_PX,
      Math.min(PREVIEW_MAX_HEIGHT_PX, Math.round(raw)),
    )
  }, [previewEntry, resolvedFontId, overlayVideoWidthPx, containerWidthPx, isMsix])

  return (
    <div
      // `isolate` contains the cue's z-index; overflow clips a capped multi-line
      // cue.  Full cell width so left/center/right alignment reads.
      className="relative w-full overflow-hidden isolate"
      style={{ height: `${heightPx}px` }}
    >
      {containerWidthPx > 0 && (
        <SubtitleOverlay
          entry={previewEntry}
          videoWidthPx={overlayVideoWidthPx}
          containerWidthPx={containerWidthPx}
        />
      )}
    </div>
  )
}
