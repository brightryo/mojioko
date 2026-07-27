/**
 * REQ-0332 — line spacing (行間), shared by the ASS writer and the preview.
 *
 * ## What the number means
 *
 * `lineSpacingPercent` is a percentage OF THE FONT SIZE, not a pixel gap.
 * The line pitch libass uses for a `\N` inside one Dialogue event is exactly
 * `entry.fontSizePx` (measured in REQ-20260614-001 補遺⑳ and re-measured in
 * REQ-0332 §6: `\fs100` two-line cue → 100.000px between the two lines'
 * ink tops, `\fs150` → 150).  So the natural unit for "make it tighter /
 * looser" is a multiplier on that pitch, and 0 % must reproduce it exactly.
 *
 * ## ★ There is NO libassScale factor in the pitch
 *
 * RES-0330 §2 wrote the pitch as `fontSizePx × libassScale × (1 + s/100)`.
 * That is **wrong** and REQ-0332 asked for it to be checked before being
 * built on.  It was: a `\fs100` cue's measured pitch is 100.000, not 69.06.
 * libassScale is a PREVIEW-side correction (the browser and libass disagree
 * about what `font-size` means), and on the preview side it cancels —
 *
 *     CSS line box = fontSize_css × lineHeight
 *                  = (fs × libassScale × scale) × (1 / libassScale)
 *                  = fs × scale
 *
 * which is REQ-0322 §1 / REQ-0324 §4-2's invariant.  Line spacing multiplies
 * BOTH sides of that identity by the same factor, so the cancellation is
 * preserved and the preview's line box stays `fs × scale × factor`.
 */

/** Tightest allowed spacing — lines overlap noticeably below this. */
export const LINE_SPACING_MIN_PERCENT = -50
/** Loosest allowed spacing. */
export const LINE_SPACING_MAX_PERCENT = 100
/** Absent / unset ⇒ today's output, exactly. */
export const LINE_SPACING_DEFAULT_PERCENT = 0
/** Slider granularity, in percent. */
export const LINE_SPACING_STEP_PERCENT = 1

/** Clamp an arbitrary number into the supported range. */
export function clampLineSpacingPercent(value: number): number {
  if (!Number.isFinite(value)) return LINE_SPACING_DEFAULT_PERCENT
  return Math.max(LINE_SPACING_MIN_PERCENT, Math.min(LINE_SPACING_MAX_PERCENT, value))
}

/** The field as it appears on a cue or on the transcription defaults. */
export interface LineSpacingCarrier {
  lineSpacingPercent?: number
}

/**
 * Read a cue's spacing.  Absent ⇒ 0, which every caller below turns into a
 * factor of exactly 1 — the "absent reproduces today's output" contract.
 */
export function resolveLineSpacingPercent(entry: LineSpacingCarrier): number {
  return typeof entry.lineSpacingPercent === 'number'
    ? clampLineSpacingPercent(entry.lineSpacingPercent)
    : LINE_SPACING_DEFAULT_PERCENT
}

/**
 * The multiplier applied to the natural one-line pitch.  Exactly 1 at 0 %,
 * which is what makes the whole feature a no-op by default — the ASS writer
 * tests `factor === 1` rather than `percent === 0` nowhere, but every
 * arithmetic path below collapses to the pre-REQ-0332 expression at 1.
 */
export function lineSpacingFactor(percent: number): number {
  return 1 + clampLineSpacingPercent(percent) / 100
}

/**
 * Vertical distance between the same point of two consecutive display
 * lines, in ASS pixels.
 *
 * **Measured, not assumed** — see the header block.
 */
export function linePitchAssPx(fontSizePx: number, percent: number): number {
  return fontSizePx * lineSpacingFactor(percent)
}

/**
 * The libass hard line-break marker as it appears inside a cue's stored
 * `text` (backslash + `N`).  Protected convention (CLAUDE.md §21) — this
 * constant NAMES it, it does not redefine it.
 */
export const ASS_HARD_BREAK = '\\N'

/** Number of display lines a cue's stored text produces. */
export function cueLineCount(text: string): number {
  return 1 + (text.match(/\\N/g)?.length ?? 0)
}

/** The subset of a cue this module needs to size and place it. */
export interface LineSpacingCueGeometry extends LineSpacingCarrier {
  text: string
  fontSizePx: number
  outlineThicknessPx: number
}

/**
 * REQ-20260614-001 補遺⑳ — the cue's collision-aware height in ASS pixels.
 *
 *     (lineCount − 1) × pitch + fontSizePx + 2 × outlineThicknessPx
 *
 * The last term is the libass `fix_collisions` padding (isolated by the
 * bord0/bord20 probes of 補遺⑳).  The rest is the INK extent: the lines'
 * anchors are `pitch` apart, and the topmost line still puts a full
 * `fontSizePx` of glyph above its own anchor no matter how tight the pitch
 * is.  At 0 % this collapses to the pre-REQ-0332 `lineCount × fontSizePx`
 * exactly.
 *
 * ★ It is deliberately NOT `lineCount × pitch`, which is what the CSS box
 * measures.  REQ-0332 §6 burned a −50 % two-line cue underneath a one-line
 * cue and the `lineCount × pitch` form let them collide by 8 px: at a
 * negative spacing the glyphs overflow their own line boxes upward, and a
 * box-sized reservation does not see that overflow.  At a POSITIVE spacing
 * the same form over-reserved by half a pitch instead.
 *
 * REQ-0332 moved this out of `estimateOverlayHeightPx` so the ASS writer can
 * feed the very same number into `computeFixedStackOffsets`.  The preview
 * function is now `estimateCueHeightAssPx(entry) * scale`.
 */
