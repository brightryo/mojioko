import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground, WordSpan } from '../../shared/types'
import { ASS_MARGIN_LR_PX, SHADOW_DEPTH_MAX_PX } from '../../shared/constants'
import { getFontMeta, isFontId } from '../../shared/fonts'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../shared/karaoke-gate'
import { buildKaraokeAssText, computeKaraokeBreaks, splitWordsAtHardBreaks } from '../../shared/karaoke-ass'
// REQ-0311 §4 / REQ-0315 §2 — the sweep emitter.
import { buildKaraokeSweepAssText, buildSweepGapBlock } from '../../shared/karaoke-sweep'
import type { KaraokeStyle } from '../../shared/karaoke-style'
import { resolveKaraokeStyle } from '../../shared/karaoke-style'
import { resolveAnimation } from '../../shared/cue-animation'
import { expandCueToEvents } from '../../shared/cue-events'
// REQ-0332 — line spacing.  All the arithmetic (pitch, per-line `\pos`
// anchors, cue height) lives in `shared/line-spacing.ts` so the preview reads
// the same expressions; this file only transcribes the result into ASS.
import {
  ASS_HARD_BREAK,
  cueLineAnchors,
  estimateCueHeightAssPx,
  formatAssCoord,
  lineHeightsAssPx,
  maxFontSizeInLineBodyAssPx,
  resolveLineSpacingPercent,
} from '../../shared/line-spacing'
import { computeFixedStackOffsets } from '../../shared/stack-offsets'
import { groupByTimeOverlap } from '../../shared/simultaneous-groups'
import { buildAnimationTags } from '../../shared/cue-animation-ass'
import { buildFallbackKaraokeUnits } from '../../shared/karaoke-fallback'
import { resolveKaraokeTiming } from '../../shared/karaoke-timing'
import { assAlphaValue, isFullyOpaque, OPACITY_MAX_PERCENT } from '../../shared/alpha'
import {
  canUseKeywordEmphasisInTier,
  clampEmphasisScalePercent,
  resolveEmphasis,
  buildEmphasisBody,
  clipRangesToWindow,
  emphasizedWordRanges,
  EMPHASIS_DEFAULT_COLOR,
  type EmphasisRange,
} from '../../shared/emphasis'

/**
 * REQ-20260613-016 Phase 2 — ass-generator no longer imports the main-process
 * logger (`../lib/logger`) so the module is reachable from Node-only unit
 * tests without dragging in the Electron `app` global.  The caller side
 * (`ffmpeg-burnin.ts`) still logs the ASS file path / fontsdir / encoder
 * choice, so production triage is unaffected.
 */

type HorizontalPos = 'left' | 'center' | 'right'
type VerticalPos = 'top' | 'center' | 'bottom'

/**
 * Map (horizontal × vertical) to the libass numpad alignment value (1–9).
 *
 *   top    : left=7  center=8  right=9
 *   center : left=4  center=5  right=6   (REQ-0140)
 *   bottom : left=1  center=2  right=3
 *
 * Used for both:
 *   - the Style: `Alignment` column (a sensible static default of 2 =
 *     bottom-center is chosen so legacy projects without explicit row
 *     overrides still anchor correctly), and
 *   - each Dialogue's inline `\an<N>` tag (REQ-20260613-016 Phase 2 §A).
 *
 * For `\an4/5/6` libass anchors the text block at the vertical middle
 * of PlayResY and IGNORES the Dialogue MarginV (there is no edge to
 * measure the margin from).  REQ-0140 §3.2 mirrors this in the UI by
 * disabling the margin input when the row is center-aligned.
 *
 * Pure mapping; safe to call per-entry inside the row loop.
 */
function getAlignment(h: HorizontalPos, v: VerticalPos): number {
  if (v === 'bottom') {
    if (h === 'left') return 1
    if (h === 'center') return 2
    return 3
  } else if (v === 'center') {
    if (h === 'left') return 4
    if (h === 'center') return 5
    return 6
  } else {
    if (h === 'left') return 7
    if (h === 'center') return 8
    return 9
  }
}

/** Convert "#RRGGBB" to ASS "&H00BBGGRR&" */
function hexToAss(hex: string): string {
  const clean = hex.replace('#', '').padStart(6, '0')
  const r = clean.slice(0, 2)
  const g = clean.slice(2, 4)
  const b = clean.slice(4, 6)
  return `&H00${b}${g}${r}&`
}

