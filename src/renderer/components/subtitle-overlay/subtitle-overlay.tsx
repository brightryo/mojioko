import type { Ref } from 'react'
import { Fragment } from 'react'
import { Move } from 'lucide-react'
import type { SubtitleEntry } from '../../../shared/types'
import { ASS_MARGIN_LR_PX, SHADOW_DEPTH_MAX_PX } from '../../../shared/constants'
import { getLibassScaleFor, getCmapCoverageFor, getTofuSubstituteFor, loadSubtitleFontFor } from '@/lib/font-metrics'
import { substituteMissingGlyphs } from '../../../shared/glyph-substitute'
import { hexWithOpacity } from '../../../shared/alpha'
import { useFontCacheVersionStore } from '@/stores/font-cache-version-store'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { getFontMeta, isFontId, resolveRenderableFontId, type FontId } from '../../../shared/fonts'
import { useInstalledFontIds } from '@/lib/use-installed-fonts'
import { useAppEnvStore } from '@/stores/app-env-store'
import { canSelectFontInTier } from '@/lib/font-tier'
import { bumpRenderCount } from '@/lib/perf-counter'
import { pinnedAnchorTransform } from '@/lib/preview-coords'
import { paintOutlineLayers } from '@/lib/outline-ring'
// REQ-0311 §4 / REQ-0315 §2 — karaoke display style (adopted; default sweep).
import { sweepWordTimings } from '../../../shared/karaoke-sweep'
import { resolveKaraokeStyle, KARAOKE_STYLE_DEFAULT } from '../../../shared/karaoke-style'
import { resolveAnimation, isAnimationInert } from '../../../shared/cue-animation'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../../shared/karaoke-gate'
import { buildFallbackKaraokeUnits } from '../../../shared/karaoke-fallback'
import { resolveKaraokeTiming } from '../../../shared/karaoke-timing'
import { computeKaraokeBreaks, splitWordsAtHardBreaks } from '../../../shared/karaoke-ass'
// REQ-0332 — line spacing.  Same module the ASS writer reads.
import {
  estimateCueHeightAssPx,
  lineSpacingFactor,
  lineLeadingCorrectionAssPx,
  resolveLineSpacingPercent,
} from '../../../shared/line-spacing'
import { resolveLayer } from '../../../shared/cue-placement'
import {
  canUseKeywordEmphasisInTier,
  resolveEmphasisRanges,
  tokenizeEmphasis,
  emphasizedWordRanges,
  splitTextByLocalRanges,
  clampEmphasisScalePercent,
  cueMaxRenderedFontAssPx,
  type EmphasisRange,
  EMPHASIS_DEFAULT_COLOR,
} from '../../../shared/emphasis'
import type { WordSpan } from '../../../shared/types'

/**
 * REQ-20260614-001 補遺⑳ — empirically-derived libass line-height formula.
 *
 * Replaces the prior `STACK_LINE_HEIGHT_RATIO` knob (1.6 → 1.8 history in
 * 補遺⑬) with values measured directly from ffmpeg/libass burn-ins.
 * Test-results/metric-probe/{A..D,bord0,bord20,fs100} probed Noto Sans JP
 * SemiBold at `\fs100` / `\fs150` × `\bord0` / `\bord10` / `\bord20` ×
 * single / multiline / stack / multi+stack and matched both pitches
 * exactly:
 *
 *   - within-Dialogue line pitch (= "\N" pitch)
 *       = entry.fontSizePx        (font-independent for USE_TYPO_METRICS=false
 *                                  CJK fonts; both Noto/Dela have winAsc=1160
 *                                  winDesc=288 winHeight=1448 unitsPerEm=1000)
 *   - between-Dialogue collision gap (= libass fix_collisions padding)
 *       = 2 × entry.outlineThicknessPx
 *                                  (the gap collapses to 0 when \bord=0 and
 *                                  scales linearly with \bord; isolated by
 *                                  the bord0/bord20 probes)
 *
 * Therefore each entry's "collision-aware height" (= push offset for the
 * next stacking entry) is:
 *
 *   heightAss = lineCount × entry.fontSizePx + 2 × entry.outlineThicknessPx
 *
 * and the in-line CSS `line-height` for multi-line rendering is `1 /
 * libassScale` (= winHeight / unitsPerEm ≈ 1.448 for Noto/Dela), set inline
 * on the root `<span>` so the CSS line-box pitch matches the libass
 * within-Dialogue pitch one-to-one.
 */

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
  /**
   * REQ-20260615-038 B / REQ-20260615-039 — exposes the **inner text
   * wrapper** so the parent can measure the actual rendered text bbox
   * (drives the OBS-style position guide).  Pointing at the inner wrapper
   * — not the outer positioned span — keeps the bbox tight around the
   * glyphs in BOTH layouts:
   *
   *   - Unpinned (alignment-based) — outer span is stretched
   *     `left:margin / right:margin` so `text-align: center` has the
   *     full container width to centre against, but the rendered text
   *     itself is only as wide as its glyphs.
   *   - Pinned (`\pos`) — outer span has no `right`, so it already
   *     shrinks to the content.
   *
   * Measuring the inner span gives the same tight bbox in both cases,
   * which is what REQ-20260615-039 requires for a stable guide.
   */
  spanRef?: Ref<HTMLSpanElement>
  /**
   * REQ-20260615-038 B — when true, the drag-affordance Move icon stays
   * fully visible regardless of hover state (= the entry is being dragged
   * or is the selected entry the inspector is editing).  When false the
   * icon only appears on hover so it doesn't clutter the playback view.
   */
  showAffordance?: boolean
  /**
   * REQ-20260615-049 — exposes the **outer positioning span** so the
   * parent's requestAnimationFrame loop can write `style.opacity`
   * directly without going through React state.  Pairs with `spanRef`
   * (= inner text wrapper, REQ-20260615-039 measurement target); the
   * two refs serve different consumers and are populated independently.
   *
   * When the parent does not supply this ref the overlay renders at
   * the browser default opacity (= 1), matching the pre-fade behaviour
   * — legacy call sites such as `style-sample-preview.tsx` are unaffected.
   */
  outerSpanRef?: Ref<HTMLSpanElement>
  /**
   * REQ-0378 — the cue's animation state AT RENDER TIME, seeded into the
   * `--cue-anim-opacity` / `--cue-anim-transform` custom properties so the
   * FIRST painted frame of a playback activation already shows the animated
   * state.  Before this, opacity defaulted to the browser 1 and the transform
   * to `scale(1)` (both the SETTLED state), which flashed for one frame on
   * every activation before the imperative rAF/mount writer took over.  The
   * imperative writer overrides the same custom properties every frame, so
   * these are only the pre-first-write defaults.  Omitted (legacy call sites)
   * ⇒ settled defaults, i.e. exactly the previous behaviour.
   */
  initialOpacity?: number
  initialAnimTransform?: string
}

