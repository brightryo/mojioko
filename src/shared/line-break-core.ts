/**
 * REQ-0456 — the pure auto-line-break algorithm, shared by the renderer
 * (`renderer/lib/auto-line-break.ts`) and the headless burn/transcribe path
 * (`main/services/headless-layout.ts`).
 *
 * It was extracted VERBATIM from `auto-line-break.ts` (REQ-0303/0306/0308/0309/
 * 0312/0315): the pixel budget decides how much fits, then kinsoku → Latin word
 * boundary → emphasis post-processors move the break earlier.  The ONLY change
 * from the renderer original is that the font metrics (`font`, `libassScale`,
 * `cmap`, `tofu`) arrive as an explicit `LineBreakMetrics` argument instead of
 * being read from the renderer's `font-metrics` singleton cache — so main can
 * supply metrics loaded from disk and produce byte-identical `\N` placement.
 *
 * Renderer parity is pinned by the existing auto-line-break tests, which still
 * run through `applyAutoLineBreak` (now a thin wrapper over this module).
 */
import { applyKinsoku, isNoLineStartChar, isNoLineEndChar } from './kinsoku'
import { isEmphasizedAt, type EmphasisRange } from './emphasis'
import { FALLBACK_LIBASS_SCALE } from './font-entry'
import type { Font } from 'opentype.js'

/** The font metrics the break finder needs — the renderer cache and the main loader both produce these. */
export interface LineBreakMetrics {
  /** Loaded opentype Font, or null to use the character-class fallback. */
  font: Font | null
  /** unitsPerEm / OS-2 winHeight for the effective font. */
  libassScale: number
  /** REQ-0160 — cmap coverage of the effective font, or null when unknown. */
  cmap: Set<number> | null
  /** REQ-0160 — tofu substitute for the effective font, or null when unknown. */
  tofu: string | null
}

/**
 * REQ-0306 §2 — emphasis width descriptor.  `ranges` are code-unit ranges into
 * the ORIGINAL `text` (with `\N`); `scale` is the emphasis size multiplier
 * (0.5–2.0 per REQ-0308 §4-4).  `null` everywhere = pre-REQ-0306 behaviour.
 */
type EmphAdvance = { ranges: readonly EmphasisRange[]; scale: number } | null

/**
 * Insert ASS `\N` line breaks wherever a line would exceed the effective video
 * width (`videoWidthPx − 2×marginLrPx − 2×outlineThicknessPx`).  See the module
 * docblock; the renderer's `applyAutoLineBreak` is a wrapper over this.
 */