/** Convert seconds to ASS time format H:MM:SS.cc */
function formatAssTime(sec: number): string {
  const totalCentis = Math.round(sec * 100)
  const cc = totalCentis % 100
  const totalSecs = Math.floor(totalCentis / 100)
  const ss = totalSecs % 60
  const totalMins = Math.floor(totalSecs / 60)
  const mm = totalMins % 60
  const hh = Math.floor(totalMins / 60)
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`
}

/**
 * Escape special ASS characters in text, preserving `\N` as a line-break tag.
 *
 * Round-trip: `\N` is first replaced with a real newline so the backslash
 * escape below doesn't double it (without this, `\N` becomes `\\N` and libass
 * renders the literal text "\N" instead of breaking the line).  The final
 * `\n` → `\N` step then restores it as a libass line-break tag.
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\N/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\N')
}

/**
 * The libass hard line-break marker, as the two characters it occupies in a
 * cue's stored `text` (backslash + `N`).  Protected convention — see
 * CLAUDE.md §21; this constant names it, it does not redefine it.
 *
 * REQ-0332 moved the declaration to `shared/line-spacing.ts` because the
 * splitter now has to re-join lines with the same marker; this alias keeps
 * the local reads short.
 */
const HARD_BREAK = ASS_HARD_BREAK

/**
 * REQ-0330 §1 — split a cue's text into its display lines at the hard breaks.
 *
 * The scan is the same leftmost, non-overlapping one `escapeAssText` and
 * `tokenizeEmphasis` do, so re-joining the pieces with `HARD_BREAK`
 * reproduces the input exactly — including the awkward case of a line that
 * ends in a literal backslash.
 */
function splitCueTextIntoLines(text: string): string[] {
  return text.split(HARD_BREAK)
}

/**
 * REQ-0330 §1 — take the `[from, to)` slice of a cue-wide
 * word-index → emphasis-ranges map and re-key it to that slice's own indices.
 *
 * The ranges are word-local already (REQ-0307 §4 clipped them per `\k` block),
 * so only the KEYS move.
 */
function sliceWordRanges(
  ranges: ReadonlyMap<number, readonly EmphasisRange[]>,
  from: number,
  to: number,
): Map<number, readonly EmphasisRange[]> {
  const out = new Map<number, readonly EmphasisRange[]>()
  for (const [index, value] of ranges) {
    if (index >= from && index < to) out.set(index - from, value)
  }
  return out
}

/**
 * Convert an opacity percentage (0–100) to an ASS alpha hex byte string.
 * ASS alpha: 0x00 = fully opaque, 0xFF = fully transparent.
 */
function opacityToAssAlpha(opacityPercent: number): string {
  const alpha = Math.round((1 - opacityPercent / 100) * 255)
  return alpha.toString(16).toUpperCase().padStart(2, '0')
}

/**
 * REQ-20260613-016 Phase 2 — generate ASS from per-row entries.
 *
 * **Per-row model** (replaces v1.0/v1.1's single-style + global-burnin):
 *   - Each entry carries its own horizontalPosition / verticalPosition /
 *     verticalMarginPx + subtitleBackground { enabled, color, opacityPercent }
 *     (REQ-20260613-016 Phase 1 seeded these on every entry).
 *   - Two styles emitted side-by-side:
 *       Default  : BorderStyle=1 (outline + shadow)
 *       WithBox  : BorderStyle=3 (opaque box)
 *     The choice cannot be flipped inline (ASS spec) so we pre-emit both
 *     and pick per-row via the Dialogue `Style` column.
 *   - Each Dialogue:
 *       * Style column: 'Default' or 'WithBox' based on
 *         entry.subtitleBackground.enabled.
 *       * MarginV column: entry.verticalMarginPx — overrides Style-level
 *         default per libass spec.
 *       * Inline `\an<N>` from (horizontalPosition × verticalPosition).
 *       * Inline `\fs` / `\c` / `\3c` / `\bord` / `\fn` / `\fad` continue
 *         per-row as in v1.1.
 *       * WithBox rows additionally emit `\3c<bg-color>` + `\3a<bg-alpha>`
 *         + `\shad0` (REQ-0096).  Under BorderStyle=3 libass paints the
 *         opaque box with OutlineColour (`\3c`), NOT BackColour (`\4c` =
 *         drop-shadow, which is what v1.3.1 mistakenly used).  The bg `\3c`
 *         emitted AFTER the per-row outline `\3c` wins on a last-write basis,
 *         overriding the user's outline color for the box paint — this is
 *         libass-correct and matches the UX note "BG ON disables outline."
 *         `\shad0` guarantees no shadow leaks regardless of Style header
 *         defaults.  Default rows skip all three so their outline / shadow
 *         rendering is unaffected.
 *
 * **`burnin` and `subtitleBackground` parameters** (kept for ABI continuity
 * with ffmpeg-burnin.ts:151 — see Phase 4 cleanup ticket): both are now
 * **vestigial**.  The Style header bakes in static defaults (alignment 2 =
 * bottom-center, MarginV 40) which every Dialogue overrides per-row, so
 * the args are accepted but no longer drive the output.  Phase 4 will
 * remove them from both ass-generator and the BurninStartRequest IPC
 * contract once the renderer-side global panel is fully retired.
 */
export function generateAss(
  entries: SubtitleEntry[],
  video: VideoInfo,
  burnin: BurninPosition,
  subtitleBackground: SubtitleBackground | undefined,
  /**
   * ASS `Style:` `Fontname` value — exact family name as libass will look it
   * up in the `fontsdir`.  **Required, with no default (REQ-0340 §3.)**
   *
   * It used to default to `'Noto Sans JP SemiBold'`, which is the name of no
   * font this app ever stages.  Every bundled and downloadable TTF carries a
   * NAMESPACED family (`'MOJIOKO Noto Sans JP SemiBold'`, …) precisely so that
   * libass' DirectWrite provider cannot silently substitute a system-installed
   * font of the upstream name (REQ-0275, `shared/fonts.ts`).  So a call that
   * fell through to the default asked libass for a family absent from the
   * `fontsdir`, and libass answered — without a warning anywhere in the ffmpeg
   * output — with ArialMT.  Production never hit it (both call sites pass
   * `getFontMeta(id).assFontName`), but the measurement harness in RES-0333
   * did, and spent a run comparing the preview against Arial.
   *
   * A default is the wrong shape for this argument: the correct value is
   * always derived from the entry's / project's font id, so there is no value
   * a caller could omit and still be right.  Making it required moves that
   * from "a trap the next harness author walks into" to a compile error.
   * `tests/unit/ass-font-name-required-req-0340.test.ts` pins the arity so the
   * default cannot come back.
   *
   * `subtitleBackground` above is spelled `| undefined` rather than `?` for
   * the same reason: TypeScript forbids a required parameter after an optional
   * one, and this argument is the one that must not be omittable.  It is
   * vestigial either way (see the JSDoc above — it is `void`ed).
   */
  assFontName: string,
  /**
   * REQ-0286 §0 — current build's tier flag.  Karaoke is gated behind
   * `canUseKaraokeInTier(isMsix)`; when false, karaoke-enabled cues
   * fall through to plain rendering (no `\k` tags, no colour swap)
   * regardless of the entry's `karaokeEnabled` field.
   *
   * **Required, with no default (REQ-0344 §2-2.)**  It used to default to
   * `false`, i.e. "silently render as the free tier".  That is the same shape
   * of trap as the old `assFontName` default below: a caller that forgets the
   * argument gets plausible output rather than an error.  It has to lose its
   * default anyway for `karaokeStyle` to lose one (TypeScript forbids a
   * required parameter after an optional), and the two share a reason.
   */
  isMsix: boolean,
  /**
   * REQ-0311 §4 / REQ-0315 §2 — karaoke rendering style: `'switch'` is the
   * `\k` path, `'sweep'` routes to the `\kf` emitter in `karaoke-sweep.ts`.
   *
   * REQ-0322 §3 — this is only the **fallback for cues that did not choose
   * one**.  A cue carrying `entry.karaokeStyle` overrides it, so both tags can
   * be mixed inside a single ASS file.  Resolution goes through
   * `resolveKaraokeStyle` so the preview (`subtitle-overlay.tsx`) and this
   * writer answer the question identically.
   *
   * **Required, with no default (REQ-0344 §2-2.)**  The default was
   * `KARAOKE_STYLE_DEFAULT`, and it is what hid REQ-0320 §1 for a release
   * cycle: the renderer stopped sending the value, every call still compiled,
   * and the burn-in quietly rendered a style nobody had chosen.  It then hid a
   * second instance of itself — `frame-exporter.ts` called this function with
   * six arguments, so still exports never saw the seventh at all (RES-0340
   * §6-2).  A default cannot distinguish "the caller means the default" from
   * "the caller forgot", and only the first of those is ever correct here.
   * Requiring it turns the next occurrence into a compile error.
   * `tests/unit/ass-karaoke-style-required-req-0344.test.ts` pins the arity.
   */
  karaokeStyle: KaraokeStyle,
): string {
  // `burnin` / `subtitleBackground` are vestigial (see JSDoc above).  Reference
  // them once so `noUnusedParameters` stays quiet without disabling lint.
  void burnin
  void subtitleBackground

  // Static Style-header defaults — alignment 2 (bottom-center) and MarginV
  // 40 match the legacy global defaults.  Both are overridden per-Dialogue
  // (`\an` inline + MarginV column) so these values primarily serve as a
  // sensible fallback if a future Dialogue accidentally lacks an inline
  // alignment override.
  const DEFAULT_ALIGNMENT = 2
  const DEFAULT_MARGIN_V = 40

  const scriptInfo = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${video.widthPx}`,
    `PlayResY: ${video.heightPx}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    ''
  ].join('\n')

  // Two parallel styles — Default (outline+shadow) and WithBox (opaque box).
  // libass cannot flip BorderStyle inline, so this is the only way to mix
  // the two rendering modes within one ASS file.
  const styles = [
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BorderStyle, Outline, Alignment, MarginL, MarginR, MarginV',
    `Style: Default,${assFontName},100,&H00FFFFFF,&H00000000,1,3,${DEFAULT_ALIGNMENT},${ASS_MARGIN_LR_PX},${ASS_MARGIN_LR_PX},${DEFAULT_MARGIN_V}`,
    `Style: WithBox,${assFontName},100,&H00FFFFFF,&H00000000,3,3,${DEFAULT_ALIGNMENT},${ASS_MARGIN_LR_PX},${ASS_MARGIN_LR_PX},${DEFAULT_MARGIN_V}`,
    ''
  ].join('\n')

  const activeEntries = entries.filter((e) => !e.isDeleted)

  // REQ-0332 §3 — TWO passes.  The first builds each cue's material (override
  // block, per-line bodies, margins); the second decides positions, which
  // cannot be done per cue because a split cue drags its whole
  // simultaneously-visible group onto self-computed positions.  Splitting the
  // loop is the only structural change: pass 1's body is the pre-REQ-0332
  // callback verbatim, minus its final `return`.
  const renders: CueRender[] = [
    ...activeEntries.map((e) => {
      const rowBgEnabled = e.subtitleBackground.enabled
      const styleName = rowBgEnabled ? 'WithBox' : 'Default'

      // REQ-0323 §1 — entrance / exit animation.  The curve is NOT derived
      // here: `shared/cue-animation.ts` owns it and the preview rAF loop
      // reads the very same module, which is the structural fix for the
      // REQ-0320 §1 failure mode (two independent sources for one render
      // value).  This writer only transcribes the control points into ASS.
      //
      // `resolveAnimation` also performs the REQ-0323 §1-6 migration, so a
      // pre-REQ-0323 cue carrying only `fadeDurationSec` comes back as a
      // fade of the same length and emits the same tag it always did —
      // byte-identical output for every existing project.
      const animSpec = resolveAnimation(e)

      // Per-row font override (REQ-021).  Emit \fn<family> only when the
      // row carries a fontId AND that font's ASS family name differs from
      // the Style: default — emitting \fn redundantly for rows that match
      // the default would just bloat the ASS file without changing the
      // rendered result.  isFontId is defensive against stale entries
      // (e.g. fontId from a settings file that referenced a removed font).
      const rowAssFontName = isFontId(e.fontId) ? getFontMeta(e.fontId).assFontName : assFontName
      const fontTag = rowAssFontName !== assFontName ? `\\fn${rowAssFontName}` : ''

      // Per-row alignment — REQ-20260613-016 Phase 2 §A.  Always emit
      // explicit `\an<N>` so the libass rendering anchor never depends on
      // the Style-header default (which is just a fallback constant).
      // For pinned rows (\pos, REQ-20260613-016 Phase 6 / 機能B) we ALSO
      // emit \an so libass knows which corner of the text box to anchor
      // at the \pos coordinate — \pos overrides MarginV positioning but
      // not the anchor choice (the REQ補遺 §B-2 "アンカー点は当該行の \an
      // が示す位置" rule).
      const alignmentN = getAlignment(e.horizontalPosition, e.verticalPosition)
      const alignTag = `\\an${alignmentN}`

      // Free-position pin (\pos, REQ-20260613-016 Phase 6 / 機能B).  Both
      // posX and posY must be defined for the row to count as pinned —
      // a half-pair is treated as unset, matching the
      // `computeFixedStackOffsets` exclusion rule (active-entry.ts).
      const isPinned = e.posX !== undefined && e.posY !== undefined
      const posTag = isPinned ? `\\pos(${e.posX},${e.posY})` : ''

      const sizeTag    = `\\fs${e.fontSizePx}`
      // REQ-0286 §0 / §2 — karaoke gate (paid + toggle-on + words-valid).
      // When active, PrimaryColour is the HIGHLIGHT (spoken-word) colour
      // and we ALSO emit `\2c` for SecondaryColour (unspoken/base).  When
      // inactive, `fillTag` stays on `textColorHex` as before and no
      // `\2c` is emitted — output is byte-identical to pre-REQ-0286 for
      // entries without karaoke, pinned by
      // `ass-generator-baseline-ac1fd67.test.ts`.
      //
      // REQ-0290 § / REQ-0293 §2 — the base (unspoken) colour is
      // ALWAYS `textColorHex`; the per-cue `karaokeBaseColor`
      // override was removed by REQ-0293 so the sweep swaps between
      // "the cue's own text colour" and the user-picked accent
      // (highlight).  The highlight half keeps
      // `KARAOKE_DEFAULT_HIGHLIGHT_COLOR` (yellow) as its unset
      // default because the accent-colour intent is uniform across
      // cues.  Editing `textColorHex` therefore also updates the
      // karaoke base half in one step — no divergence surface.
      //
      // REQ-0289 — when the tier + toggle-on gate passes but the stored
      // `words` no longer align with `text` (user edited the cue,
      // imported SRT, etc.), we fall back to an EQUAL-SPLIT of the cue
      // duration across visible units (JA chars / EN words) rather than
      // silently disabling karaoke.  `karaokeActive` therefore becomes
      // "gate passes AND some resolved word list has ≥1 unit"; only
      // toggle-off or an empty cue text (`splitTextIntoKaraokeUnits`
      // returned []) drops to plain rendering.  The two paths share the
      // same `WordSpan[]` shape and flow through the identical
      // `buildKaraokeAssText` emitter — the fallback is a data-source
      // swap, not a separate rendering codepath.
      const karaokeGateOn = e.karaokeEnabled === true && canUseKaraokeInTier(isMsix)
      // REQ-0336 §1-6 — WHICH timings drive the sweep is decided by the one
      // shared resolver the preview also calls, so the burn cannot disagree
      // with what the user watched.  It adds the time-axis half of the
      // judgement that `areWordsValidForText` (a text-only predicate) could
      // never make: a cue whose start/end no longer match `original` has lost
      // its correspondence with the audio, so it drops to the equal split —
      // which spans exactly this cue's own window and therefore colours every
      // character between its start and its end.
      const karaokeUsesRealWords = resolveKaraokeTiming(e).mode === 'words'
      // REQ-0308 §1 — split any unit a `\N` falls inside so every hard break
      // has a unit boundary to attach to.  A mid-word break (the norm for
      // Japanese — REQ-0303 protects Latin word boundaries only) was otherwise
      // dropped by `computeKaraokeBreaks`, burning in fewer lines than the cue
      // text contains.  subtitle-overlay applies the identical split so the
      // preview matches.  No-op for cues whose breaks already sit on
      // boundaries, keeping existing output byte-identical.
      const karaokeWords: readonly WordSpan[] = karaokeGateOn
        ? splitWordsAtHardBreaks(
            e.text,
            karaokeUsesRealWords
              ? e.words!
              : buildFallbackKaraokeUnits(e.text, e.startSec, e.endSec),
          )
        : []
      const karaokeActive = karaokeWords.length > 0
      const fillTag = karaokeActive
        ? `\\c${hexToAss(e.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR)}`
        : `\\c${hexToAss(e.textColorHex)}`
      // REQ-0293 §2 — base (unspoken) colour is ALWAYS `textColorHex`
      // now.  The pre-REQ-0293 per-cue `karaokeBaseColor` override was
      // removed: the owner-facing model is "pick the accent colour
      // (highlight); unspoken text stays the cue's own colour."  This
      // makes editing `textColorHex` also update the karaoke base
      // half in one step — no divergence surface.  Legacy dev saves
      // carrying `karaokeBaseColor` still hydrate because the field
      // is silently dropped as an unknown key at load time.
      const karaokeSecondaryTag = karaokeActive
        ? `\\2c${hexToAss(e.textColorHex)}`
        : ''

      // REQ-0307 — keyword emphasis (anchored character spans, NOT
      // words-dependent).  Gate = per-cue toggle-on AND the free-tier gate.
      // `resolveEmphasis` migrates the legacy REQ-0305 word indices / REQ-0306
      // keyword list on the fly and resolves each span against the CURRENT
      // text, so emphasis survives edits, works on cues with no / invalid
      // `words`, and hits only the occurrence the user picked.
      const emphasisGateOn = e.keywordEmphasisEnabled === true && canUseKeywordEmphasisInTier(isMsix)
      const emphasisRanges = emphasisGateOn ? resolveEmphasis(e).ranges : []
      const emphasisActive = emphasisRanges.length > 0
      // Emphasised font size (rounded px) and the base to restore after.
      // REQ-0308 §4-4 — the multiplier range is 50–200 %, so this can be SMALLER
      // than `fontSizePx` (a shrunk span); the arithmetic needs no special case.
      const emphasisScaledFs = Math.round(
        e.fontSizePx * (clampEmphasisScalePercent(e.emphasisScalePercent) / 100),
      )
      // REQ-0307 §4 — emphasis ranges projected onto the karaoke word units at
      // CHARACTER granularity, so a span that straddles a `\k` boundary is
      // split at that boundary instead of swallowing whole words.  Works for
      // real OR fallback karaoke words, so emphasis rides along with karaoke
      // even on edited cues.  Only computed when both features are on.
      const emphasisKaraokeRanges = emphasisActive && karaokeActive
        ? emphasizedWordRanges(e.text, karaokeWords, emphasisRanges)
        : new Map<number, EmphasisRange[]>()
      const emphasisColorHex = e.emphasisColorHex ?? EMPHASIS_DEFAULT_COLOR

      const outlineTag = `\\3c${hexToAss(e.outlineColorHex)}`
      const bordTag    = `\\bord${e.outlineThicknessPx}`

      // REQ-0310 §2 — per-cue opacity for the text fill and the outline.
      //
      // The fill alpha targets a DIFFERENT ASS colour depending on karaoke,
      // because the two features share the same two colour slots:
      //   - karaoke OFF → the fill is PrimaryColour        → `\1a`
      //   - karaoke ON  → the fill is the UNSPOKEN half,
      //                   i.e. SecondaryColour (`\2c` above) → `\2a`
      // The spoken half deliberately gets NO alpha override, so it stays
      // opaque.  That is what produces the effect this REQ was filed for: set
      // the text opacity to 0 with karaoke on and unspoken words are invisible,
      // so each word appears as it is spoken.
      //
      // Both tags are emitted ONLY when the value is below 100 %.  The Style
      // header already declares opaque PrimaryColour / OutlineColour
      // (`&H00…`), so skipping the tag is exactly equivalent to "opaque" and
      // keeps an untouched cue byte-identical to the pre-REQ-0310 output.
      //
      // 0 % is intentionally reachable (REQ-0310 §2): fill 0 % + opaque outline
      // is hollow text, and both at 0 % is an invisible cue the user asked for.
      const textAlphaTag = isFullyOpaque(e.textAlpha)
        ? ''
        : `${karaokeActive ? '\\2a' : '\\1a'}${assAlphaValue(e.textAlpha)}`
      const outlineAlphaTag = isFullyOpaque(e.outlineAlpha)
        ? ''
        : `\\3a${assAlphaValue(e.outlineAlpha)}`

      // REQ-0277 §2 / REQ-0293 §1 — drop shadow.  libass' `\shad<depth>`
      // draws the shadow with `\4c` (BackColour) at the fixed
      // bottom-right offset; there is no angle control.  Skipped
      // entirely when the row has a background box (the bg path
      // emits its own `\shad0` to suppress bleed, and a user-toggled
      // shadow would fight that intent, so bg wins).
      //
      // REQ-0293 §1 replaced the pre-existing `shadowEnabled` boolean
      // gate with `depth > 0`: depth 0 emits no shadow tags at all
      // (byte-identical to the old `shadowEnabled === false` path),
      // depth > 0 emits `\shad<depth>` + colour + alpha.  Removes the
      // duplicate ON/OFF surface that always shadowed the depth
      // slider.  Legacy dev saves carrying `shadowEnabled` still
      // hydrate because the field is silently dropped as an unknown
      // key at load time; a save with `shadowEnabled: false,
      // shadowDepth: 6` will now render depth 6 (was previously
      // suppressed) — acceptable given no released version persisted
      // the boolean.  Depth clamp: 0–`SHADOW_DEPTH_MAX_PX` (= 50).
      let shadowDepthTag = ''
      let shadowColorTag = ''
      let shadowAlphaTag = ''
      const rawDepth = Math.max(0, Math.min(SHADOW_DEPTH_MAX_PX, e.shadowDepth ?? 0))
      // REQ-0325 §1 — the scale animations must carry `\bord` (and `\shad`)
      // with them: libass does not scale either with `\fscx`/`\fscy`, but the
      // CSS preview's `transform: scale()` scales the rasterised pixels and
      // therefore does.  The preview is the reference, so the burn follows.
      //
      // `shadowPx` is deliberately 0 on a background-box row — that path
      // emits its own `\shad0` to stop bleed, and a scaled `\shad` here would
      // bring the suppressed shadow back.  `outlinePx` IS carried for a box
      // row, because there `\bord` is the box padding and the preview's CSS
      // `padding` scales with the transform just the same.
      //
      // These tags land last in the override list, so they win over the
      // static `bordTag` / `shadowDepthTag` on libass's last-write-wins.
      const animTag = buildAnimationTags(animSpec, e.startSec, e.endSec, {
        outlinePx: e.outlineThicknessPx,
        shadowPx: rowBgEnabled ? 0 : rawDepth,
      })
      if (rawDepth > 0 && !rowBgEnabled) {
        const color = e.shadowColor ?? '#000000'
        const alphaPct = Math.max(0, Math.min(100, e.shadowAlpha ?? 100))
        shadowDepthTag = `\\shad${rawDepth}`
        shadowColorTag = `\\4c${hexToAss(color)}`
        shadowAlphaTag = `\\4a&H${opacityToAssAlpha(alphaPct)}&`
      }

      // REQ-0278 — glow (`\blur` + `\3c` override) was removed here.
      // See SPECIFICATION.md §11 for the deletion rationale.  Byte-
      // identity with pre-Phase-A ac1fd67 output is pinned by
      // `tests/unit/ass-generator-baseline-ac1fd67.test.ts`.

      // REQ-0277 §4 — text rotation (Z axis, clockwise).  libass'
      // `\frz<deg>` measures counter-clockwise, so we negate the
      // user-supplied clockwise value.  0 (or undefined) skips the
      // tag to keep the ASS clean.  Rotation origin is the text's
      // own bounding box; when the row is pinned (`\pos`) libass uses
      // the pinned point as the origin, otherwise the alignment
      // anchor.  For legacy alignment-based rows this means rotation
      // pivots around the anchor point (e.g. bottom-center for the
      // default anchor 2), which matches the CSS preview's
      // `transform-origin: center` closely enough for the intended
      // "tilt an already-placed caption" UX.
      // Modulo before the tag check so 360 / 720 / -360 all collapse to 0.
      const rotNorm = ((e.rotation ?? 0) % 360 + 360) % 360
      const rotTag = rotNorm !== 0 ? `\\frz${(360 - rotNorm) % 360}` : ''

      // WithBox-only inline tags (REQ-0096 — was a bug fix).
      // libass paints the BorderStyle=3 opaque box with OutlineColour
      // (`\3c` / `\3a`), NOT BackColour (`\4c` / `\4a` — that's the drop
      // shadow).  v1.3.1 wrote the user's bg color into \4c, which is why
      // the box rendered in the user's outline color and the bg color
      // only leaked into the (tiny) shadow.  The fix: emit \3c/\3a with
      // the bg color/alpha AFTER the per-row outline `\3c` so libass's
      // last-write-wins behavior overrides the outline color for the box
      // paint.  \shad0 ensures no shadow leaks regardless of style header.
      let bgFillTag  = ''
      let bgAlphaTag = ''
      let bgShadTag  = ''
      if (rowBgEnabled) {
        const bgColor = e.subtitleBackground.color === 'white' ? '00FFFFFF' : '000000'
        const bgAlpha = opacityToAssAlpha(e.subtitleBackground.opacityPercent)
        bgFillTag  = `\\3c&H${bgColor}&`
        bgAlphaTag = `\\3a&H${bgAlpha}&`
        bgShadTag  = '\\shad0'
      }

      // REQ-0332 §3 — the override block is now built through a function
      // with the position tag as a HOLE, because a line-split cue needs the
      // same block N times with a different `\pos` in each.  Calling it with
      // the row's own `posTag` reproduces the pre-REQ-0332 string exactly
      // (empty for an unpinned row), so nothing about the unsplit path moves.
      const buildStyleTag = (positionTag: string): string => [
        alignTag,
        positionTag,
        fontTag,
        sizeTag,
        fillTag,
        // REQ-0286 — `\2c` (SecondaryColour) placed right after `\c`
        // (PrimaryColour) so both colours are established before any
        // karaoke `\k` tag references them.  Empty string when
        // karaoke is inactive; `.filter(Boolean).join('')` drops it
        // cleanly with no whitespace drift.
        karaokeSecondaryTag,
        // REQ-0310 — fill alpha right after the two fill colours it modifies.
        textAlphaTag,
        outlineTag,
        bordTag,
        // REQ-0310 — outline alpha after `\3c`, but BEFORE the bg tags below so
        // a background-box row still has its own `\3a` win on last-write.  The
        // box IS painted with `\3c`/`\3a`, so letting the per-cue outline alpha
        // override it would silently change the box's existing opacity — which
        // this REQ explicitly must not touch.
        outlineAlphaTag,
        // bg tags MUST come AFTER outlineTag so libass takes the bg color
        // as the final \3c / \3a value (last-write-wins).
        bgFillTag,
        bgAlphaTag,
        bgShadTag,
        // REQ-0277 §2 — shadow tags after bg so a WithBox row doesn't get
        // a stray drop shadow (bg path's \shad0 wins anyway; shadow tags
        // are only emitted when !rowBgEnabled).
        shadowDepthTag,
        shadowColorTag,
        shadowAlphaTag,
        // REQ-0277 §4 — rotation last (order irrelevant for libass
        // parsing but keeps the emitted string easy to read).
        rotTag,
        animTag,
      ].filter(Boolean).join('')

      // REQ-0277 §1 — display casing.  Apply to the emitted text ONLY;
      // e.text (the stored transcript) is unchanged.  SRT export
      // continues to see the original text.  `casing === undefined`
      // OR `'none'` → no transform.
      // REQ-0286 §2 / REQ-0294 — when karaoke is active, the text
      // portion is built from `words` via `buildKaraokeAssText`,
      // which inserts `{\k<duration>}` before each word.  `\N` line
      // breaks in the cue text are honoured — a 2-line cue stays
      // 2 lines when karaoke turns on.  Pre-REQ-0294 the `\N` was
      // silently dropped and karaoke collapsed every cue to one
      // line (REQ-0294 §1 bug).  REQ-0330 §1 moved the break handling
      // out of the emitter and into the per-line loop below, which
      // splits the units BEFORE calling it; the emitter's own
      // `cueText` argument is therefore no longer used from here.
      // Casing applies word-by-word via this escaper wrapper so uppercase
      // karaoke / emphasis still works (REQ-0277 §1 / REQ-0286 / REQ-0305).
      const escapeWord = (s: string): string => {
        const cased = e.casing === 'uppercase' ? s.toUpperCase() : s
        return escapeAssText(cased)
      }
      // REQ-0330 §1 — the body is assembled ONE DISPLAY LINE AT A TIME.
      //
      // Line spacing (REQ-0330 §2) has to emit each display line as its own
      // ASS event with its own `\pos`, because ASS has no line-spacing tag and
      // `ass_set_line_spacing()` is not reachable through ffmpeg.  Splitting
      // the FINISHED body on `\N` cannot work: the karaoke and emphasis
      // bodies interleave `{\k…}` / `{\fs…\c…}` override blocks with the text,
      // so a naive cut would tear a block in half.  So the split happens on
      // the INPUTS instead — words and emphasis ranges are apportioned to a
      // line first, and each line's body is built from its own inputs.
      //
      // This step is a pure restructure: the per-line bodies are re-joined
      // with the `\N` that separated them, so exactly one event is emitted and
      // the output is byte-identical (pinned by
      // `ass-generator-baseline-ac1fd67.test.ts`).  What changes is only that
      // `lineBodies` now EXISTS as a seam for §2 to emit from.
      //
      // REQ-0332 §3 — TWO forms of the same lines are built.  `lineBodies` is
      // the joined form (what a one-event cue emits, byte-identical to before)
      // and `splitLineBodies` is what a line-split cue emits.  They differ
      // ONLY on the karaoke path, and only because `\k` is an event-local
      // clock: see the comment at the push site.
      const lineBodies: string[] = []
      const splitLineBodies: string[] = []
      if (karaokeActive) {
        // REQ-0289 — `karaokeWords` is either the real per-word list
        // (words valid) or the equal-split fallback list (words
        // invalid); `buildKaraokeAssText` doesn't care which since
        // both share the `WordSpan` shape.  For the fallback the
        // stripped concat of `karaokeWords` matches the stripped
        // `e.text` because the fallback splitter is derived from
        // that same cue text, so `computeKaraokeBreaks` inside
        // `buildKaraokeAssText` still maps `\N` to the right unit
        // boundary.
        //
        // REQ-0306 §3 (Option A, owner-confirmed) — emphasised karaoke words
        // grow AND, when spoken, light up in the emphasis colour instead of
        // the karaoke highlight.  The overlay folds `\fs<big>\c<emph>` into
        // the word's `\k` block (Primary/spoken colour → emphasis colour) and
        // restores `\fs<base>\c<highlight>` after so the next word sweeps to
        // the normal highlight.  `\2c` (unspoken) stays base for everyone, so
        // the emphasised word looks like the others until it is spoken.
        const emphasisOverlay = emphasisKaraokeRanges.size > 0
          ? {
              ranges: emphasisKaraokeRanges,
              openTag: `\\fs${emphasisScaledFs}\\c${hexToAss(emphasisColorHex)}`,
              closeTag: `\\fs${e.fontSizePx}\\c${hexToAss(e.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR)}`,
            }
          : undefined
        // REQ-0322 §3 — per-cue first, the request-level value as default.
        const cueKaraokeStyle = resolveKaraokeStyle(e.karaokeStyle, karaokeStyle)

        // REQ-0330 §1 — apportion the karaoke units to display lines.
        //
        // The line boundaries come from `computeKaraokeBreaks`, NOT from
        // splitting `e.text` on `\N`: that function is what the emitters
        // themselves used to decide where to put a `\N`, and it can express
        // fewer breaks than the text contains (a leading `\N` has no unit to
        // attach to, and two adjacent `\N` collapse to one boundary).  Using
        // the text split here would emit a different number of lines than the
        // karaoke body has always emitted.  `splitWordsAtHardBreaks` (applied
        // above) has already guaranteed every representable break sits on a
        // unit boundary, so the groups below are exact.
        const breakIndices = computeKaraokeBreaks(e.text, karaokeWords)
        const groupStarts = [0, ...Array.from(breakIndices).sort((a, b) => a - b)]
        for (let g = 0; g < groupStarts.length; g++) {
          const from = groupStarts[g]
          const to = g + 1 < groupStarts.length ? groupStarts[g + 1] : karaokeWords.length
          // The first unit of a continuation line loses its leading whitespace
          // so the line does not render an indent from faster-whisper's
          // `" word"` convention.  The emitters do this themselves when THEY
          // place the break; here the break is ours, so the strip is too.
          // Stripping leading whitespace never moves a stripped-coordinate
          // index, so the emphasis ranges below still line up.
          const groupWords = karaokeWords
            .slice(from, to)
            .map((word, i) => (g > 0 && i === 0 ? { ...word, text: word.text.replace(/^\s+/, '') } : word))
          // Timing seam.  A line is emitted as if it were a cue spanning
          // [first unit's start, next line's first unit's start), which makes
          // every `\k` / `\kf` duration come out exactly as it did when the
          // whole cue was emitted in one pass:
          //   - line 0 keeps the real cue start, so the leading-offset block
          //     (`\k` path) / leading silence (`\kf` path) is still emitted;
          //   - later lines start ON their first unit, so neither emitter
          //     invents a second leading block;
          //   - the last unit of a line holds until the next line's first unit
          //     activates, which is what `words[i+1].startSec` gave before.
          const lineStartSec = g === 0 ? e.startSec : groupWords[0].startSec
          const lineEndSec = to < karaokeWords.length ? karaokeWords[to].startSec : e.endSec
          // Emphasis ranges are keyed by cue-wide unit index; re-key them to
          // this line's units.  The ranges themselves are unchanged — they are
          // already word-local (REQ-0307 §4).
          const lineEmphasis =
            emphasisOverlay === undefined
              ? undefined
              : { ...emphasisOverlay, ranges: sliceWordRanges(emphasisOverlay.ranges, from, to) }
          // REQ-0311 §4 — the ONE branch that selects the sweep emitter.  Both
          // take the same arguments; only the tag and the duration rule differ.
          // Deleting the sweep feature means deleting this ternary's false arm.
          //
          // `cueText` is deliberately NOT passed: a display line contains no
          // `\N` by construction, so there is no break left for the emitter to
          // find, and passing the whole cue text would make it re-derive breaks
          // against a word list that is only a slice of the cue's.
          const buildLine = (fromSec: number): string =>
            cueKaraokeStyle === 'sweep'
              ? buildKaraokeSweepAssText(groupWords, fromSec, lineEndSec, escapeWord, undefined, lineEmphasis)
              : buildKaraokeAssText(groupWords, fromSec, lineEndSec, escapeWord, undefined, lineEmphasis)
          lineBodies.push(buildLine(lineStartSec))
          // ★ REQ-0332 §3 — the SPLIT form of the same line needs a different
          // `\k` clock.  `\k` is per-EVENT, and every split line's event spans
          // the whole cue, so a continuation line must open with the silence
          // that separates the cue start from its own first unit — otherwise
          // its sweep starts at t=0 and the karaoke runs on all lines at once.
          // Passing the CUE start makes the emitters produce that leading
          // block themselves (they already do it for the cue's own leading
          // offset), so there is no second copy of the rounding rule.
          splitLineBodies.push(g === 0 ? lineBodies[g] : buildLine(e.startSec))
          // The `\kf` path emits the silence BEFORE a unit as a textless
          // `{\k<gap>}`, and when that unit opens a line the block lands
          // before the `\N`, i.e. at the END of the previous line.  Keep it
          // there in the JOINED form: it is where libass has always seen it
          // (RES-0330 §1-3 measured a byte difference when it moved).  The
          // split form omits it — the gap is carried by the NEXT line's own
          // leading block above, and a trailing textless block would only
          // advance a clock nothing reads afterwards.
          if (cueKaraokeStyle === 'sweep' && to < karaokeWords.length) {
            lineBodies[g] += buildSweepGapBlock(karaokeWords[to].startSec - karaokeWords[to - 1].endSec)
          }
        }
      } else if (emphasisActive) {
        // REQ-0307 — karaoke OFF, emphasis ON.  Build the body straight from
        // the cue text + resolved span ranges (no `words` needed), wrapping
        // each emphasised run in `\fs<big>\c<emph>` and restoring base
        // size/colour after.  Ranges are character-level, so a run need not
        // align with a word boundary.  Segment concatenation reproduces
        // `e.text` exactly, so non-emphasised runs are byte-identical to the
        // plain path.
        // REQ-0310 §2 — the emphasis colour is deliberately NOT alpha-aware, so
        // an emphasised run stays opaque even when the cue's fill is
        // translucent.  `\1a` is a cue-wide state, so the run has to reset it to
        // opaque on open and restore the cue's value on close; without that the
        // run would inherit the translucent fill and vanish along with the rest
        // of the text.  Both fragments stay inside the `{}` the caller adds
        // (REQ-0291).  Empty when the cue is fully opaque, keeping the emitted
        // tags byte-identical to pre-REQ-0310.
        const emphasisOpaqueTag = isFullyOpaque(e.textAlpha)
          ? ''
          : `\\1a${assAlphaValue(OPACITY_MAX_PERCENT)}`
        const emphasisRestoreAlphaTag = isFullyOpaque(e.textAlpha)
          ? ''
          : `\\1a${assAlphaValue(e.textAlpha)}`
        const openTag = `\\fs${emphasisScaledFs}\\c${hexToAss(emphasisColorHex)}${emphasisOpaqueTag}`
        const closeTag = `\\fs${e.fontSizePx}\\c${hexToAss(e.textColorHex)}${emphasisRestoreAlphaTag}`
        // REQ-0330 §1 — one call per display line.  The stored spans are
        // code-unit offsets into the FULL cue text, so each line's ranges are
        // the cue's ranges clipped to that line's window and shifted back to
        // zero.  A span that straddles a break survives as two clipped ranges,
        // one per line — which is what `tokenizeEmphasis` produced anyway,
        // since it always flushed its run at the sentinel.
        let lineStart = 0
        for (const line of splitCueTextIntoLines(e.text)) {
          lineBodies.push(
            buildEmphasisBody(
              line,
              clipRangesToWindow(emphasisRanges, lineStart, lineStart + line.length),
              escapeWord,
              openTag,
              closeTag,
            ),
          )
          lineStart += line.length + HARD_BREAK.length
        }
        // Emphasis carries no per-event clock, so the split form is identical.
        splitLineBodies.push(...lineBodies)
      } else {
        // Plain path — `escapeWord` is `escapeAssText` plus the casing
        // transform, i.e. exactly what the whole-cue call used to do.
        for (const line of splitCueTextIntoLines(e.text)) lineBodies.push(escapeWord(line))
        splitLineBodies.push(...lineBodies)
      }
      // Per-row MarginV — Dialogue's MarginV column overrides the Style-level
      // default per libass spec.  REQ-20260613-016 Phase 2 §A.
      // MarginL / MarginR stay 0 (= use Style defaults from the Style header)
      // because the user-facing controls in v1.2.2 only expose vertical margin.
      //
      // Pinned rows (\pos, Phase 6) emit MarginV=0 in the column — libass
      // ignores MarginV when \pos is present, but writing 0 makes the
      // intent unambiguous to anyone reading the ASS file directly.
      const marginVCol = isPinned ? 0 : e.verticalMarginPx

      return {
        entry: e, styleName, buildStyleTag, ownPosTag: posTag,
        lineBodies, splitLineBodies, marginVCol, isPinned,
      }
    }),
  ]

  // REQ-0332 §3 — decide, ACROSS cues, which ones position themselves.
  const selfPositioned = resolveSelfPositionedCues(renders, video)

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text',
    ...renders.flatMap((r) => {
      const placement = selfPositioned.get(r.entry.id)
      // REQ-0327 §1-1 / REQ-0332 §3 — one cue may become several events (line
      // axis for line spacing, time axis for slide).  `lineStyleTags`
      // undefined ⇒ the lines are re-joined and ONE event comes back, which
      // is byte-identical to the pre-REQ-0327 output.
      return expandCueToEvents({
        startSec: r.entry.startSec,
        endSec: r.entry.endSec,
        marginV: placement === undefined ? r.marginVCol : 0,
        styleTag: r.buildStyleTag(r.ownPosTag),
        lineBodies: placement === undefined ? r.lineBodies : r.splitLineBodies,
        lineStyleTags: placement?.map((a) =>
          r.buildStyleTag(`\\pos(${formatAssCoord(a.x)},${formatAssCoord(a.y)})`),
        ),
      }).map((piece) =>
        `Dialogue: 0,${formatAssTime(piece.startSec)},${formatAssTime(piece.endSec)},` +
        `${r.styleName},0,0,${piece.marginV},,{${piece.styleTag}}${piece.body}`
      )
    }),
    ''
  ].join('\n')

  return [scriptInfo, styles, events].join('\n')
}

