import type { WordSpan } from './types'
import { stripAllWhitespace } from './words-validity'

/**
 * REQ-0305 / REQ-0306 — Hormozi-style keyword emphasis: a per-cue visual that
 * draws chosen parts of a cue's text in a punchy colour + larger size.
 *
 * ## REQ-0306 redesign — text/keyword based (NOT word-index based)
 *
 * The original REQ-0305 model stored `emphasizedWordIndices` into the Whisper
 * `words` array, so emphasis died the moment the user edited the cue text
 * (`areWordsValidForText` went false).  Owner verdict: unusable — transcripts
 * always need fixing.
 *
 * Emphasis fundamentally does NOT need word timing — it only needs "which part
 * of the text to emphasise".  So we now store a list of **keyword substrings**
 * (`emphasisKeywords`).  At render time we find every occurrence of each
 * keyword in the CURRENT `text` and emphasise those character ranges.  This:
 *   - survives text edits (the keyword is re-matched against the new text),
 *   - works on cues with NO / invalid `words` (the core requirement),
 *   - naturally emphasises every occurrence of a repeated keyword,
 *   - is forward-compatible with a future "global keyword list" feature.
 *
 * Karaoke still needs `words` (for timing) — it is untouched.  When BOTH are on
 * we map keyword ranges onto the karaoke word units (via stripped-text
 * alignment) so the emphasised words also grow + recolour (REQ-0306 §3).
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

// ---------------------------------------------------------------------------
// Keyword list management + migration
// ---------------------------------------------------------------------------

/** De-duplicate + trim a keyword list, dropping empties.  Order preserved. */
function normaliseKeywords(keywords: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of keywords) {
    const t = k.trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      out.push(t)
    }
  }
  return out
}

/**
 * REQ-0306 — resolve the emphasis keywords for a cue, migrating the legacy
 * REQ-0305 `emphasizedWordIndices` on the fly.
 *
 * - If `keywords` is defined (new format), it wins — even an empty array means
 *   "the user is on the new model with nothing selected".
 * - Otherwise, if legacy indices + words exist, derive keywords from the words
 *   at those indices (best-effort migration; unreleased so lossy is fine).
 * - Otherwise, no emphasis.
 *
 * Never throws.
 */
export function resolveEmphasisKeywords(
  keywords: readonly string[] | undefined,
  legacyIndices: readonly number[] | undefined,
  words: readonly WordSpan[] | undefined,
): string[] {
  if (keywords !== undefined) return normaliseKeywords(keywords)
  if (legacyIndices && legacyIndices.length > 0 && words && words.length > 0) {
    const migrated: string[] = []
    for (const i of legacyIndices) {
      if (Number.isInteger(i) && i >= 0 && i < words.length) {
        migrated.push(words[i].text)
      }
    }
    return normaliseKeywords(migrated)
  }
  return []
}

/** Add a keyword (trimmed) to the list, returning a NEW normalised array. */
export function addEmphasisKeyword(keywords: readonly string[] | undefined, kw: string): string[] {
  return normaliseKeywords([...(keywords ?? []), kw])
}

/** Remove a keyword (matched after trim) from the list, returning a NEW array. */
export function removeEmphasisKeyword(keywords: readonly string[] | undefined, kw: string): string[] {
  const target = kw.trim()
  return normaliseKeywords((keywords ?? []).filter((k) => k.trim() !== target))
}

/** Toggle a keyword — remove if present, add if not.  Returns a NEW array. */
export function toggleEmphasisKeyword(keywords: readonly string[] | undefined, kw: string): string[] {
  const target = kw.trim()
  if (!target) return normaliseKeywords(keywords ?? [])
  const present = (keywords ?? []).some((k) => k.trim() === target)
  return present ? removeEmphasisKeyword(keywords, kw) : addEmphasisKeyword(keywords, kw)
}

// ---------------------------------------------------------------------------
// Range matching
// ---------------------------------------------------------------------------

export type EmphasisRange = readonly [number, number]

/**
 * Find every occurrence of every keyword in `text` and return the merged,
 * sorted list of emphasised code-unit ranges `[start, end)`.  Matches are
 * literal + case-sensitive; overlapping matches merge into one range.  A
 * keyword never matches across a `\N` sentinel because keywords are trimmed
 * visible substrings (no backslash), so a literal `indexOf` stops at the
 * boundary naturally.
 */
export function computeEmphasisRanges(text: string, keywords: readonly string[]): EmphasisRange[] {
  const raw: Array<[number, number]> = []
  for (const kwRaw of keywords) {
    const kw = kwRaw.trim()
    if (!kw) continue
    let from = 0
    for (;;) {
      const idx = text.indexOf(kw, from)
      if (idx === -1) break
      raw.push([idx, idx + kw.length])
      from = idx + kw.length
    }
  }
  if (raw.length <= 1) return raw
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = [raw[0]]
  for (let i = 1; i < raw.length; i++) {
    const last = merged[merged.length - 1]
    if (raw[i][0] <= last[1]) {
      last[1] = Math.max(last[1], raw[i][1])
    } else {
      merged.push(raw[i])
    }
  }
  return merged
}

