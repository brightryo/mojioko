import { useRef, useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Type } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { SubtitleOverlay } from '@/components/subtitle-overlay/subtitle-overlay'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import {
  getSubtitleFont,
  loadSubtitleFont,
  type SubtitleFont
} from '@/lib/font-metrics'
import { ensureFontLoaded } from '@/lib/font-registry'
import { useSettingsStore } from '@/stores/settings-store'
import type {
  TranscriptionDefaults,
  VideoInfo,
  SubtitleEntry,
  BurninPosition
} from '../../../shared/types'

/**
 * Bottom-centre is the standard subtitle convention.  Step 1 deliberately
 * does NOT expose position controls (that responsibility belongs to Step 3),
 * so the preview always renders at this fixed reference position.  The
 * vertical margin matches Step 3's BURNIN_DEFAULTS so the seed look here
 * lines up with the final burn position when the user later opens Step 3
 * without changing anything.
 */
const PREVIEW_BURNIN: BurninPosition = {
  horizontalPosition: 'center',
  verticalPosition: 'bottom',
  verticalMarginPx: 30
}

/** Fallback frame size when no video is loaded — drives the preview's aspect
 *  ratio and feeds SubtitleOverlay's libass scale calc so the sample text
 *  renders at roughly its eventual on-video size even before a video is
 *  picked. */
const FALLBACK_VIDEO_WIDTH = 1920
const FALLBACK_VIDEO_HEIGHT = 1080

/** Cap on the preview frame's rendered height.  Used both standalone in
 *  Step 1's first view AND inside the subtitle style dialog — the dialog
 *  pairs the preview with a tall column of form controls, so a 220 px tall
 *  frame pushes the dialog past the user's vertical comfort budget on
 *  1280×820.  160 still gives ~285 px at 16:9 — wide enough to verify
 *  wrap position and outline visibility, while reclaiming ~60 px back to
 *  the form column.  Smaller values trade detail for compactness, but at
 *  this size the sample text is still legible at the default font size. */
const FRAME_MAX_HEIGHT_PX = 160

interface StyleSamplePreviewProps {
  defaults: TranscriptionDefaults
  thumbnail: string | null
  video: VideoInfo | null
  /**
   * When true, the sample text is passed through applyAutoLineBreak so the
   * preview mirrors what every transcribed row will look like after Step 1's
   * post-transcription line-break pass.  Passes through the same glyph-width
   * pipeline (opentype.js + libassScale) used by the production code.
   */
  autoLineBreak: boolean
}

/**
 * Live "what each transcribed row will look like" preview for Step 1.
 *
 * Reuses SubtitleOverlay (the same component Step 2's video panel uses) so
 * the preview is pixel-faithful to what ffmpeg + libass will actually
 * render at burn-in time.  Seed values flow straight from the project
 * store's `defaults` via props — any field change in the right-column
 * controls re-renders this view on the next React tick with no additional
 * plumbing.
 *
 * The component is intentionally generic over its parent: it takes only
 * `defaults` + `thumbnail` + `video` and contains zero references to the
 * surrounding form, so the same preview can later be embedded in other
 * surfaces (e.g. a settings dialog) without modification.
 */