/** What `generateAss` needs to remember about a cue between its two passes. */
interface CueRender {
  entry: SubtitleEntry
  styleName: string
  /** The cue's override block, with the position tag left as a hole. */
  buildStyleTag: (positionTag: string) => string
  /** The row's own `\pos` tag (pinned rows only); '' otherwise. */
  ownPosTag: string
  /** The display lines as ONE event emits them (joined with `\N`). */
  lineBodies: string[]
  /** The same lines as SEPARATE events emit them.  Differs only for karaoke. */
  splitLineBodies: string[]
  marginVCol: number
  isPinned: boolean
}

/**
 * REQ-0332 §3 — work out which cues MOJIOKO positions itself, and where each
 * of their display lines goes.
 *
 * Returns a map id → per-line anchors.  A cue absent from the map is emitted
 * exactly as it always was: one event, libass decides the position.  The map
 * is EMPTY whenever no cue has a non-zero line spacing, which is what keeps
 * `ass-generator-baseline-ac1fd67` byte-identical.
 *
 * ## The three decisions
 *
 * 1. **Which cues actually need splitting.**  A cue needs it when it has more
 *    than one display line AND a non-zero spacing.  A one-line cue has no gap
 *    to change, so it is left alone no matter what the field says.
 *
 * 2. **Who gets dragged along.**  Splitting removes a cue from libass's
 *    collision detection, so a split cue and an auto-stacked cue on the same
 *    frame would be placed by two authorities that cannot see each other.
 *    The owner's rule (§3): if any cue in a simultaneously-visible group is
 *    split, the whole group self-positions.  The group is the transitive
 *    closure of time-interval overlap — see `simultaneous-groups.ts` for why
 *    the closure, and not just the pairwise overlaps, is the right unit.
 *
 * 3. **Where the lines go.**  Stack offsets come from the SAME
 *    `computeFixedStackOffsets` the preview draws with (moved to `shared/` by
 *    this REQ), fed the same `estimateCueHeightAssPx`.  The per-line anchors
 *    come from `cueLineAnchors`, whose derivation was validated against
 *    libass frame-by-frame (see its docblock).
 *
 * Pinned rows (`\pos`, 機能B) sit outside all of this: libass already excludes
 * them from collisions and so does `computeFixedStackOffsets`, so a pinned cue
 * splits only for its own sake and never drags a group along.
 */