export function applyAutoLineBreakCore(
  text: string,
  fontSizePx: number,
  outlineThicknessPx: number,
  videoWidthPx: number,
  marginLrPx: number,
  metrics: LineBreakMetrics,
  emphasis?: { ranges: readonly EmphasisRange[]; scale: number },
): string {
  const f = metrics.font
  const libassScale = metrics.libassScale
  const cmap = metrics.cmap
  const tofu = metrics.tofu
  const effectivePx = videoWidthPx - 2 * marginLrPx - 2 * outlineThicknessPx
  if (effectivePx <= 0) return text

  const emph: EmphAdvance =
    emphasis && emphasis.scale > 0 && emphasis.scale !== 1 && emphasis.ranges.length > 0
      ? { ranges: emphasis.ranges, scale: emphasis.scale }
      : null

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
// Internal helpers (verbatim from auto-line-break.ts — see that file / the
// auto-line-break.md spec for the derivation of each rule).
// ---------------------------------------------------------------------------

const WORD_CHAR = /[0-9A-Za-zÀ-ɏɐ-ʯ'’]/

function adjustBreak(seg: string, hardBreak: number): { leftEnd: number; rightStart: number } {
  const before = seg[hardBreak - 1]
  const after = seg[hardBreak]
  if (!before || !after || !WORD_CHAR.test(before) || !WORD_CHAR.test(after)) {
    return { leftEnd: hardBreak, rightStart: hardBreak }
  }
  for (let w = hardBreak - 1; w >= 1; w--) {
    if (/\s/.test(seg[w])) {
      return { leftEnd: w, rightStart: w + 1 }
    }
  }
  return { leftEnd: hardBreak, rightStart: hardBreak }
}

function pullBreakOutOfEmphasis(
  seg: string,
  hardBreak: number,
  emph: EmphAdvance,
  baseOffset: number,
): number | null {
  if (emph === null) return null
  const abs = baseOffset + hardBreak
  for (const [s, e] of emph.ranges) {
    if (abs > s && abs < e) {
      const local = s - baseOffset
      return local > 0 ? local : null
    }
  }
  return null
}

function breakSegment(
  seg: string,
  fontSizePx: number,
  effectivePx: number,
  font: Font | null,
  libassScale: number,
  cmap: Set<number> | null,
  tofu: string | null,
  emph: EmphAdvance,
  baseOffset: number,
): string {
  if (!seg) return seg

  const breakPos = findBreakIndex(seg, fontSizePx, effectivePx, font, libassScale, cmap, tofu, emph, baseOffset)
  if (breakPos === -1) return seg

  const violates = (le: number, rs: number): boolean => {
    const endChar = seg[le - 1]
    const startChar = seg[rs]
    return (
      (endChar !== undefined && isNoLineEndChar(endChar)) ||
      (startChar !== undefined && isNoLineStartChar(startChar))
    )
  }
  const resolve = (from: number) => adjustBreak(seg, applyKinsoku(seg, from))
  let settled = resolve(breakPos)
  let probe = breakPos
  while (violates(settled.leftEnd, settled.rightStart) && settled.leftEnd > 1) {
    probe = settled.leftEnd - 1
    settled = resolve(probe)
  }
  if (violates(settled.leftEnd, settled.rightStart)) settled = resolve(breakPos)
  const kinsokuPos = settled.leftEnd
  let { leftEnd, rightStart } = settled
  const pulled = pullBreakOutOfEmphasis(seg, kinsokuPos, emph, baseOffset)
  if (pulled !== null) {
    const adjusted = adjustBreak(seg, applyKinsoku(seg, pulled))
    if (adjusted.leftEnd > 0) ({ leftEnd, rightStart } = adjusted)
  }
  if (leftEnd <= 0) return seg

  const left = seg.slice(0, leftEnd)
  const right = seg.slice(rightStart)
  if (!right) return seg
  return left + '\\N' + breakSegment(right, fontSizePx, effectivePx, font, libassScale, cmap, tofu, emph, baseOffset + rightStart)
}

function findBreakIndex(
  seg: string,
  fontSizePx: number,
  effectivePx: number,
  font: Font | null,
  libassScale: number,
  cmap: Set<number> | null,
  tofu: string | null,
  emph: EmphAdvance,
  baseOffset: number,
): number {
  const mult = (off: number): number =>
    emph !== null && isEmphasizedAt(off, emph.ranges) ? emph.scale : 1
  if (font) {
    const scale = (fontSizePx / font.unitsPerEm) * libassScale
    const tofuAdvance = cmap !== null && tofu !== null
      ? (font.charToGlyph(tofu).advanceWidth ?? 0)
      : null
    const codePoints = [...seg]
    let cumulative = 0
    let byteOffset = 0

    for (let gi = 0; gi < codePoints.length; gi++) {
      const ch = codePoints[gi]
      const cp = ch.codePointAt(0)!
      let advance: number
      if (tofuAdvance !== null && cmap !== null && !cmap.has(cp)) {
        advance = tofuAdvance
      } else {
        advance = font.charToGlyph(ch).advanceWidth ?? 0
      }
      cumulative += advance * scale * mult(baseOffset + byteOffset)

      if (cumulative > effectivePx) {
        return byteOffset
      }

      if (gi + 1 < codePoints.length) {
        const nextCh = codePoints[gi + 1]
        const nextCp = nextCh.codePointAt(0)!
        const bothInCmap = cmap === null || (cmap.has(cp) && cmap.has(nextCp))
        if (bothInCmap) {
          cumulative += font.getKerningValue(font.charToGlyph(ch), font.charToGlyph(nextCh)) * scale
        }
      }

      byteOffset += ch.length
    }
  } else {
    let cumulative = 0
    let i = 0
    for (const char of seg) {
      const cp = seg.codePointAt(i) ?? 0
      const charWidth = (isWideCp(cp)
        ? fontSizePx * FALLBACK_LIBASS_SCALE
        : fontSizePx * 0.55 * FALLBACK_LIBASS_SCALE) * mult(baseOffset + i)
      cumulative += charWidth
      if (cumulative > effectivePx) {
        return i
      }
      i += char.length
    }
  }
  return -1
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
