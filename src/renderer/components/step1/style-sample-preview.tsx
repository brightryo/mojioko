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
import { styleFieldsFromDefaults } from '@/lib/style-defaults-to-entry'
import { makeEntryLayoutDefaults } from '../../../shared/burnin-defaults'
import type {
  TranscriptionDefaults,
  VideoInfo,
  SubtitleEntry
} from '../../../shared/types'

/**
 * REQ-0334 §2 — fields the STILL preview deliberately does not show.
 *
 * Typed as a `Pick` rather than written inline so the suppression is a
 * statement the compiler checks, not an omission: the key must be a real
 * `SubtitleEntry` field, and anything added here is visible in one place.
 *
 * `karaokeEnabled` is forced OFF because karaoke is a *time-varying* effect.
 * With no playhead, `SubtitleOverlay` would build fallback word units and
 * render karaoke spans whose colours are normally written each frame by the
 * video panel's rAF loop — a still frame of an animation, showing a state
 * the user never actually sees.  (Owner scoped karaoke out of this REQ.)
 *
 * Entrance / exit animation is excluded the same way but needs no entry
 * here: it reaches a cue only via `animationFieldsForNewCue`, which this
 * preview simply never calls.
 */
const STILL_PREVIEW_SUPPRESSED: Pick<SubtitleEntry, 'karaokeEnabled'> = {
  karaokeEnabled: false
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
 * render at burn-in time.
 *
 * REQ-0334 §2 — "any field change re-renders this view with no additional
 * plumbing" is now TRUE.  It was not before: the sample entry was built from
 * a hand-written field list (and gated by a second hand-written `useMemo`
 * dependency list), so shadow / casing / rotation / layout / offset / line
 * spacing / emphasis moved their controls and nothing else.  Both lists are
 * gone; the entry comes from `styleFieldsFromDefaults`, the exhaustively
 * typed projection `step1.tsx` uses to seed real transcribed rows, so
 * adding a style default cannot leave this preview behind again.
 *
 * The two effects this STILL preview deliberately does not show are karaoke
 * (`STILL_PREVIEW_SUPPRESSED`) and entrance/exit animation (never seeded —
 * it arrives only via `animationFieldsForNewCue`, which this component does
 * not call).  Both are time-varying and need a playhead; a still frame of
 * either would show a state the user never actually sees.
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

  // REQ-0338 §3-1 — this string is a DIAGNOSTIC, not filler.  It deliberately
  // mixes Latin and Japanese so that picking a Latin-only face (Anton, Bebas
  // Neue, Montserrat, Poppins) renders the Japanese half as tofu right here,
  // where the font was chosen — `substituteMissingGlyphs` swaps every code
  // point outside the font's cmap for the font's own placeholder (□, or ? for
  // Bebas Neue / Poppins), so the mismatch is visible instead of being papered
  // over by a system-font fallback that libass will not reproduce.
  //
  // Do not shorten it to one script.  The `en` string carries a Japanese token
  // for the same reason: the UI language says nothing about what script the
  // user's footage is in, so an English-speaking user subtitling Japanese needs
  // the identical warning.
  //
  // The owner shortened it from a two-sentence caption in REQ-0338; the wrap /
  // overflow rehearsal that length used to provide is the cost, and the
  // diagnostic is what was asked for.
  const sampleText = t('subtitleDefaults.sampleText', 'これはSAMPLE字幕です。')

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
      // REQ-20260615-050 — fade is irrelevant for a static settings
      // preview (no playhead, no ramp); seed with `0` (= no fade).
      fadeDurationSec: 0,
      // REQ-20260613-016 / v1.2.2 機能A Phase 3: SubtitleOverlay reads layout
      // from the entry itself (no `burnin` prop).  This call supplies the
      // `subtitleBackground` sub-object; the layout triple it also returns is
      // overridden by `styleFieldsFromDefaults` below.  Order matters.
      ...makeEntryLayoutDefaults(),
      // REQ-0334 §2 — every style default in one spread, through the SAME
      // function `step1.tsx` uses to seed real transcribed rows.  That
      // sharing is the point: this preview used to list fields by hand and
      // had drifted 14 fields behind `TranscriptionDefaults` (shadow,
      // casing, rotation, line spacing, layout, offset, emphasis), so those
      // controls moved nothing here.  A new style field now reaches this
      // preview automatically, and a field that must NOT reach it has to be
      // written into `STILL_PREVIEW_SUPPRESSED` below.
      ...styleFieldsFromDefaults(defaults, {
        videoWidthPx,
        videoHeightPx
      }),
      ...STILL_PREVIEW_SUPPRESSED
    }
    return {
      id: 'step1-sample',
      ...base,
      isDeleted: false,
      isEdited: false,
      original: { ...base, subtitleBackground: { ...base.subtitleBackground } }
    }
    // `defaults` is depended on WHOLE.  The previous version listed the
    // individual fields it read, which is the same hand-maintained list as
    // the object literal above and drifted with it — a corrected literal
    // still would not have re-rendered.  The settings store replaces this
    // object on every update, so the whole-object dep is both correct and
    // as tight as the per-field list ever was.
  }, [sampleText, autoLineBreak, font, videoWidthPx, videoHeightPx, defaults])

  return (
    // self-start: keep the card at its natural height instead of stretching
    // to match the tall form column on the left of the dialog grid (default
    // align-self for grid items is `stretch`).  Without this the card grows
    // to ~500-600 px and the preview frame floats inside a sea of whitespace
    // that visually reads as "縦長".
    <div className="rounded-xl border border-line bg-surface-1 p-4 space-y-2 self-start">
      <div className="flex items-center gap-1.5">
        <Type className="h-4 w-4 text-fg-secondary flex-shrink-0" />
        <Label>
          {t('subtitleDefaults.previewLabel', 'プレビュー')}
        </Label>
      </div>

      <div className="flex justify-center w-full">
        <div
          ref={containerRef}
          // REQ-0398 §1 — same overlay stacking-context isolation as the main
          // video preview: `isolate` keeps the sample cue's z-index (mirrors its
          // z-order layer) contained so it can never rise above the surrounding
          // dialog chrome.
          className="rounded-md bg-input border border-line relative overflow-hidden isolate"
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
            <div className="absolute inset-0 bg-surface-0" />
          )}
          {containerWidth > 0 && (
            <SubtitleOverlay
              entry={sampleEntry}
              videoWidthPx={videoWidthPx}
              containerWidthPx={containerWidth}
            />
          )}
        </div>
      </div>

      <p className="text-body-sm text-fg-secondary">
        {t(
          'subtitleDefaults.previewNote',
          '※ 近似表示です。書き出し後の動画で最終確認してください。'
        )}
      </p>
    </div>
  )
}