/**
 * REQ-20260614-001 補遺⑳ — estimate the rendered CSS-pixel height of an
 * overlay for collision-stack computation.  Pure function so the caller
 * can memoise per render.
 *
 *   heightAss = lineCount × entry.fontSizePx + 2 × entry.outlineThicknessPx
 *   return    = heightAss × scale          // ASS → CSS preview pixels
 *
 * Derivation is metric-empirical (see header block above): both terms came
 * from probing ffmpeg/libass burn-ins of Noto Sans JP at `\fs100` / `\fs150`
 * with `\bord0` / `\bord10` / `\bord20` and matched the resulting pitches
 * exactly.  The function is intentionally font-independent — the
 * dependence on `activeFontId` / `videoWidthPx` is kept in the signature
 * for API stability and for future per-font calibration (if a future
 * non-CJK font with USE_TYPO_METRICS=true is added the libass denominator
 * would shift to typoAsc+typoDesc and the per-line term would change).
 *
 * The returned value is the **collision push** used by
 * `computeFixedStackOffsets` — it is therefore the entry's lineCount-many
 * line cells PLUS the libass collision gap (`2 × outline`) so that the
 * next entry's win-box bottom lands exactly where libass would place it.
 */
export function estimateOverlayHeightPx(
  entry: SubtitleEntry,
  activeFontId: FontId,
  videoWidthPx: number,
  containerWidthPx: number,
  isMsix: boolean,
): number {
  // Per-row font override is irrelevant for the height because the line
  // pitch comes from `\fs` alone (font-independent in libass for the CJK
  // fonts in our registry), but we reference it once so the signature
  // stays meaningful and future per-font calibration has a hook.
  void activeFontId
  const scale = containerWidthPx / videoWidthPx
  // REQ-0332 — the ASS-space height moved to `shared/line-spacing.ts` so the
  // burn-in writer can feed the very same number into the very same
  // `computeFixedStackOffsets`.  It is now line-spacing aware: a tightened cue
  // must also take less room in a stack, or preview and burn-in would part
  // company the moment two cues overlap.
  // REQ-0376 §A — and emphasis-aware: an enlarged keyword makes libass reserve
  // a taller box, so the same max font (tier-gated, exactly as the emit path)
  // feeds the height or the preview under-stacks overlapping emphasised cues.
  return estimateCueHeightAssPx(entry, cueMaxRenderedFontAssPx(entry, canUseKeywordEmphasisInTier(isMsix))) * scale
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
 * Outline rendering is a CANVAS RING behind the text (REQ-0313), not a CSS
 * stroke.  `-webkit-text-stroke` is centred on the glyph, so the old model only
 * looked right while an opaque fill masked the stroke's inner half — an
 * implicit dependency that broke under REQ-0310 opacity and again under
 * REQ-0311 `\kf`.  The canvas strokes at `2 * outlinePx` and then punches the
 * glyph out with `destination-out`, leaving exactly `outlinePx` outside the
 * glyph and nothing inside, which is the shape libass paints.  See
 * `@/lib/outline-ring`.
 *
 * Outline size uses the plain container/video `scale` with NO floor: a floor
 * made thin outlines render thicker than the burn-in at small preview scales,
 * and canvas antialiases a sub-pixel ring correctly anyway.
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
  spanRef,
  showAffordance,
  outerSpanRef,
  initialOpacity,
  initialAnimTransform,
}: SubtitleOverlayProps) {
  bumpRenderCount('SubtitleOverlay')
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  // REQ-0311 §4 — experimental sweep toggle; delete with the feature.
  // REQ-0324 §4-1 — the app-wide setting is gone; a cue that has not
  // chosen a style falls back to the CONSTANT default.  Same resolver the
  // ASS writer uses, so preview and burn-in cannot disagree per cue.
  // REQ-0162 — subscribe to the font-cache version so this overlay
  // re-renders the moment ANY font finishes its opentype.js parse
  // and lands in the module-level `fontCache`.  Without this
  // subscription the first render (which happens before the async
  // load resolves) would see `getCmapCoverageFor()` return null,
  // skip REQ-0160's tofu substitution, and stay stuck on the raw
  // text — Chromium would then silently fall back to a system JP
  // font for missing glyphs.  step2's overflowMap uses the same
  // pattern (`useFontCacheVersionStore((s) => s.version)`) for the
  // measurement path; SubtitleOverlay needs the same signal for the
  // render path.  Reading the value is enough to establish the
  // subscription; the `void` discards the result to satisfy the
  // "no unused" lint.
  void useFontCacheVersionStore((s) => s.version)
  // Per-row font override (REQ-022 step 4): when the entry carries a
  // fontId, render with that family + its own libassScale.  Otherwise
  // fall back to the project default (activeFontId) so legacy rows and
  // freshly-added blank rows match what burn-in would produce.
  const requestedFontId = isFontId(entry.fontId) ? entry.fontId : activeFontId
  // REQ-0269 D-1 / REQ-0270 §2 — if the requested font (a weight in the
  // downloaded font set, typically) is not yet installed OR is
  // tier-locked (free build asking for a paid-only weight), substitute
  // a same-family installed+selectable weight, or fall back to the
  // bundled Noto SemiBold.  The ENTRY's `fontId` is intentionally NOT
  // rewritten anywhere; this is purely a render-time swap so the
  // project keeps its original weight request and the display "flips
  // back" to the correct face once the user downloads the set OR
  // upgrades to the paid build.  The `isMsix ?? false` mirrors the
  // pattern the picker components use so the pre-IPC window doesn't
  // briefly let a paid-only weight render on the free tier.
  const installedIds = useInstalledFontIds()
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false
  const resolvedFontId = resolveRenderableFontId(
    requestedFontId,
    (id) => installedIds.has(id),
    (id) => canSelectFontInTier(isMsix, id),
  )
  const fontMeta = getFontMeta(resolvedFontId)
  const libassScale = getLibassScaleFor(resolvedFontId)
  // REQ-0162 — defensive lazy load.  If the effective font's cmap
  // isn't in the cache yet (fresh download in the same session, or
  // startup load still in flight, or the App.tsx pre-loader missed
  // this font because it was installed post-mount), kick off the
  // load here.  On completion `bumpFontCacheVersion` fires and the
  // subscription above re-renders us with the populated cmap.
  // No-op when the font is already cached (`loadSubtitleFontFor`
  // returns the in-flight or cached promise).
  useEffect(() => {
    loadSubtitleFontFor(resolvedFontId).catch(() => { /* fallback stays raw */ })
  }, [resolvedFontId])
  const scale      = containerWidthPx / videoWidthPx
  const fontSizePx = entry.fontSizePx        * libassScale * scale
  // REQ-0332 — line spacing (行間), 0 % ⇒ factor 1 ⇒ nothing moves.
  const lineSpacingPercent = resolveLineSpacingPercent(entry)
  // CSS half-leading correction — see `lineLeadingCorrectionAssPx`.  Applied
  // to the top/bottom anchored branches below; centre needs none.  0 at 0 %.
  const leadingCorrectionPx = lineLeadingCorrectionAssPx(entry.fontSizePx, lineSpacingPercent) * scale
  // REQ-20260613-016 Phase 3: layout is now driven by the entry itself
  // (no more `burnin` prop).  Each entry carries its own
  // horizontalPosition / verticalPosition / verticalMarginPx — seeded by
  // Phase 1 and editable per row in Phase 4/5.
  const marginVPx  = entry.verticalMarginPx * scale
  const marginHPx  = ASS_MARGIN_LR_PX       * scale

  // Outline width (visible outside the glyph), in preview pixels.  Scaled by
  // the same `scale` as the text so the outline/glyph ratio matches the libass
  // output.
  //
  // REQ-0313 — the outline is no longer drawn by the DOM at all.  It is a
  // canvas ring painted behind the text (see `@/lib/outline-ring`), so this is
  // simply "how far the ring reaches outward", in preview px, and it no longer
  // depends on the fill in any way.
  //
  // REQ-0311's `computePreviewOutline` clamp is gone with the module: it only
  // existed because a CSS centred stroke bled inward, which the canvas ring
  // does not do.  The old `MIN_VISIBLE_OUTLINE_PX = 0.5` floor is gone too —
  // it made thin outlines render THICKER than the burn-in at small preview
  // scales, which is exactly the parity REQ-0313 asks for; canvas antialiases
  // sub-pixel strokes properly, so the floor is no longer buying legibility.
  const outlinePx = Math.max(0, entry.outlineThicknessPx * scale)

  // REQ-20260613-016 Phase 6 — pinned rows render at their own ASS-space
  // (posX, posY), independent of MarginV / alignment.  The alignment
  // still drives the anchor (which corner of the text box sits at the
  // pinned point), implemented via CSS transform.
  const isPinned = entry.posX !== undefined && entry.posY !== undefined

  // REQ-20260614-001 補遺⑲ Phase 1 — `stackOffsetPx` is the collision
  // offset BEYOND `entry.verticalMarginPx`, in **CSS preview pixels**.
  //
  // The value comes from `computeFixedStackOffsets` whose `heightOf` is
  // `estimateOverlayHeightPx` — which already multiplies by `scale`, so
  // it is delivered in CSS preview pixels and must NOT be scaled again.
  //
  // REQ-0322 §1 — this comment previously read "…when computing
  // `renderedFontSizePx = fontSizePx * libassScale * scale`", which was
  // wrong and made `estimateOverlayHeightPx` look like it was missing a
  // `libassScale` factor.  It is not missing one.  The two quantities are
  // different: `fontSizePx` (line 282) is the CSS **font-size**, whereas
  // the stack step is the CSS **line box height**, and libassScale
  // cancels between them —
  //
  //     lineBox = fontSizePx_css × lineHeight
  //             = (fs × libassScale × scale) × (1 / libassScale)
  //             = fs × scale                    ← what the estimator returns
  //
  // (`lineHeight = 1 / libassScale`, line 441).  Applying libassScale
  // inside the estimator would shrink every stack step by a uniform
  // 30.94 % (e.g. fs=80 / 2 lines / 2nd row: 33.60px → 23.20px at
  // scale 0.2), reintroducing the very overlap described below.
  // The earlier code multiplied by `scale` a second time here, which
  // collapsed the stack offset to a fifth of its intended value at the
  // typical preview scale ≈0.2 and caused stacked captions to overlap
  // ("ゴースト気味") in the preview while the burn-in (libass) stacked
  // them correctly.  See RES-20260614-001-followup18 §C-6 for the unit
  // trace.
  //
  // `marginVPx` is the entry's own MarginV converted ASS→CSS (line 189),
  // so the two terms now share the CSS-pixel space and add directly.
  // When undef → 0 → standalone caption sits at its own MarginV exactly.
  // Pinned rows skip stack offset entirely (excluded from
  // computeFixedStackOffsets per Phase 3).
  const stackOffset = stackOffsetPx ?? 0

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
    if (entry.verticalPosition === 'bottom') {
      vStyle = { bottom: `${marginVPx + stackOffset - leadingCorrectionPx}px` }
      transform = undefined
    } else if (entry.verticalPosition === 'center') {
      // REQ-0140 — center-aligned rows anchor at the viewport middle
      // and ignore verticalMarginPx (mirrors libass `\an4/5/6` which
      // has no MarginV reference edge).  Stack offsets shift the anchor
      // downward from centre for later same-group simultaneous entries;
      // `computeFixedStackOffsets` returns a relative offset that is 0
      // for the first entry in a centre group.
      vStyle = { top: '50%' }
      transform = `translateY(calc(-50% + ${stackOffset}px))`
    } else {
      vStyle = { top: `${marginVPx + stackOffset - leadingCorrectionPx}px` }
      transform = undefined
    }
    hStyle = { left: `${marginHPx}px`, right: `${marginHPx}px`, textAlign }
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

  // REQ-0277 §4 — compose transform stack.  Rotation is user-chosen
  // clockwise degrees; CSS's `rotate()` is also clockwise so no
  // negation is needed (ass-generator on the burn-in side handles the
  // ASS `\frz` counter-clockwise convention separately).  Applied
  // BEFORE the layout-side transforms above so rotation stacks on top
  // of pinned-anchor / centre-translate offsets.  When `rotation ===
  // undefined` OR `0` no extra transform is added.
  const rotationDeg = entry.rotation ?? 0
  // REQ-0323 §1-3 — does this cue's animation change `scale`?  Only then
  // does the transform origin need to move off its historical value.
  const animSpecForOrigin = resolveAnimation(entry)
  const animScales = !isAnimationInert(animSpecForOrigin)
    && (animSpecForOrigin.type === 'scale' || animSpecForOrigin.type === 'pop')
  if (rotationDeg !== 0) {
    const rotateFrag = `rotate(${rotationDeg}deg)`
    transform = transform ? `${transform} ${rotateFrag}` : rotateFrag
  }

  // REQ-0277 §2 — drop shadow.  libass draws shadows at a fixed
  // bottom-right offset with depth = both X and Y translation in
  // pixels.  CSS's `text-shadow: <x> <y> <blur> <color>` mirrors that
  // exactly (positive x = right, positive y = down, same as libass).
  // Scale the depth by the preview `scale` factor so the shadow
  // shrinks proportionally as the preview viewport does — mirrors the
  // way `strokeWidthPx = outlinePx * 2` scales the CSS-side outline.
  // Skipped when the background box is enabled (matches ass-generator's
  // `\shad0` suppression on the bg path).
  // REQ-0293 §1 — shadow is gated on `depth > 0` (not the removed
  // `shadowEnabled` boolean).  The bg-box path suppresses shadow as
  // before because the box would otherwise carry an unwanted
  // drop-shadow around its rectangle.  Clamp uses
  // `SHADOW_DEPTH_MAX_PX` (= 50) — same ceiling as the ass-generator
  // clamp so preview and burn-in stay in sync at the new range.
  // The `* scale` keeps the shadow proportional to preview zoom so
  // large depths shrink alongside the type as the viewport does.
  const shadowDepthClamped = Math.max(0, Math.min(SHADOW_DEPTH_MAX_PX, entry.shadowDepth ?? 0))
  const shadowActive = shadowDepthClamped > 0 && !bgEnabled
  const shadowDepthPx = shadowActive ? shadowDepthClamped * scale : 0
  // REQ-0313 — the shadow canvas takes an OPAQUE colour and the canvas ELEMENT
  // carries the alpha.  Baking alpha into the fill would darken every place two
  // glyphs' shadows overlap, which libass never does.
  const shadowColorOpaque = entry.shadowColor ?? '#000000'
  const shadowAlpha01 = Math.max(0, Math.min(1, (entry.shadowAlpha ?? 100) / 100))

  // REQ-0278 — glow (3-layer text-shadow stack) was removed here.
  // See SPECIFICATION.md §11 for the deletion rationale.
  // REQ-0313 — the CSS `text-shadow` builders are gone with the DOM stroke;
  // the shadow is painted on its own canvas below the ring.

  // REQ-20260613-016 Phase 6 — when the parent supplies onPointerDown the
  // overlay becomes interactive: cursor=move, pointer-events-auto, and the
  // raw pointer-down event is forwarded with the bound entry so the
  // parent can start its drag bookkeeping.  When undef the overlay stays
  // strictly visual.
  const interactive = onPointerDown !== undefined

  // REQ-20260614-001 補遺⑳ — CSS line-height set to `1 / libassScale`
  // (= winHeight / unitsPerEm ≈ 1.448 for Noto/Dela).  This makes the
  // browser's line-box pitch match the libass within-Dialogue `\N` pitch
  // exactly (= fontSize ASS px per line), so multi-line previews stack
  // their internal lines the same way the burn-in does.  Replaces the
  // prior `leading-snug` (= 1.375) which left a measurable gap.
  //
  // REQ-0332 — line spacing scales that pitch.  It multiplies the line-height
  // ONLY, so the libassScale cancellation the stack estimator depends on
  // (REQ-0322 §1 / REQ-0324 §4-2) survives untouched:
  //
  //     line box = (fs × libassScale × scale) × (1 / libassScale) × factor
  //              = fs × scale × factor
  //
  // which is exactly `estimateCueHeightAssPx`'s per-line term times `scale`.
  // At 0 % the factor is 1 and this is the pre-REQ-0332 expression.
  const lineHeight = (libassScale > 0 ? 1 / libassScale : 1.448) * lineSpacingFactor(lineSpacingPercent)

  // REQ-20260615-049 — preview-side fade is no longer computed here.
  // The parent runs a single requestAnimationFrame loop that reads the
  // real video element's currentTime and writes `style.opacity` on the
  // outer span via DOM, decoupling the ramp from React re-renders.
  // That keeps the animation smooth (vsync-aligned, not timeupdate-
  // bound), keeps fade-out visible at unmount time, and survives the
  // resize-cascade re-renders that froze the prior REQ-20260615-048
  // implementation on maximize.  The outer span exposes itself through
  // `outerSpanRef`; nothing else is needed in the overlay itself.

  // REQ-20260615-038 B — drag affordance.  An empty-content `<span>` child
  // positioned `inset: 0` becomes a centered overlay covering the outer
  // span's box (the parent is `position: absolute` → established containing
  // block).  Pointer-events-none so it never intercepts the drag pointer
  // that the outer span already binds; the icon is purely a visual hint.
  // Default opacity 0; `group-hover` raises to 60% on hover, and
  // `showAffordance` forces it visible during drag / when the inspector is
  // editing this row.  Icon size is derived from the rendered font height so
  // it stays proportionate at every preview scale.
  const moveIconPx = Math.max(14, Math.min(48, fontSizePx * 0.55))
  // REQ-0160 — replace code points not in the effective font's cmap with
  // that font's tofu substitute (□ for most, "?" for the very few Latin
  // faces that lack □).  Preview and burn-in must apply the same
  // transform so the visible output stays consistent and
  // overflow-calculator / auto-line-break measure the same characters
  // libass will render.  When the font hasn't finished loading, the
  // cmap set is null → substitution is a no-op and preview still
  // shows the browser's fallback until the next font-cache bump
  // triggers a re-render.  entry.text (the user's persisted original)
  // is never mutated.
  const cmapCoverage = getCmapCoverageFor(resolvedFontId)
  const tofuSubstitute = getTofuSubstituteFor(resolvedFontId)
  const rawText = entry.text.replace(/\\N/g, '\n')
  const renderedText = cmapCoverage !== null && tofuSubstitute !== null
    ? substituteMissingGlyphs(rawText, cmapCoverage, tofuSubstitute)
    : rawText

  // REQ-0286 §0 / REQ-0289 — karaoke gate: paid tier
  // (`canUseKaraokeInTier`) + per-cue toggle-on.  When the gate passes
  // we resolve a `WordSpan[]` to render: real `entry.words` if they
  // still align with `text` (Whisper timing), otherwise the
  // equal-split fallback from `buildFallbackKaraokeUnits`.
  // `karaokeActive` is only false when the toggle is off, the tier
  // check fails, or the cue text has zero splittable units — those
  // cases fall through to the pre-REQ-0286 plain-text render path.
  // The parent's rAF loop (video-preview-panel.tsx) reads
  // `data-karaoke-word-idx` attributes and writes span colours
  // directly via the DOM regardless of which resolution path fed the
  // spans.
  const karaokeGateOn = entry.karaokeEnabled === true && canUseKaraokeInTier(isMsix)
  // REQ-0336 §1-6 — WHICH timings drive the sweep comes from the one shared
  // resolver the ASS writer also calls.  `areWordsValidForText` alone (a
  // text-only predicate) left a cue whose times had been dragged rendering
  // from word timestamps that no longer fell inside its own window — the
  // preview lit nothing, or stopped part-way, and the burn matched it.
  const karaokeUsesRealWords = resolveKaraokeTiming(entry).mode === 'words'
  // REQ-0308 §1 — `splitWordsAtHardBreaks` gives every `\N` in the cue text a
  // unit boundary to attach to.  Without it a break landing mid-word (the norm
  // for Japanese, where REQ-0303 does NOT protect word boundaries) was silently
  // dropped by `computeKaraokeBreaks` and this overlay rendered FEWER lines
  // than `entry.text` contains — the cue overflowed the frame while the editor
  // and the table showed the wrapped text.  The ass-generator applies the same
  // split, so preview and burn-in stay in agreement.  A no-op (same array
  // reference) for cues whose breaks already sit on unit boundaries.
  const karaokeWords: readonly WordSpan[] = karaokeGateOn
    ? splitWordsAtHardBreaks(
        entry.text,
        karaokeUsesRealWords
          ? entry.words!
          : buildFallbackKaraokeUnits(entry.text, entry.startSec, entry.endSec),
      )
    : []
  const karaokeActive = karaokeWords.length > 0
  // REQ-0311 §4 / REQ-0322 §3 — sweep (`\kf`) vs switch (`\k`), resolved
  // PER CUE with the settings value as the default.  Timings come from the
  // SAME helper the emitter uses, so preview and burn-in cannot drift.
  const karaokeStyle = resolveKaraokeStyle(entry.karaokeStyle, KARAOKE_STYLE_DEFAULT)
  const sweepActive = karaokeActive && karaokeStyle === 'sweep'
  const sweepTimings = sweepActive
    ? sweepWordTimings(karaokeWords, entry.startSec, entry.endSec)
    : []
  // REQ-0294 — compute the same word-index → break-before-me set the
  // ass-generator uses so the preview inserts `<br>` at the same word
  // boundaries libass wraps at.  Empty set for single-line cues, so
  // no-break cues render identically to the pre-REQ-0294 output.  The
  // break computation runs on the RAW cue text (`entry.text`) + raw
  // words because the character-index invariant with
  // `areWordsValidForText` holds on the pre-substitution shape;
  // substitution below preserves the word COUNT, so break indices
  // stay valid.
  const karaokeBreaks = karaokeActive
    ? computeKaraokeBreaks(entry.text, karaokeWords)
    : new Set<number>()
  // REQ-0297 §2 — apply the same tofu-substitution to each karaoke
  // word's text that the plain path (`renderedText` above) applies
  // to the cue text.  Pre-REQ-0297 the karaoke render walked
  // `karaokeWords.map(w => w.text)` verbatim, letting raw JA
  // codepoints reach the browser under a Latin-only font — where
  // the browser's system-font fallback drew them in Yu Gothic / etc.
  // instead of the promised tofu (□ / ?).  Substituting per-word
  // preserves the per-word timing (each word keeps its own
  // startSec + break position) while forcing every unsupported
  // codepoint to a font-native placeholder — matches the plain
  // render and the burn-in tofu-substitution in
  // `services/burnin.ts`.
  const karaokeWordsRendered = karaokeActive && cmapCoverage !== null && tofuSubstitute !== null
    ? karaokeWords.map((w) => {
        const substituted = substituteMissingGlyphs(w.text, cmapCoverage, tofuSubstitute)
        return substituted === w.text ? w : { ...w, text: substituted }
      })
    : karaokeWords
  const karaokeHighlightColorResolved = entry.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR
  // REQ-0293 §2 — base (unspoken) colour is ALWAYS `textColorHex`.
  // The pre-REQ-0293 per-cue `karaokeBaseColor` override was removed;
  // the karaoke sweep now simply swaps between "the cue's own text
  // colour" (base) and the user-picked accent (highlight).  Same
  // rule mirrored in ass-generator's `\2c` emit + the rAF loop's
  // base-colour resolution in video-preview-panel.
  // REQ-0310 — the karaoke base (unspoken) half carries the cue's text opacity,
  // mirroring the ass-generator's `\2a`.  The SPOKEN half stays opaque, which is
  // what makes "text opacity 0 + karaoke" read as words appearing as they are
  // spoken.  The parent's rAF loop resolves the same pair of colours.
  const karaokeBaseColorResolved = hexWithOpacity(entry.textColorHex, entry.textAlpha)
  // Silence "declared but never read" during the initial render — the
  // parent's rAF loop consumes the highlight colour via the entry
  // Map, not through a prop from here.  Keeping the local const
  // documents the resolution rule alongside the base colour.
  void karaokeHighlightColorResolved

  // REQ-0307 — keyword emphasis (anchored character spans).  Gate = per-cue
  // toggle-on + free-tier gate.  `resolveEmphasis` migrates the legacy
  // REQ-0305 word indices / REQ-0306 keyword list and resolves each span
  // against the CURRENT text, so emphasis survives edits, works on cues with
  // no / invalid `words`, and hits only the occurrence the user picked.  Same
  // helper the ass-generator calls — that shared resolution is what keeps
  // preview and burn-in in agreement.
  const emphasisGateOn = entry.keywordEmphasisEnabled === true && canUseKeywordEmphasisInTier(isMsix)
  const emphasisRanges = emphasisGateOn ? resolveEmphasisRanges(entry) : []
  const emphasisActive = emphasisRanges.length > 0
  const emphasisEm = clampEmphasisScalePercent(entry.emphasisScalePercent) / 100
  const emphasisColorResolved = entry.emphasisColorHex ?? EMPHASIS_DEFAULT_COLOR
  // REQ-0307 §4 — emphasis ranges projected onto the karaoke word units at
  // CHARACTER granularity.  Drives the per-run grow + Option-A colour in the
  // karaoke render below, splitting a word when a span covers only part of it.
  const emphasisKaraokeRanges = emphasisActive && karaokeActive
    ? emphasizedWordRanges(entry.text, karaokeWords, emphasisRanges)
    : new Map<number, EmphasisRange[]>()
  // Standalone emphasis render (karaoke OFF): tokenise the cue text into
  // emphasised / plain runs (+ `\N` breaks) so each run gets its own colour +
  // size.  When karaoke is ON, emphasis rides on the karaoke word spans below.
  const emphasisRenderActive = !karaokeActive && emphasisActive
  const emphasisTokens = emphasisRenderActive ? tokenizeEmphasis(entry.text, emphasisRanges) : []

  // REQ-20260615-039 — always wrap the visible text in this inline span so
  // the parent's position-guide measurement is consistent across layouts.
  // The `display: inline` (default) keeps inline flow identical to writing
  // the text node directly; the wrapper only exists to give the guide a
  // tight DOM rect that ignores the outer span's full-width text-align
  // container in the unpinned case.  When the row has a background, the
  // same wrapper carries the bg styles (per-line clone via
  // `box-decoration-break: clone`).
  // REQ-0313 — `position: relative` + `zIndex: 1` puts the text ABOVE the two
  // outline canvases.  Absolutely-positioned siblings otherwise paint over
  // inline content regardless of DOM order, and a negative z-index on the
  // canvases would risk dropping them behind an ancestor's background whenever
  // the outer span happens not to create a stacking context.  `relative` does
  // not alter inline layout.
  // REQ-0333 §2 — the background box is PER DISPLAY LINE, and that is load
  // bearing.  `display: inline` means the background covers the font's
  // CONTENT AREA (ascent + descent), not the line box, and
  // `box-decoration-break: clone` repeats it on every line fragment.  So the
  // boxes separate as line spacing rises and overlap as it falls — which is
  // exactly what libass does with `BorderStyle=3` once REQ-0332 splits a
  // spaced cue into per-line events.  Measured at −50 / 0 / +100 %: same band
  // count, same 200-px pitch, same gap (see
  // `tests/unit/overlay-bg-per-line-box-req-0333.test.ts`).  Switching this to
  // `inline-block`, or dropping `clone`, silently produces ONE continuous box
  // and the preview stops matching the burn at every non-zero spacing.
  //
  // REQ-0340 §1 — the box's PADDING is `\bord`, and `\bord` is the outline
  // width slider.  It used to be the constant `2px 6px`, which happens to be
  // close at the default outline (3) and wrong everywhere else.  Measured, box
  // edge minus glyph ink edge, top edge, at PlayRes = frame:
  //
  //     outline |   4     9    20
  //     burn    | 33.08 38.08 49.08   -> exactly `bord + 29.08`
  //     preview | 31.00 31.00 31.00   -> constant; error 2, 7, 18 px
  //
  // The left edge does the same with its own constant (`bord + 6.4` vs a flat
  // 12.44).  So the two agreed only where the two constants crossed — bord 2
  // vertically, bord 6 horizontally — and the preview under-drew the box by up
  // to 18 px per edge at the top of the slider.  Driving the padding from
  // `outlinePx` (already `entry.outlineThicknessPx * scale`) makes both sides
  // `bord + <same constant>` and they track at every width.  Line spacing is
  // unaffected by this: at −50 / 0 / +100 % the burn's band count, 200-px pitch
  // and merge/split behaviour already matched, and only the padding differed.
  //
  // `outlinePx === 0` draws NO box, because that is what libass does: under
  // `BorderStyle=3` the "box" is the glyph outline grown by `\bord`, so at 0 it
  // collapses onto the glyph and is hidden beneath it.  Measured: zero white
  // pixels in the burn at `\bord0`, against 28,034 in the preview.  (That the
  // background box therefore VANISHES from an export whenever the user has the
  // outline at 0 is a product question, not a parity one — recorded in
  // RES-0340 rather than fixed here.)
  //
  // The 2 px `borderRadius` is gone for the same reason: libass' box has
  // square corners.
  const bgBoxVisible = bgEnabled && outlinePx > 0
  const textWrapperStyle: React.CSSProperties = bgBoxVisible
    ? {
        position:                 'relative',
        zIndex:                   1,
        display:                  'inline',
        backgroundColor:          bgColor,
        padding:                  `${outlinePx}px`,
        boxDecorationBreak:       'clone',
        WebkitBoxDecorationBreak: 'clone',
      }
    : { position: 'relative', zIndex: 1, display: 'inline' }
  // REQ-0313 — canvas outline ring.  Painted from the LIVE DOM layout rather
  // than a second text-layout implementation: `measureRuns` reads each run's
  // rect and computed font, so line breaks, emphasis size changes, tofu
  // substitution and the preview scale are all inherited for free and cannot
  // drift from what the user sees.
  //
  // Runs in a layout effect (after DOM mutation, before paint) so the ring is
  // never one frame behind the text.  It does NOT run per playback frame: the
  // karaoke/fade rAF writes styles directly via the DOM and never re-renders
  // this component, so colour changes cost nothing here.
  const outerElRef = useRef<HTMLSpanElement | null>(null)
  const ringCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const shadowCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const measureCtxRef = useRef<CanvasRenderingContext2D | null>(null)

  function setOuterRef(el: HTMLSpanElement | null) {
    outerElRef.current = el
    if (typeof outerSpanRef === 'function') outerSpanRef(el)
    else if (outerSpanRef) (outerSpanRef as React.MutableRefObject<HTMLSpanElement | null>).current = el
  }

  useLayoutEffect(() => {
    const outer = outerElRef.current
    const ringCanvas = ringCanvasRef.current
    const shadowCanvas = shadowCanvasRef.current
    if (!outer || !ringCanvas || !shadowCanvas) return
    if (!measureCtxRef.current) {
      measureCtxRef.current = document.createElement('canvas').getContext('2d')
    }
    const mctx = measureCtxRef.current
    if (!mctx) return

    // REQ-0328 §1 — the procedure itself lives in `outline-ring.ts` so that
    // `scripts/verify-ring-paint` drives THE SAME CODE in a real Electron
    // window and measures the pixels it produces.  That gate used to run a
    // hand-ported COPY of this body; two copies of one procedure drift, and a
    // drifted harness stays green while production breaks.  What stays here is
    // React-specific: obtaining the refs, the layout-effect timing, and the
    // deliberately absent dependency array.
    //
    // The transform neutralisation moved WITH the procedure — see
    // `paintOutlineLayers` for why it is unconditional (REQ-0326 §1-2).  It has
    // to live inside the shared function, or the harness's negative control
    // would only be perturbing a copy of the code production runs.
    //
    // Why that matters HERE: this effect has no dependency array, so it runs
    // after EVERY render, and `video-preview-panel` re-renders this component
    // from `onTimeUpdate` while the entrance animation is playing — i.e. the
    // measurement genuinely does happen with a live `scale()` on the span.
    paintOutlineLayers({
      outer,
      ringCanvas,
      shadowCanvas,
      measureCtx: mctx,
      outlinePx: showOutline && outlinePx > 0 ? outlinePx : 0,
      outlineColorOpaque: entry.outlineColorHex,
      outlineOpacity01: (entry.outlineAlpha ?? 100) / 100,
      shadowOffsetPx: shadowActive && shadowDepthPx > 0 ? shadowDepthPx : 0,
      shadowColorOpaque,
      shadowOpacity01: shadowAlpha01,
      dpr: window.devicePixelRatio || 1,
    })

  })

  return (
    <span
      ref={setOuterRef}
      className={
        interactive
          ? 'absolute pointer-events-auto cursor-move select-none group'
          : 'absolute pointer-events-none'
      }
      onPointerDown={interactive
        ? (e) => onPointerDown!(e, entry)
        : undefined}
      // REQ-0339 §1/§2 — "this cue has an outline bitmap", from the SAME
      // expression that feeds `paintOutlineLayers` below, so the two cannot
      // disagree.  `cue-blur-layer` needs the answer during the commit phase,
      // before the layout effect has sized the ring canvas; without this
      // attribute the blur would land on the whole composite for exactly the
      // cue's first frame — the case REQ-0339 §2 exists to remove.
      {...(showOutline && outlinePx > 0 ? { 'data-cue-outlined': '' } : {})}
      style={{
        ...vStyle,
        ...hStyle,
        // REQ-0392 — z-order: CSS z-index mirrors the ASS Dialogue Layer column
        // (higher = in front).  Overlays with equal z-index fall back to DOM
        // paint order (later on top), matching libass' same-layer tie-break, so
        // preview and burn agree.  Default 0 = today's behaviour.
        zIndex: resolveLayer(entry),
        fontFamily: `'${fontMeta.cssFontFamily}'`,
        fontWeight: fontMeta.weight,
        // REQ-0323 §1-3 — animation transform layer.
        //
        // React owns the BASE transform (pinned-anchor offset, rotation);
        // the rAF loop owns the animation and writes ONLY the custom
        // property `--cue-anim-transform`.  Composing them through a
        // `var()` keeps the two writers off each other's toes — a rAF
        // that assigned `style.transform` directly would be clobbered on
        // every React re-render, and vice versa.
        //
        // Crucially this transform sits on the OUTER span, which contains
        // both outline canvases AND the text wrapper, so the painted ring is
        // composited along with the glyphs — the same trick rotation relies
        // on.  Measured in REQ-0326 §1-2: dx = 0.00px at every scale and
        // thickness tracks S within 3%.
        //
        // CORRECTION (REQ-0326 §1-2): an earlier version of this comment
        // claimed `measureRuns` is never re-run.  That is FALSE — the ring
        // layout effect has no dependency array and re-runs on every render.
        // What makes that safe is the unconditional transform neutralisation
        // in that effect, not the absence of re-measurement.
        // REQ-0378 — seed the animation custom properties from the cue's state
        // AT RENDER TIME so the first painted frame of a playback activation is
        // already the animated state, not the settled default (which flashed
        // for one frame).  The rAF/mount writer overrides these every frame.
        // Omitted props (legacy call sites) fall back to the settled defaults.
        ['--cue-anim-transform' as string]: initialAnimTransform ?? 'translate(0px, 0px) scale(1)',
        ['--cue-anim-opacity' as string]: initialOpacity ?? 1,
        opacity: 'var(--cue-anim-opacity, 1)',
        // Scale from the cue's own alignment anchor so the text grows in
        // place.  libass scales `\fscx\fscy` about the `\an` anchor, so
        // matching the origin to the alignment is the parity-correct
        // choice — a default 50%/50% origin would drift a left- or
        // right-aligned cue sideways as it scaled.

        fontSize:   `${fontSizePx}px`,
        lineHeight,
        // REQ-0286 — when karaoke is active, per-word spans set their
        // own colour (parent rAF drives highlight vs base).  The outer
        // span's `color` becomes a fallback (used for any text not
        // wrapped by a word span, which in practice is none).  We set
        // the outer to base colour so any residual leaves the cue
        // consistent with "unspoken words are base colour" until the
        // rAF paints its first frame.
        // REQ-0310 — both colours carry their own opacity (`\1a` / `\2a` and
        // `\3a` on the burn-in side).  `hexWithOpacity` returns the plain hex
        // unchanged at 100 %, so an untouched cue emits exactly the CSS it did
        // before.
        color:      karaokeActive
          ? karaokeBaseColorResolved
          : hexWithOpacity(entry.textColorHex, entry.textAlpha),
        // REQ-0313 — NO `-webkit-text-stroke` here, deliberately.  The outline
        // is a canvas ring behind this text.  A CSS stroke is centred on the
        // glyph, so it only looked correct while an opaque fill masked its
        // inner half; that assumption broke under REQ-0310 opacity and again
        // under REQ-0311 `\kf` (whose `background-clip: text` fill paints
        // BELOW a stroke and so cannot mask at all).  Keeping the outline out
        // of the text's own paint makes it independent of the fill technique.
        whiteSpace: 'pre',
        // REQ-0323 §1-3 — compose the rAF-owned animation layer with the
        // React-owned base (pinned anchor / centre-translate / rotation).
        // Animation first so it acts in the element's own frame before the
        // layout offsets move it into place.
        transform: `var(--cue-anim-transform) ${transform ?? ''}`.trim(),
        // Rotation keeps its pre-REQ-0323 `center center` origin so rotated
        // cues render exactly as before.  Otherwise, when a SCALING
        // animation is active, scale about the cue's alignment anchor —
        // libass scales `\fscx\fscy` about the `\an` anchor, so matching it
        // is the parity-correct choice (a 50%/50% origin would drift a
        // left- or right-aligned cue sideways as it grew).
        // Known limitation: a cue with BOTH rotation and a scale animation
        // gets the rotation origin; the two want different anchors and one
        // property has to win.
        transformOrigin: rotationDeg !== 0
          ? 'center center'
          : animScales
            ? `${
                entry.horizontalPosition === 'left' ? '0%'
                : entry.horizontalPosition === 'right' ? '100%' : '50%'
              } ${
                entry.verticalPosition === 'top' ? '0%'
                : entry.verticalPosition === 'bottom' ? '100%' : '50%'
              }`
            : undefined,
        // REQ-0277 §1 — CSS `text-transform: uppercase` handles Latin
        // case-mapping natively; CJK code points have no case and pass
        // through unchanged.  Matches ass-generator's `.toUpperCase()`
        // on the emitted text.
        textTransform: entry.casing === 'uppercase' ? 'uppercase' : undefined,
        // REQ-0277 §2 — drop shadow.  Renders as a single CSS
        // `text-shadow` when shadow is enabled AND the row has no bg
        // box; `undefined` otherwise.  Glow used to layer additional
        // shadows on top of this line (REQ-0277 §3) but was removed
        // in REQ-0278 — see SPECIFICATION.md §11 for why.
        // REQ-0313 — shadow moved to its own canvas beneath the ring so the
        // libass paint order (shadow -> outline -> fill) survives; a DOM
        // `text-shadow` would paint above the ring canvas.
        // `opacity` is intentionally NOT set here — see comment above
        // the prop list; the parent's rAF loop writes it via DOM API
        // and React never touches the value.
      }}
    >
      {/* REQ-0313 — outline ring + drop shadow.  Two canvases so each keeps its
          own alpha and so the libass paint order (shadow, outline, fill) holds:
          shadow first in DOM, then the ring, then the text above both via the
          wrapper's z-index.  `width`/`height` start at 0 and are sized by the
          layout effect; a cue with neither effect leaves them at 0 and paints
          nothing. */}
      <canvas
        ref={shadowCanvasRef}
        aria-hidden="true"
        width={0}
        height={0}
        className="absolute pointer-events-none"
      />
      <canvas
        ref={ringCanvasRef}
        aria-hidden="true"
        width={0}
        height={0}
        className="absolute pointer-events-none"
      />
      {/* REQ-0286 §3 — karaoke render.  When karaoke is active
          (paid tier + toggle-on + words-valid), we split the cue into
          per-word `<span>` elements carrying `data-karaoke-word-idx`
          + `data-karaoke-word-start-sec`.  The parent's rAF loop
          (video-preview-panel.tsx) walks these spans on each frame
          and sets their `style.color` directly via the DOM.  If no
          rAF driver runs (e.g. style-sample-preview), the spans
          render in their default color (= base colour) — a static
          "unspoken" preview, which is a reasonable fallback for a
          non-playback context.  All karaoke word.text values keep
          faster-whisper's leading spaces so the rendered token
          spacing matches natural word wrap.
          REQ-0294 — the cue's `\N` breaks ARE now applied: a `<br>`
          is inserted before every word whose index is in
          `karaokeBreaks` (same set the ass-generator uses for its
          `\N` emit), and the leading whitespace of that word is
          stripped so line 2 doesn't render an indent.  Karaoke ON
          and OFF therefore wrap at the same positions.
          When karaoke is inactive, we render the pre-REQ-0286
          single-text-node path unchanged (RES-0286 §4 fallback). */}
      {karaokeActive ? (
        <span
          ref={spanRef}
          data-karaoke-cue-id={entry.id}
          data-subtitle-text-wrapper="" style={textWrapperStyle}
        >
          {/* REQ-0289 — `karaokeWords` is the resolved WordSpan[] —
              either the real per-word list (Whisper timing) or the
              equal-split fallback units.  Same DOM shape either way
              so the parent's rAF loop drives both without a code
              path change. */}
          {karaokeWordsRendered.map((w, i) => {
            const brokenHere = karaokeBreaks.has(i)
            const wordText = brokenHere ? w.text.replace(/^\s+/, '') : w.text
            // REQ-0306 §3 (Option A) / REQ-0307 §4 — emphasised karaoke text
            // grows AND, when spoken, lights up in the emphasis colour.  A
            // span may cover only part of a word, so the word is split into
            // runs and EACH run gets its own span.  Every run keeps the same
            // `data-karaoke-word-idx` + `-start-sec`, so the rAF loop in
            // video-preview-panel (which iterates spans, not indices) lights
            // them all at the same instant — mirroring how libass treats the
            // whole `\k` block as one syllable.  Size is static here; the
            // spoken/unspoken colour comes from `data-karaoke-emph-color`.
            const localRanges = emphasisKaraokeRanges.get(i)
            const runs = localRanges && localRanges.length > 0
              ? splitTextByLocalRanges(wordText, localRanges)
              : [{ text: wordText, emphasized: false }]
            // REQ-0311 §4 — sweep mode wraps each word's runs in a positioned
            // box so the rAF loop can give every run a gradient sized and
            // offset to the WHOLE word.  That keeps the fill continuous across
            // an emphasised run boundary (libass treats the word as one `\kf`
            // syllable) while each run keeps its own spoken colour.  In switch
            // mode no wrapper is emitted, so the shipping `\k` DOM is
            // byte-identical to pre-REQ-0311.
            const runSpans = runs.map((run, r) => (
              <span
                key={r}
                data-karaoke-word-idx={i}
                data-karaoke-word-start-sec={w.startSec}
                data-karaoke-word-dur-sec={sweepActive ? sweepTimings[i]?.durationSec : undefined}
                data-karaoke-emph-color={run.emphasized ? emphasisColorResolved : undefined}
                style={{
                  // REQ-0474 §1 (Option A) — an emphasised karaoke run paints
                  // its emphasis colour on the FIRST frame too (the rAF driver
                  // keeps it there every frame).  A non-emphasised run starts at
                  // the base colour and the driver sweeps it.
                  color: run.emphasized ? emphasisColorResolved : karaokeBaseColorResolved,
                  fontSize: run.emphasized ? `${emphasisEm}em` : undefined,
                }}
              >
                {run.text}
              </span>
            ))
            return (
              <Fragment key={i}>
                {brokenHere && <br />}
                {sweepActive ? (
                  <span data-karaoke-word-box={i} style={{ position: 'relative' }}>
                    {runSpans}
                  </span>
                ) : (
                  runSpans
                )}
              </Fragment>
            )
          })}
        </span>
      ) : emphasisRenderActive ? (
        /* REQ-0306 — karaoke OFF, emphasis ON.  Tokenise the cue text into
           emphasised / plain runs (+ `\N` breaks) and paint emphasised runs
           in the emphasis colour + size.  No `data-karaoke-*` attributes so
           the rAF karaoke driver never touches these spans.  Tofu
           substitution is applied per run (REQ-0297). */
        <span ref={spanRef} data-subtitle-text-wrapper="" style={textWrapperStyle}>
          {emphasisTokens.map((tok, i) => {
            if (tok.kind === 'break') return <br key={i} />
            const shown = cmapCoverage !== null && tofuSubstitute !== null
              ? substituteMissingGlyphs(tok.text, cmapCoverage, tofuSubstitute)
              : tok.text
            return (
              <span
                key={i}
                style={
                  tok.emphasized
                    ? { color: emphasisColorResolved, fontSize: `${emphasisEm}em` }
                    : undefined
                }
              >
                {shown}
              </span>
            )
          })}
        </span>
      ) : (
        <span ref={spanRef} data-subtitle-text-wrapper="" style={textWrapperStyle}>
          {renderedText}
        </span>
      )}
      {interactive && (
        <span
          aria-hidden="true"
          className={
            'absolute inset-0 flex items-center justify-center pointer-events-none transition-opacity duration-150 ' +
            (showAffordance
              ? 'opacity-70'
              : 'opacity-0 group-hover:opacity-60')
          }
          style={{
            // REQ-0413 — icon colour centralised (globals.css --affordance-fg).
            // The drop shadows stay inline: they are effect values, outside
            // this REQ's colour / font-size tokenisation scope.
            color: 'var(--affordance-fg)',
            textShadow: '0 0 6px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.85)',
            filter: 'drop-shadow(0 0 4px rgba(0,0,0,0.85))',
          }}
        >
          <Move style={{ width: `${moveIconPx}px`, height: `${moveIconPx}px` }} />
        </span>
      )}
    </span>
  )
}
