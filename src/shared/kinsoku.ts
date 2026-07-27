/**
 * REQ-0312 §2 — 禁則処理 (kinsoku): Japanese line-breaking prohibitions.
 *
 * Two rules, both expressed as "this character may not sit at that edge of a
 * line":
 *
 *   行頭禁則 (no-line-START) — closing brackets, punctuation, small kana, the
 *                              long-vowel mark.  A line may not BEGIN with one.
 *   行末禁則 (no-line-END)   — opening brackets.  A line may not END with one.
 *
 * Both are resolved by 追い出し ("pushing out"): move the break EARLIER so the
 * offending character travels to the next line together with the character it
 * belongs to.  Never later — moving a break later would widen the line and
 * could overflow, and 「never overflow」 outranks typographic polish everywhere
 * else in the wrap algorithm (auto-line-break spec §1).
 *
 * ## Half-width / ASCII counterparts are deliberately EXCLUDED
 *
 * The tables below are full-width and CJK-specific only — no `)`, `]`, `}`,
 * `!`, `?`, `.`, `,`.  Two reasons:
 *
 *   1. REQ-0312 forbids changing how English wraps, and Latin text is already
 *      protected by `adjustBreak`'s word-boundary rule, which keeps `word.`
 *      and `(word)` intact without any kinsoku involvement.  Adding ASCII
 *      punctuation would put the two rules in competition for no gain.
 *   2. faster-whisper emits full-width punctuation for Japanese, so the
 *      half-width forms essentially do not occur in the text this runs on.
 *
 * `’` (U+2019) is excluded from the closing set for the same reason even though
 * it is a legitimate Japanese closing quote: it doubles as the English
 * apostrophe and is already listed in `auto-line-break.ts`'s `WORD_CHAR` so
 * `don’t` stays intact.  Letting kinsoku claim it too would make two rules
 * fight over the same code point in English text.
 *
 * Extending any of this is a one-line edit here — that is why the tables live
 * in one place (REQ-0312 §2 requirement).
 */

/**
 * Characters that may not START a line (行頭禁則).
 *
 * Grouped as: punctuation / small kana / closing brackets / units.
 */
export const KINSOKU_NO_LINE_START =
  // punctuation, iteration and sound marks, long-vowel mark
  '。、，．・：；？！ー゛゜ヽヾゝゞ々' +
  // small kana (hiragana then katakana)
  'ぁぃぅぇぉっゃゅょゎ' +
  'ァィゥェォッャュョヮヵヶ' +
  // closing brackets and quotes (see the docblock re: U+2019)
  '）］｝」』】〉》〕”〟' +
  // units that bind to the preceding number
  '％℃‰'

/** Characters that may not END a line (行末禁則) — opening brackets and quotes. */
export const KINSOKU_NO_LINE_END = '（［｛「『【〈《〔“‘〝'

const NO_LINE_START = new Set(Array.from(KINSOKU_NO_LINE_START))
const NO_LINE_END = new Set(Array.from(KINSOKU_NO_LINE_END))

/**
 * How far the break may be pulled back before kinsoku gives up.
 *
 * A run like `」。` needs 2; `）」。` needs 3.  Beyond a handful the line is
 * being shortened enough to look worse than the violation it is fixing — and a
 * pathological run (a line of nothing but 。) would otherwise walk the break
 * all the way to zero.  On exceeding this the ORIGINAL break is used: REQ-0312
 * §2 explicitly prefers "keep the original position" over breaking the layout.
 */
export const KINSOKU_MAX_SHIFT = 4

export function isNoLineStartChar(ch: string): boolean {
  return NO_LINE_START.has(ch)
}

export function isNoLineEndChar(ch: string): boolean {
  return NO_LINE_END.has(ch)
}

/**
 * Moves `hardBreak` earlier until neither prohibition is violated.
 *
 * `seg[hardBreak]` is the first character of the NEXT line; `seg[hardBreak - 1]`
 * is the last character of the CURRENT line.
 *
 * Returns the adjusted code-unit index, or `hardBreak` unchanged when the
 * position is already legal or when no legal position is reachable (see
 * `KINSOKU_MAX_SHIFT`, and the empty-left-line guard).
 *
 * ## Termination
 *
 * Both rules move the index in the SAME direction (strictly decreasing), so
 * they cannot ping-pong against each other, and the loop is additionally bounded
 * by `KINSOKU_MAX_SHIFT`.  The function is therefore total, with no retry
 * budget or convergence assumption — which is what lets the caller compose it
 * with the other break post-processors without re-proving termination.
 */
export function applyKinsoku(seg: string, hardBreak: number): number {
  if (hardBreak <= 0 || hardBreak >= seg.length) return hardBreak

  let b = hardBreak
  while (b > 0 && hardBreak - b <= KINSOKU_MAX_SHIFT) {
    const next = seg[b]
    const prev = seg[b - 1]
    const violates =
      (next !== undefined && NO_LINE_START.has(next)) ||
      (prev !== undefined && NO_LINE_END.has(prev))
    if (!violates) break
    b--
    // Never leave the index between a surrogate pair; the kinsoku tables are
    // all BMP, but the surrounding text may not be.
    while (b > 0 && isLowSurrogate(seg.charCodeAt(b))) b--
  }

  // Fallback (REQ-0312 §2): an empty left line, or a run of prohibited
  // characters too long to escape, means there is no better position — keep the
  // pixel-accurate one rather than break the layout.
  if (b <= 0) return hardBreak
  if (hardBreak - b > KINSOKU_MAX_SHIFT) return hardBreak
  // Still violating after exhausting the budget → the original stands.
  const next = seg[b]
  const prev = seg[b - 1]
  if (
    (next !== undefined && NO_LINE_START.has(next)) ||
    (prev !== undefined && NO_LINE_END.has(prev))
  ) {
    return hardBreak
  }
  return b
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}
