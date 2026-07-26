import { ASS_MARGIN_LR_PX } from './tokens'
import {
  getSubtitleFont,
  getLibassScale,
  getSubtitleFontFor,
  getLibassScaleFor,
  getCmapCoverageFor,
  getTofuSubstituteFor,
  getActiveFontId,
  FALLBACK_LIBASS_SCALE
} from './font-metrics'
import type { SubtitleFont } from './font-metrics'
import type { FontId } from '../../shared/fonts'
import { isEmphasizedAt, type EmphasisRange } from '../../shared/emphasis'

/**
 * REQ-0306 §2 — emphasis width descriptor threaded through the break finder.
 * `ranges` are code-unit ranges into the ORIGINAL `text` (with `\N`), `scale`
 * is the emphasis size multiplier — REQ-0308 §4-4 allows 0.5–2.0, so it may be
 * BELOW 1 (a shrunk span measures narrower).  `null` everywhere = pre-REQ-0306
 * behaviour, byte-identical.
 */
type EmphAdvance = { ranges: readonly EmphasisRange[]; scale: number } | null

/**
 * Insert ASS \N line breaks into `text` wherever a line would exceed the
 * effective video width (videoWidthPx − 2×ASS_MARGIN_LR_PX − 2×outlineThicknessPx).
 *
 * Mirrors the glyph-advance logic in overflow-calculator.ts so that break
 * positions match what libass actually renders.
 *
 * - Existing \N separators are preserved; each sub-line is processed independently.
 * - Recursive: a single line that needs more than one break is handled correctly.
 * - Falls back to character-class width estimates when the font is not loaded.
 * - REQ-0303 — script-aware break placement.  The pixel budget still decides
 *   *how much* fits on a line, but where that budget lands inside a Latin word
 *   the break is moved back to the preceding word boundary so English words are
 *   never split (`wonder` → `won` / `der`).  CJK runs have no whitespace, so
 *   they keep the character-level behaviour byte-for-byte — Japanese-only cues
 *   wrap at exactly the same positions as before REQ-0303.  See `adjustBreak`.
 *
 * @param text               Raw subtitle text (may already contain \N).
 * @param fontSizePx         Subtitle font size in pixels.
 * @param outlineThicknessPx Subtitle outline thickness in pixels (0–OUTLINE_THICKNESS_MAX_PX).
 * @param videoWidthPx       Source video width in pixels.
 * @param font               Optional pre-loaded SubtitleFont; uses module cache if omitted.
 *                           Ignored when `fontId` is supplied.
 * @param fontId             Per-row font override (REQ-021).  When set, the
 *                           per-font cache is consulted for both the Font
 *                           reference and the libassScale, matching what
 *                           libass will actually render for that row.
 * @returns                  Text with \N inserted at overflow boundaries.
 */
