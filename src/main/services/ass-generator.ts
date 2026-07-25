import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground } from '../../shared/types'
import { ASS_MARGIN_LR_PX } from '../../shared/constants'
import { getFontMeta, isFontId } from '../../shared/fonts'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR, KARAOKE_DEFAULT_BASE_COLOR } from '../../shared/karaoke-gate'
import { buildKaraokeAssText } from '../../shared/karaoke-ass'
import { areWordsValidForText } from '../../shared/words-validity'

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
  subtitleBackground?: SubtitleBackground,
  /**
   * ASS `Style:` `Fontname` value — exact family name as libass will look it
   * up in the `fontsdir`.  Defaults to "Noto Sans JP SemiBold" so legacy
   * callers that pre-date font selection continue to produce the v1.0/v1.1
   * output unchanged.
   */
  assFontName: string = 'Noto Sans JP SemiBold',
  /**
   * REQ-0286 §0 — current build's tier flag.  Karaoke is gated behind
   * `canUseKaraokeInTier(isMsix)`; when false, karaoke-enabled cues
   * fall through to plain rendering (no `\k` tags, no colour swap)
   * regardless of the entry's `karaokeEnabled` field.  Defaults to
   * `false` so pre-REQ-0286 callers (and every existing unit test)
   * get the plain path automatically — the "byte-identical to
   * pre-REQ-0286 output for entries without karaoke" invariant is
   * pinned by `ass-generator-baseline-ac1fd67.test.ts`.
   */
  isMsix: boolean = false,
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

  const events = [
    '[Events]',
    'Format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text',
    ...activeEntries.map((e) => {
      const rowBgEnabled = e.subtitleBackground.enabled
      const styleName = rowBgEnabled ? 'WithBox' : 'Default'

      // REQ-20260615-050 — read fade duration from the entry itself.
      // `0` means no fade, and the helper writes no `\fad` tag in that
      // case (libass renders at constant alpha = no ramp).  `0.1`–`0.5`
      // emit `\fad(t,t)` symmetric in/out (matches the preview helper).
      const fadeDurationMs = Math.round(e.fadeDurationSec * 1000)
      const fadeTag = fadeDurationMs > 0 ? `\\fad(${fadeDurationMs},${fadeDurationMs})` : ''

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
      const karaokeActive =
        e.karaokeEnabled === true
        && canUseKaraokeInTier(isMsix)
        && areWordsValidForText(e.words, e.text)
      const fillTag = karaokeActive
        ? `\\c${hexToAss(e.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR)}`
        : `\\c${hexToAss(e.textColorHex)}`
      const karaokeSecondaryTag = karaokeActive
        ? `\\2c${hexToAss(e.karaokeBaseColor ?? KARAOKE_DEFAULT_BASE_COLOR)}`
        : ''
      const outlineTag = `\\3c${hexToAss(e.outlineColorHex)}`
      const bordTag    = `\\bord${e.outlineThicknessPx}`

      // REQ-0277 §2 — drop shadow.  libass' `\shad<depth>` draws the
      // shadow with `\4c` (BackColour) at the fixed bottom-right
      // offset; there is no angle control.  Skipped entirely when the
      // row has a background box (the bg path emits its own `\shad0`
      // to suppress bleed, and a user-toggled shadow would fight
      // that intent, so bg wins).  When `shadowEnabled === undefined`
      // OR false no tags are emitted at all — the Style header does
      // not set a Shadow column so libass' default of 0 applies
      // naturally, matching pre-REQ-0277 output byte-for-byte on
      // rows without the effect.
      let shadowDepthTag = ''
      let shadowColorTag = ''
      let shadowAlphaTag = ''
      if (e.shadowEnabled && !rowBgEnabled) {
        const depth = Math.max(0, Math.min(20, e.shadowDepth ?? 4))
        const color = e.shadowColor ?? '#000000'
        const alphaPct = Math.max(0, Math.min(100, e.shadowAlpha ?? 100))
        shadowDepthTag = `\\shad${depth}`
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

      const styleTag = [
        alignTag,
        posTag,
        fontTag,
        sizeTag,
        fillTag,
        // REQ-0286 — `\2c` (SecondaryColour) placed right after `\c`
        // (PrimaryColour) so both colours are established before any
        // karaoke `\k` tag references them.  Empty string when
        // karaoke is inactive; `.filter(Boolean).join('')` drops it
        // cleanly with no whitespace drift.
        karaokeSecondaryTag,
        outlineTag,
        bordTag,
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
        fadeTag,
      ].filter(Boolean).join('')

      // REQ-0277 §1 — display casing.  Apply to the emitted text ONLY;
      // e.text (the stored transcript) is unchanged.  SRT export
      // continues to see the original text.  `casing === undefined`
      // OR `'none'` → no transform.
      // REQ-0286 §2 — when karaoke is active, the text portion is
      // built from `words` via `buildKaraokeAssText`, which inserts
      // `\k<duration>` between each word and preserves the words'
      // own leading spaces.  The cue's `\N` auto-line-break positions
      // are INTENTIONALLY not applied here (see karaoke-ass.ts docstring
      // "What this DOES NOT do") — karaoke cues use natural word-wrap
      // on both preview and burn-in so the two stay pixel-consistent.
      // Casing applies word-by-word via the escaper wrapper so
      // uppercase karaoke still works.
      let text: string
      if (karaokeActive && e.words) {
        const escapeWord = (s: string): string => {
          const cased = e.casing === 'uppercase' ? s.toUpperCase() : s
          return escapeAssText(cased)
        }
        const karaokeBody = buildKaraokeAssText(e.words, e.startSec, e.endSec, escapeWord)
        text = `{${styleTag}}${karaokeBody}`
      } else {
        const rawText = e.casing === 'uppercase' ? e.text.toUpperCase() : e.text
        text = `{${styleTag}}${escapeAssText(rawText)}`
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
      const dialogueLine =
        `Dialogue: 0,${formatAssTime(e.startSec)},${formatAssTime(e.endSec)},` +
        `${styleName},0,0,${marginVCol},,${text}`
      return dialogueLine
    }),
    ''
  ].join('\n')

  return [scriptInfo, styles, events].join('\n')
}