export function estimateCueHeightAssPx(entry: LineSpacingCueGeometry): number {
  const pitch = linePitchAssPx(entry.fontSizePx, resolveLineSpacingPercent(entry))
  const lines = cueLineCount(entry.text)
  return (lines - 1) * pitch + entry.fontSizePx + 2 * entry.outlineThicknessPx
}

/**
 * REQ-0332 §4 — the PREVIEW-ONLY correction that keeps CSS half-leading from
 * moving the block relative to the burn-in.
 *
 * CSS splits the difference between `line-height` and `font-size` evenly
 * above and below every line.  So raising the line-height by `d` pushes a
 * bottom-anchored block's LAST line up by `d/2`, and pulls a top-anchored
 * block's FIRST line down by `d/2` — while libass, which is being told each
 * line's anchor explicitly, keeps both exactly where they were.  Shifting the
 * CSS box by this amount cancels that.
 *
 * Centre-anchored cues need NO correction: the half-leadings above the first
 * line and below the last are equal, so the anchor set stays centred on the
 * same point at every spacing.
 *
 * Zero at 0 %, so nothing about the existing preview moves.
 */
export function lineLeadingCorrectionAssPx(fontSizePx: number, percent: number): number {
  return (linePitchAssPx(fontSizePx, percent) - fontSizePx) / 2
}

// ---------------------------------------------------------------------------
// Per-line anchors — where each display line's `\pos` goes
// ---------------------------------------------------------------------------

export interface CueLineAnchorInput {
  /** How many events the cue is being split into. */
  lineCount: number
  /** Distance between consecutive lines, ASS px (`linePitchAssPx`). */
  pitchPx: number
  horizontalPosition: 'left' | 'center' | 'right'
  verticalPosition: 'top' | 'center' | 'bottom'
  /**
   * Distance from the anchored edge in ASS px, **including** any collision
   * stack offset the caller resolved.  Ignored for `center` (libass `\an4/5/6`
   * has no reference edge — REQ-0140), where the caller should instead fold
   * the stack offset into `centerOffsetPx`.
   */
  verticalMarginPx: number
  /** Downward shift applied to a `center`-anchored cue (stack offset). */
  centerOffsetPx?: number
  playResX: number
  playResY: number
  /** Left/right margin, ASS px (`ASS_MARGIN_LR_PX`). */
  marginLrPx: number
  /** Pinned coordinates.  When BOTH are given they replace the anchor. */
  posX?: number
  posY?: number
}

export interface CueLineAnchor {
  x: number
  y: number
}

/**
 * Where each display line of a split cue must be pinned so the block lands
 * exactly where libass would have put the unsplit cue.
 *
 * ## Derivation
 *
 * `\an<N>` decides WHICH point of a text box sits at `\pos`, so no text
 * measurement is needed (event-splitting.md §4 / §6):
 *
 *   x = left → MarginL, centre → PlayResX/2, right → PlayResX − MarginR
 *
 * For y, libass lays a cue's L lines out as L cells of `pitch` each and
 * anchors the resulting block against the alignment's edge.  Splitting the
 * block into L single-line events, each anchored with the SAME `\an`, puts
 * line i's anchor point at:
 *
 *   bottom (an1/2/3): PlayResY − MarginV − (L−1−i) × pitch
 *   top    (an7/8/9): MarginV + i × pitch
 *   middle (an4/5/6): PlayResY/2 + (i − (L−1)/2) × pitch
 *
 * ## Evidence
 *
 * REQ-0332 §6 burned 10 pairs through ffmpeg/libass — an1/2/3/5/7/8, L = 2
 * and 3, MarginV 40/60/200, `\fs100` and `\fs150`, Latin and Japanese — and
 * compared the **raw RGB frames** of the unsplit cue against the same cue
 * split into per-line `\pos` events at spacing 0 %.  All ten were
 * BYTE-IDENTICAL, not merely close.  That is the strongest available check
 * that this arithmetic reproduces libass's own placement, and it is the
 * reason the feature can be built on top of it.
 *
 * A pinned cue (`\pos`, 機能B) uses its pinned point in place of the
 * edge-derived anchor, with the same per-line arithmetic around it.
 */
export function cueLineAnchors(input: CueLineAnchorInput): CueLineAnchor[] {
  const { lineCount, pitchPx, playResX, playResY, marginLrPx } = input
  const pinned = input.posX !== undefined && input.posY !== undefined

  const x = pinned
    ? (input.posX as number)
    : input.horizontalPosition === 'left'
      ? marginLrPx
      : input.horizontalPosition === 'right'
        ? playResX - marginLrPx
        : playResX / 2

  const centerOffset = input.centerOffsetPx ?? 0
  const out: CueLineAnchor[] = []
  for (let i = 0; i < lineCount; i++) {
    let y: number
    if (input.verticalPosition === 'bottom') {
      const base = pinned ? (input.posY as number) : playResY - input.verticalMarginPx
      y = base - (lineCount - 1 - i) * pitchPx
    } else if (input.verticalPosition === 'top') {
      const base = pinned ? (input.posY as number) : input.verticalMarginPx
      y = base + i * pitchPx
    } else {
      const base = pinned ? (input.posY as number) : playResY / 2 + centerOffset
      y = base + (i - (lineCount - 1) / 2) * pitchPx
    }
    out.push({ x, y })
  }
  return out
}

/**
 * Format an ASS coordinate.  `\pos` accepts fractions, but a spacing like
 * −33 % on `\fs73` produces values such as `940.0000000000001`; three
 * decimals is far below a rendered pixel and keeps the file readable.
 */
export function formatAssCoord(value: number): string {
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}