export function applyAutoLineBreak(
  text: string,
  fontSizePx: number,
  outlineThicknessPx: number,
  videoWidthPx: number,
  font?: SubtitleFont | null,
  fontId?: FontId,
  // REQ-0306 §2 / REQ-0307 — when the cue has keyword emphasis, the emphasised
  // glyphs are physically larger, so the break finder must measure them at
  // `scale` to wrap correctly.  `ranges` are the caller's already-resolved
  // emphasis ranges in ORIGINAL-`text` coordinates (REQ-0307 moved resolution
  // to `shared/emphasis.ts:resolveEmphasis` so the anchored spans are matched
  // once, consistently, everywhere).  Omitted / empty ⇒ pre-REQ-0306
  // behaviour, byte-identical (Japanese-only cues without emphasis are
  // untouched).
  emphasis?: { ranges: readonly EmphasisRange[]; scale: number }
): string {
  const f = fontId !== undefined
    ? getSubtitleFontFor(fontId)
    : (font !== undefined ? font : getSubtitleFont())
  const libassScale = fontId !== undefined ? getLibassScaleFor(fontId) : getLibassScale()
  const effectivePx = videoWidthPx - 2 * ASS_MARGIN_LR_PX - 2 * outlineThicknessPx
  if (effectivePx <= 0) return text
  // REQ-0160 — resolve the tofu substitute for the effective font.  The
  // break-finder uses these to mirror the per-character advance
  // substitution in `overflow-calculator.ts` so break positions land
  // where libass will actually render the tofu-substituted text.
  const effectiveFontId = fontId ?? getActiveFontId()
  const cmap = getCmapCoverageFor(effectiveFontId)
  const tofu = getTofuSubstituteFor(effectiveFontId)

  // REQ-0306 §2 — `null` (no emphasis / no surviving span / scale exactly 1)
  // makes every path below byte-identical to the pre-REQ-0306 measurement.
  // REQ-0308 §4-4 — the guard is `!== 1` rather than `> 1`, because emphasis can
  // now shrink a span as well as grow it (50–200 %).  Measuring a shrunk span at
  // base size would break the line earlier than the burn-in needs.
  const emph: EmphAdvance =
    emphasis && emphasis.scale > 0 && emphasis.scale !== 1 && emphasis.ranges.length > 0
      ? { ranges: emphasis.ranges, scale: emphasis.scale }
      : null

  // Process each existing \N-separated segment independently, then rejoin —
  // preserves intentional manual breaks already in the text.  `base` tracks
  // each segment's start offset in the ORIGINAL text so `emph.ranges`
  // (original-text coords) map onto segment-local glyphs; the `+ 2` accounts
  // for the stripped `\N` separator between segments.
  const segments = text.split('\\N')
  const out: string[] = []
  let base = 0
  for (const seg of segments) {
    out.push(breakSegment(seg, fontSizePx, effectivePx, f, libassScale, cmap, tofu, emph, base))
    base += seg.length + 2
  }
  return out.join('\\N')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * REQ-0303 — a "word character" for the purpose of *not* splitting a Latin
 * word across a line break.  Covers ASCII letters + digits, the Latin-1 /
 * Latin-Extended letter blocks (accented Latin, IPA), and the two apostrophe
 * forms so `don't` / `l'ami` stay intact.  Deliberately excludes:
 *   - whitespace (that's where we *want* to break);
 *   - the hyphen / other punctuation (breaking after `state-of-` reads fine);
 *   - every CJK / wide code point (those match none of these ranges, so a
 *     CJK boundary is never treated as "mid-word" and keeps character-level
 *     wrapping — this is what preserves the pre-REQ-0303 Japanese positions).
 */
const WORD_CHAR = /[0-9A-Za-zÀ-ɏɐ-ʯ'’]/

/**
 * REQ-0303 — translate the pixel-accurate break index into the break that is
 * actually used, respecting Latin word boundaries.
 *
 * `hardBreak` is the index BEFORE which `seg` would overflow (the position the
 * pre-REQ-0303 algorithm broke at unconditionally).  Returns the code-unit
 * offsets `{ leftEnd, rightStart }` at which to split — `leftEnd < rightStart`
 * means the whitespace at `leftEnd` is consumed by the break (the standard
 * word-wrap behaviour where the wrapping space disappears).
 *
 * Rules:
 *   - If the split at `hardBreak` does NOT fall between two Latin word
 *     characters — i.e. either side is whitespace, punctuation, or a CJK /
 *     wide glyph — the position is returned unchanged.  Pure-CJK text always
 *     hits this branch (no `WORD_CHAR` ever matches a kana / kanji), so its
 *     break positions stay byte-identical to before REQ-0303.
 *   - Otherwise the break is mid-word: scan back to the last whitespace and
 *     break there, moving the whole word to the next line and consuming that
 *     one space.
 *   - If there is no whitespace before the break, the segment is a single word
 *     longer than one line — the forced mid-word split is kept as the
 *     unavoidable fallback (REQ-0303 §1 exception, "はみ出させない").
 */
function adjustBreak(seg: string, hardBreak: number): { leftEnd: number; rightStart: number } {
  const before = seg[hardBreak - 1]
  const after  = seg[hardBreak]
  // Not a Latin word split → keep the pixel-accurate position verbatim.
  if (!before || !after || !WORD_CHAR.test(before) || !WORD_CHAR.test(after)) {
    return { leftEnd: hardBreak, rightStart: hardBreak }
  }
  // Mid-word: back off to the last whitespace so the word is not cut.  `w >= 1`
  // keeps the left line non-empty (a leading space is never a break point).
  for (let w = hardBreak - 1; w >= 1; w--) {
    if (/\s/.test(seg[w])) {
      return { leftEnd: w, rightStart: w + 1 }
    }
  }
  // Single over-long word → unavoidable mid-word break (fallback).
  return { leftEnd: hardBreak, rightStart: hardBreak }
}

/**
 * Recursively insert \N into a single segment (no existing \N) until every
 * resulting sub-line fits within `effectivePx`.
 *
 * The pixel budget (`findBreakIndex`) decides how many glyphs fit; REQ-0303's
 * `adjustBreak` then nudges the split to a Latin word boundary when it would
 * otherwise fall inside a word.  CJK segments are unaffected by the nudge.
 */
function breakSegment(
  seg: string,
  fontSizePx: number,
  effectivePx: number,
  font: SubtitleFont | null,
  libassScale: number,
  cmap: Set<number> | null,
  tofu: string | null,
  emph: EmphAdvance,
  baseOffset: number,
): string {
  if (!seg) return seg

  const breakPos = findBreakIndex(seg, fontSizePx, effectivePx, font, libassScale, cmap, tofu, emph, baseOffset)
  if (breakPos === -1) return seg  // entire segment fits

  const { leftEnd, rightStart } = adjustBreak(seg, breakPos)
  // Defensive: an empty left line would recurse forever (only reachable if a
  // single glyph is wider than the whole line — impossible at real video
  // widths).  Leave the segment unbroken rather than loop.
  if (leftEnd <= 0) return seg

  const left  = seg.slice(0, leftEnd)
  const right = seg.slice(rightStart)
  if (!right) return seg  // nothing left to move to the next line
  // Recurse on the tail; its glyphs start at `baseOffset + rightStart` in the
  // ORIGINAL text so emphasis ranges keep lining up (REQ-0306 §2).
  return left + '\\N' + breakSegment(right, fontSizePx, effectivePx, font, libassScale, cmap, tofu, emph, baseOffset + rightStart)
}

/**
 * Return the code-unit index of the first character that pushes cumulative
 * advance width over `effectivePx`, or -1 if the whole segment fits.
 *
 * Matches the glyph loop in computeOverflowSync() exactly:
 *   scale = fontSizePx / unitsPerEm × libassScale
 *   cumulative += advance[gi]
 *   if (cumulative > effectivePx) → overflow starts at byteOffset
 *   cumulative += kerning[gi, gi+1]
 *   byteOffset += codePoint[gi].length
 */
function findBreakIndex(
  seg: string,
  fontSizePx: number,
  effectivePx: number,
  font: SubtitleFont | null,
  libassScale: number,
  cmap: Set<number> | null,
  tofu: string | null,
  emph: EmphAdvance,
  baseOffset: number,
): number {
  // REQ-0306 — advance multiplier for the glyph whose original-text offset is
  // `off`.  1 (identity) when there is no emphasis or the glyph isn't in an
  // emphasised range, so non-emphasised text measures exactly as before.
  const mult = (off: number): number =>
    emph !== null && isEmphasizedAt(off, emph.ranges) ? emph.scale : 1
  if (font) {
    const scale      = (fontSizePx / font.unitsPerEm) * libassScale
    // REQ-0160 — pre-fetch the tofu character's advance so per-character
    // substitution stays a single Set.has() branch inside the hot loop.
    // Null when the font isn't cached yet (fall through to raw
    // `stringToGlyphs` behaviour, matching overflow-calculator's contract).
    const tofuAdvance = cmap !== null && tofu !== null
      ? (font.charToGlyph(tofu).advanceWidth ?? 0)
      : null
    const codePoints = [...seg]
    let cumulative   = 0
    let byteOffset   = 0

    for (let gi = 0; gi < codePoints.length; gi++) {
      const ch = codePoints[gi]
      const cp = ch.codePointAt(0)!
      // REQ-0160 — same per-character substitution as `overflow-calculator.ts`.
      // A code point outside the font's cmap gets the tofu character's
      // advance so the break decision matches what libass will render.
      // Iterates the ORIGINAL string, so `byteOffset` remains a valid
      // slice offset even when the segment contains supplementary-plane
      // code points (surrogate pairs); the substitution never mutates
      // the text itself, only the per-character advance fed into
      // `cumulative`.
      let advance: number
      if (tofuAdvance !== null && cmap !== null && !cmap.has(cp)) {
        advance = tofuAdvance
      } else {
        advance = font.charToGlyph(ch).advanceWidth ?? 0
      }
      // REQ-0306 — inflate the emphasised glyph's advance so wrapping fires
      // where the larger burn-in glyph actually overflows.
      cumulative += advance * scale * mult(baseOffset + byteOffset)

      if (cumulative > effectivePx) {
        return byteOffset  // break BEFORE this glyph
      }

      if (gi + 1 < codePoints.length) {
        const nextCh = codePoints[gi + 1]
        const nextCp = nextCh.codePointAt(0)!
        // Skip kerning across a tofu boundary so the substituted glyph's
        // (undefined) kerning tables don't contaminate the advance.
        const bothInCmap = cmap === null || (cmap.has(cp) && cmap.has(nextCp))
        if (bothInCmap) {
          cumulative += font.getKerningValue(font.charToGlyph(ch), font.charToGlyph(nextCh)) * scale
        }
      }

      byteOffset += ch.length
    }
  } else {
    // Fallback: wide / narrow character-class estimates when the per-row font
    // is not yet in the opentype.js cache.  REQ-087 — apply
    // FALLBACK_LIBASS_SCALE so this fallback lands within ~1 % of the real
    // per-glyph measurement for every Google Fonts CJK family in the
    // registry (they all share `unitsPerEm / winHeight ≈ 0.6906`).  Without
    // it, the fallback overestimated wide chars by ~45 % and broke far
    // earlier than the burn-in would render — e.g. splitting the
    // sutegana cluster "しゃ" between "し" and "ゃ".  Mirror of the same
    // change in `overflow-calculator.ts`.
    let cumulative = 0
    let i          = 0
    for (const char of seg) {
      const cp        = seg.codePointAt(i) ?? 0
      const charWidth = (isWideCp(cp)
        ? fontSizePx * FALLBACK_LIBASS_SCALE
        : fontSizePx * 0.55 * FALLBACK_LIBASS_SCALE) * mult(baseOffset + i)
      cumulative += charWidth
      if (cumulative > effectivePx) {
        return i  // break BEFORE this character
      }
      i += char.length
    }
  }
  return -1  // whole segment fits
}

/** Mirror of isWide() in overflow-calculator.ts. */
function isWideCp(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33bf) ||
    (cp >= 0x33ff && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7ff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1b000 && cp <= 0x1b0ff) ||
    (cp >= 0x1f004 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  )
}
