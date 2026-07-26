import type { WordSpan } from './types'
import { computeKaraokeBreaks } from './karaoke-ass'

/**
 * REQ-0305 — Hormozi-style keyword emphasis: a per-cue visual that draws
 * a hand-picked subset of a cue's words in a punchy colour + larger size.
 *
 * This module owns the tier gate, the neutral defaults, the index
 * validation, and the burn-in text builder for the karaoke-OFF path.  It
 * layers on top of the same `WordSpan[]` + `computeKaraokeBreaks` machinery
 * karaoke uses (REQ-0285 / REQ-0294) so preview and burn-in wrap and split
 * words identically.
 *
 * Design notes:
 *   - Emphasis requires VALID per-word data (`areWordsValidForText`).  The
 *     emphasised indices refer to the specific real words the user toggled
 *     as chips, so — unlike karaoke — we never fabricate emphasis targets
 *     from the equal-split fallback (that would emphasise the wrong tokens).
 *   - Wrap positions come from the stored `\N` (inserted by
 *     `applyAutoLineBreak` at BASE font size).  The larger emphasised glyphs
 *     do not change where `\N` lands, so preview and burn-in always wrap at
 *     the same positions regardless of the size multiplier (REQ-0305 §2-3).
 */

/** Default emphasis colour — gold accent, distinct from karaoke yellow. */
export const EMPHASIS_DEFAULT_COLOR = '#FFD400'

/** Default emphasis size as a percent of the cue font size (130 = 1.3×). */
export const EMPHASIS_DEFAULT_SCALE_PERCENT = 130

/** Emphasis size multiplier clamp range (percent). */
export const EMPHASIS_SCALE_MIN_PERCENT = 100
export const EMPHASIS_SCALE_MAX_PERCENT = 200

/** ± step for the size-multiplier stepper. */
export const EMPHASIS_SCALE_STEP_PERCENT = 10

/**
 * REQ-0305 §1 — tier gate.  Mirrors `canUseKaraokeInTier` (REQ-0299):
 * keyword emphasis is FREE for every tier.  Kept as a single function so
 * (like karaoke) it is the sole decision surface — the 3 UI screens and
 * the ass-generator all consult this rather than inlining an `isMsix`
 * check.  Flip to `return isMsix` to make it paid again.
 */
export function canUseKeywordEmphasisInTier(_isMsix: boolean): boolean {
  return true
}

/**
 * Clamp a raw emphasis-scale percent into the supported range, rounding to
 * an integer.  `undefined` resolves to the default (130).
 */
export function clampEmphasisScalePercent(v: number | undefined): number {
  const raw = v ?? EMPHASIS_DEFAULT_SCALE_PERCENT
  if (!Number.isFinite(raw)) return EMPHASIS_DEFAULT_SCALE_PERCENT
  return Math.max(
    EMPHASIS_SCALE_MIN_PERCENT,
    Math.min(EMPHASIS_SCALE_MAX_PERCENT, Math.round(raw)),
  )
}

/**
 * Resolve the persisted `emphasizedWordIndices` into a validated `Set` of
 * in-range word indices.  Drops duplicates, non-integers, and stale indices
 * that fall outside the current word list (e.g. after the cue text changed
 * and the word count shrank).  Returns an empty set for `undefined`.
 */
export function resolveEmphasisIndices(
  indices: readonly number[] | undefined,
  wordCount: number,
): Set<number> {
  const out = new Set<number>()
  if (!indices) return out
  for (const i of indices) {
    if (Number.isInteger(i) && i >= 0 && i < wordCount) out.add(i)
  }
  return out
}

/**
 * Toggle a single word index in a persisted `emphasizedWordIndices` array,
 * returning a NEW sorted array (never mutates the input).  Used by the
 * inspector word-chip UI.  Indices outside `[0, wordCount)` are ignored on
 * add; the result is always sorted ascending for stable persistence.
 */
export function toggleEmphasisIndex(
  indices: readonly number[] | undefined,
  index: number,
  wordCount: number,
): number[] {
  const set = resolveEmphasisIndices(indices, wordCount)
  if (set.has(index)) {
    set.delete(index)
  } else if (Number.isInteger(index) && index >= 0 && index < wordCount) {
    set.add(index)
  }
  return [...set].sort((a, b) => a - b)
}

/**
 * REQ-0305 — build the ASS text body for the karaoke-OFF emphasis path.
 *
 * Mirrors `buildKaraokeAssText` exactly for `\N` handling (via
 * `computeKaraokeBreaks`), but instead of `\k` timing it wraps each
 * emphasised word in an override block that switches to the emphasis size +
 * colour, then restores the base size + colour after the word.  Every
 * override lives inside its own `{...}` block (REQ-0291 well-formedness).
 *
 * When no word is emphasised this reproduces the plain cue text (same word
 * reconstruction karaoke relies on), so callers should only use it when at
 * least one in-range index is present.
 *
 * @param openTag  override tag(s) WITHOUT braces, applied before an
 *                 emphasised word — e.g. `\fs150\c&H0034D4FF&`.
 * @param closeTag override tag(s) WITHOUT braces, applied after — e.g.
 *                 `\fs100\c&H00FFFFFF&`.
 */
export function buildEmphasisAssText(
  words: readonly WordSpan[],
  cueText: string,
  escapeText: (s: string) => string,
  emphasizedIndices: ReadonlySet<number>,
  openTag: string,
  closeTag: string,
): string {
  if (words.length === 0) return ''
  const breaks = computeKaraokeBreaks(cueText, words)
  const parts: string[] = []
  for (let i = 0; i < words.length; i++) {
    if (breaks.has(i)) parts.push('\\N')
    const rawWordText = breaks.has(i) ? words[i].text.replace(/^\s+/, '') : words[i].text
    const escaped = escapeText(rawWordText)
    if (emphasizedIndices.has(i)) {
      parts.push(`{${openTag}}${escaped}{${closeTag}}`)
    } else {
      parts.push(escaped)
    }
  }
  return parts.join('')
}