function resolveSelfPositionedCues(
  renders: readonly CueRender[],
  video: VideoInfo,
): Map<string, { x: number; y: number }[]> {
  const out = new Map<string, { x: number; y: number }[]>()

  const needsSplit = (r: CueRender): boolean =>
    r.lineBodies.length > 1 && resolveLineSpacingPercent(r.entry) !== 0

  // Pinned rows first — independent of every group.
  const unpinned = renders.filter((r) => !r.isPinned)
  const selfIds = new Set<string>()
  for (const r of renders) {
    if (r.isPinned && needsSplit(r)) selfIds.add(r.entry.id)
  }

  // Groups over the unpinned rows only.
  for (const group of groupByTimeOverlap(unpinned.map((r) => r.entry))) {
    if (!group.some((i) => needsSplit(unpinned[i]))) continue
    for (const i of group) selfIds.add(unpinned[i].entry.id)
  }

  if (selfIds.size === 0) return out

  // Stack offsets are computed over ALL unpinned rows, sorted by startSec as
  // `computeFixedStackOffsets` requires.  Ties keep the array order, which is
  // the ASS Dialogue order — the same tie-break the preview relies on.
  const stacked = unpinned
    .map((r) => r.entry)
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => a.entry.startSec - b.entry.startSec || a.i - b.i)
    .map((x) => x.entry)
  const offsets = computeFixedStackOffsets(stacked, estimateCueHeightAssPx)

  for (const r of renders) {
    if (!selfIds.has(r.entry.id)) continue
    const e = r.entry
    const offset = r.isPinned ? 0 : (offsets.get(e.id) ?? 0)
    // REQ-0350 — measure each line from the body that will actually be
    // emitted, so a line carrying an emphasis `\fs` gets a taller box.  The
    // SPLIT bodies are the right ones to read: those are the events these
    // anchors position.
    const lineMaxFontSizes = r.splitLineBodies.map((body) =>
      maxFontSizeInLineBodyAssPx(body, e.fontSizePx))
    out.set(e.id, cueLineAnchors({
      lineHeightsPx: lineHeightsAssPx(lineMaxFontSizes, resolveLineSpacingPercent(e)),
      horizontalPosition: e.horizontalPosition,
      verticalPosition: e.verticalPosition,
      verticalMarginPx: e.verticalMarginPx + offset,
      centerOffsetPx: offset,
      playResX: video.widthPx,
      playResY: video.heightPx,
      marginLrPx: ASS_MARGIN_LR_PX,
      posX: e.posX,
      posY: e.posY,
    }))
  }
  return out
}