/** True if code-unit `offset` falls inside any emphasis range. */
export function isEmphasizedAt(offset: number, ranges: readonly EmphasisRange[]): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Rendering tokeniser (shared by CSS preview + ASS burn-in)
// ---------------------------------------------------------------------------

export type EmphasisToken =
  | { kind: 'break' }
  | { kind: 'text'; text: string; emphasized: boolean }

/**
 * Split `text` (which may contain `\N` sentinels) into a token stream of
 * line-breaks and maximal same-emphasis text runs, according to `ranges`.
 * The concatenation of the text tokens (with `\N` re-inserted for breaks)
 * reproduces the original text exactly, so when nothing is emphasised the
 * output is identical to the plain text — no parity risk.
 *
 * `\N` is always emitted as a break regardless of ranges, so a keyword that
 * happens to cover a sentinel char can never corrupt the line structure.
 */
export function tokenizeEmphasis(text: string, ranges: readonly EmphasisRange[]): EmphasisToken[] {
  const tokens: EmphasisToken[] = []
  let buf = ''
  let bufEmph = false
  const flush = (): void => {
    if (buf) {
      tokens.push({ kind: 'text', text: buf, emphasized: bufEmph })
      buf = ''
    }
  }
  let i = 0
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === 'N') {
      flush()
      tokens.push({ kind: 'break' })
      i += 2
      continue
    }
    const cp = text.codePointAt(i)!
    const len = cp > 0xffff ? 2 : 1
    const emph = isEmphasizedAt(i, ranges)
    if (buf && emph !== bufEmph) flush()
    if (!buf) bufEmph = emph
    buf += text.substr(i, len)
    i += len
  }
  flush()
  return tokens
}

/**
 * REQ-0306 — build the ASS text body for the karaoke-OFF emphasis path from
 * the keyword ranges.  Emits `\N` for breaks and wraps each emphasised run in
 * `{openTag}...{closeTag}` (both brace-enclosed — REQ-0291 well-formedness).
 * `escapeText` handles casing + ASS escaping per run.
 *
 * @param openTag  tag(s) WITHOUT braces before an emphasised run — e.g.
 *                 `\fs150\c&H0034D4FF&`.
 * @param closeTag tag(s) WITHOUT braces after — e.g. `\fs100\c&H00FFFFFF&`.
 */
export function buildEmphasisBody(
  text: string,
  ranges: readonly EmphasisRange[],
  escapeText: (s: string) => string,
  openTag: string,
  closeTag: string,
): string {
  const parts: string[] = []
  for (const tok of tokenizeEmphasis(text, ranges)) {
    if (tok.kind === 'break') {
      parts.push('\\N')
    } else if (tok.emphasized) {
      parts.push(`{${openTag}}${escapeText(tok.text)}{${closeTag}}`)
    } else {
      parts.push(escapeText(tok.text))
    }
  }
  return parts.join('')
}

// ---------------------------------------------------------------------------
// Karaoke coexistence — map keyword ranges onto karaoke word units
// ---------------------------------------------------------------------------

/**
 * REQ-0306 §3 — determine which karaoke word units are emphasised, by matching
 * the keywords against the whitespace-stripped cue text and testing each
 * word's stripped span for overlap.  Works for both the real `words` list and
 * the equal-split fallback units (both satisfy the stripped-concat === stripped
 * text invariant), so emphasis rides along with karaoke even on edited cues.
 *
 * Word-level (not character-level) granularity in the karaoke path: for
 * Japanese each word is a single character so this is exact; for English a
 * keyword that is a partial word emphasises the whole word — an acceptable,
 * documented approximation.
 */
export function emphasizedWordSet(
  cueText: string,
  words: readonly WordSpan[],
  keywords: readonly string[],
): Set<number> {
  const out = new Set<number>()
  const strippedKeywords = keywords
    .map((k) => stripAllWhitespace(k))
    .filter((k) => k.length > 0)
  if (strippedKeywords.length === 0 || words.length === 0) return out
  const strippedText = stripAllWhitespace(cueText)
  const ranges = computeEmphasisRanges(strippedText, strippedKeywords)
  if (ranges.length === 0) return out
  let cursor = 0
  for (let w = 0; w < words.length; w++) {
    const len = stripAllWhitespace(words[w].text).length
    if (len > 0) {
      const start = cursor
      const end = cursor + len
      for (const [s, e] of ranges) {
        if (s < end && e > start) {
          out.add(w)
          break
        }
      }
    }
    cursor += len
  }
  return out
}