export function StyleSamplePreview({
  defaults,
  thumbnail,
  video,
  autoLineBreak
}: StyleSamplePreviewProps) {
  const { t } = useTranslation('step1')
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // SubtitleOverlay scales font size by (containerWidth / videoWidth) so we
  // need the rendered width of our preview frame.  Measured via
  // ResizeObserver because the column width itself is fluid (lg→sm
  // breakpoint, window resize).
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth)
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Subscribe to the subtitle font so applyAutoLineBreak below can use
  // glyph-accurate widths once the font finishes loading.  Initial value
  // pulls from the module cache: if the font is already loaded (Step 1
  // preloaded it on mount, or a previous visit cached it), we get an
  // immediate hit and avoid the brief char-class-fallback frame.
  // Otherwise, the effect fires loadSubtitleFont() and re-renders this
  // component when it resolves — the user sees the break position shift
  // by a few pixels on the first ~50-150ms paint, which is the documented
  // trade-off for not blocking the whole preview on font fetch.
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const [font, setFont] = useState<SubtitleFont | null>(getSubtitleFont)
  // Re-fetch the opentype.js Font + register the FontFace whenever the
  // active selection changes so:
  //   - applyAutoLineBreak measures with the right metrics
  //   - SubtitleOverlay below renders in the selected family on first paint
  // Clearing first prevents the wrap position from briefly using the
  // previous font's widths during the load transition.  Awaiting both
  // load paths makes the re-render happen only after the FontFace is
  // actually queryable via CSS.
  useEffect(() => {
    setFont(null)
    let cancelled = false
    Promise.all([
      loadSubtitleFont(),
      ensureFontLoaded(activeFontId)
    ])
      .then(([loaded]) => {
        if (!cancelled) setFont(loaded)
      })
      .catch((err) => {
        // Load failed — applyAutoLineBreak will silently fall back to the
        // character-class width estimate (which over-estimates wide-glyph
        // widths by ~45 % vs libass, so the preview may break slightly
        // earlier than the real burn-in).  This degrades gracefully
        // rather than throwing.
        console.error('[style-sample-preview] font load failed', err)
      })
    return () => { cancelled = true }
  }, [activeFontId])

  // Long-form sample text — chosen so the user can verify line wrapping,
  // font-size sanity and outline visibility at a glance.  A single short
  // word ("Sample") would hide overflow/wrap problems that only show up
  // with a realistic-length caption.
  const sampleText = t(
    'subtitleDefaults.sampleText',
    'これはサンプル字幕です。書き出し後の見た目をここで確認できます。'
  )

  const videoWidthPx = video?.widthPx ?? FALLBACK_VIDEO_WIDTH
  const videoHeightPx = video?.heightPx ?? FALLBACK_VIDEO_HEIGHT
  const aspectRatio = `${videoWidthPx} / ${videoHeightPx}`

  const sampleEntry: SubtitleEntry = useMemo(() => {
    // When the user has enabled auto line break, run the SAME function the
    // production transcription pipeline uses (step1.tsx → applyAutoLineBreak)
    // so the preview's wrap positions match what will be burned in once
    // they hit Start.  If the font is not yet loaded, applyAutoLineBreak
    // silently falls back to a character-class width estimate; the visible
    // wrap may shift by a few pixels when the font finishes loading and
    // the useEffect above re-renders us.
    const wrappedText = autoLineBreak
      ? applyAutoLineBreak(
          sampleText,
          defaults.fontSizePx,
          defaults.outlineThicknessPx,
          videoWidthPx,
          font
        )
      : sampleText

    const base = {
      startSec: 0,
      endSec: 1,
      text: wrappedText,
      fontSizePx: defaults.fontSizePx,
      textColorHex: defaults.textColorHex,
      outlineColorHex: defaults.outlineColorHex,
      outlineThicknessPx: defaults.outlineThicknessPx,
      fadeEnabled: defaults.fadeEnabled
    }
    return {
      id: 'step1-sample',
      ...base,
      isDeleted: false,
      isEdited: false,
      original: { ...base }
    }
  }, [
    sampleText,
    autoLineBreak,
    font,
    videoWidthPx,
    defaults.fontSizePx,
    defaults.textColorHex,
    defaults.outlineColorHex,
    defaults.outlineThicknessPx,
    defaults.fadeEnabled
  ])

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-2">
      <div className="flex items-center gap-1.5">
        <Type className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <Label className="uppercase tracking-wider text-[10px]">
          {t('subtitleDefaults.previewLabel', 'プレビュー')}
        </Label>
      </div>

      <div className="flex justify-center w-full">
        <div
          ref={containerRef}
          className="rounded-md bg-input border border-border relative overflow-hidden"
          style={{
            aspectRatio,
            maxHeight: `${FRAME_MAX_HEIGHT_PX}px`,
            // Derive width from the capped height so the aspect ratio stays
            // correct: at FRAME_MAX_HEIGHT_PX × (w/h), the frame is its
            // natural max-tall size and `flex justify-center` on the parent
            // keeps it horizontally centred when the column is wider.
            width: `${Math.round(FRAME_MAX_HEIGHT_PX * (videoWidthPx / videoHeightPx))}px`,
            maxWidth: '100%'
          }}
        >
          {thumbnail ? (
            <img
              src={thumbnail}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
            />
          ) : (
            // No video yet — render a neutral dark surface so the seed
            // style is still legible against a plausible burn-in
            // background.  --background gives a near-black that mirrors
            // the typical "dark video" case the burn-in is designed for.
            <div className="absolute inset-0 bg-background" />
          )}
          {containerWidth > 0 && (
            <SubtitleOverlay
              entry={sampleEntry}
              burnin={PREVIEW_BURNIN}
              videoWidthPx={videoWidthPx}
              containerWidthPx={containerWidth}
            />
          )}
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {t(
          'subtitleDefaults.previewNote',
          '※ 近似表示です。書き出し後の動画で最終確認してください。'
        )}
      </p>
    </div>
  )
}
