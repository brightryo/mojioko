import type { SubtitleEntry, VideoInfo, BurninPosition, SubtitleBackground } from '../../shared/types'
import { ASS_MARGIN_LR_PX } from '../../shared/constants'
import { getFontMeta, isFontId } from '../../shared/fonts'

/**
 * REQ-20260613-016 Phase 2 — ass-generator no longer imports the main-process
 * logger (`../lib/logger`) so the module is reachable from Node-only unit
 * tests without dragging in the Electron `app` global.  The caller side
 * (`ffmpeg-burnin.ts`) still logs the ASS file path / fontsdir / encoder
 * choice, so production triage is unaffected.
 */

type HorizontalPos = 'left' | 'center' | 'right'
type VerticalPos = 'top' | 'bottom'

/**
 * Map (horizontal × vertical) to the libass numpad alignment value (1–9).
 *
 *   top    : left=7  center=8  right=9
 *   bottom : left=1  center=2  right=3
 *
 * Used for both:
 *   - the Style: `Alignment` column (a sensible static default of 2 =
 *     bottom-center is chosen so legacy projects without explicit row
 *     overrides still anchor correctly), and
 *   - each Dialogue's inline `\an<N>` tag (REQ-20260613-016 Phase 2 §A).
 *
 * Pure mapping; safe to call per-entry inside the row loop.
 */
function getAlignment(h: HorizontalPos, v: VerticalPos): number {
  if (v === 'bottom') {
    if (h === 'left') return 1
    if (h === 'center') return 2
    return 3
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
 *       * WithBox rows additionally emit `\4c<color>` + `\4a<alpha>` (the
 *         BackColour / BackAlpha override that libass binds to the opaque
 *         box paint when BorderStyle=3).  Default rows skip these tags so
 *         their outline / shadow rendering is unaffected.
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
  assFontName: string = 'Noto Sans JP SemiBold'
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
      const fillTag    = `\\c${hexToAss(e.textColorHex)}`
      const outlineTag = `\\3c${hexToAss(e.outlineColorHex)}`
      const bordTag    = `\\bord${e.outlineThicknessPx}`

      // WithBox-only inline tags — \4c (BackColour) + \4a (BackAlpha) drive
      // the opaque box paint when the row's Style is BorderStyle=3.  Default
      // rows skip these; their outline + shadow render normally.
      let bgFillTag = ''
      let bgAlphaTag = ''
      if (rowBgEnabled) {
        const bgColor = e.subtitleBackground.color === 'white' ? '00FFFFFF' : '000000'
        const bgAlpha = opacityToAssAlpha(e.subtitleBackground.opacityPercent)
        bgFillTag  = `\\4c&H${bgColor}&`
        bgAlphaTag = `\\4a&H${bgAlpha}&`
      }

      const styleTag = [
        alignTag,
        posTag,
        fontTag,
        sizeTag,
        fillTag,
        outlineTag,
        bordTag,
        bgFillTag,
        bgAlphaTag,
        fadeTag,
      ].filter(Boolean).join('')

      const text = `{${styleTag}}${escapeAssText(e.text)}`

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
