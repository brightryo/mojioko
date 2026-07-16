/**
 * REQ-0160 — replace code points not in the selected font's cmap with a
 * "tofu" substitute so libass and the preview both render a visible
 * placeholder instead of silently falling back to a system font.
 *
 * Motivation: before this REQ, choosing an EN-only font (Anton, Bebas Neue,
 * Montserrat, Poppins) and typing Japanese text would (a) show fake
 * "works" behaviour by rendering the Japanese via system-font fallback,
 * and (b) mis-measure line width in `overflow-calculator.ts` /
 * `auto-line-break.ts` because their glyph loop hits the font's `.notdef`
 * (narrow ≈ 0.5 em) while libass renders the fallback JP font's real
 * glyph (wide ≈ 1.0 em).  The 2× mismatch caused auto-break to insert
 * no `\N` and the subtitle ran off the right edge of the frame.
 *
 * Substituting missing code points with a font-native placeholder
 * character achieves TWO things at once:
 *   1. The visible tofu makes the mismatch obvious to the user, matching
 *      DaVinci Resolve semantics and REQ-0153's "tofu-tolerant" policy.
 *   2. Measurement now sees the same character libass will render,
 *      because the substitute IS in the font's cmap (that is the
 *      invariant of the picker in `font-metrics.ts`), so `overflow` and
 *      `auto-line-break` become correct as a side effect.
 *
 * Pure function (no fs / opentype.js dep).  Caller supplies:
 *   - `cmapCoverage`   the Set<number> of code points the font declares
 *   - `tofuSubstitute` the specific character string to insert; picked
 *                      per-font at load time from an ordered candidate
 *                      list (U+25A1 preferred, U+FFFD next, U+003F last).
 *                      String rather than code point so a caller that
 *                      wanted a multi-char marker (unused today) could
 *                      supply one without changing the return contract.
 *
 * `SubtitleEntry.text` is never mutated in place — this function is
 * invoked at render / measure time to produce a derived string.  The
 * editor UI keeps showing the original text.
 */

/**
 * Preferred code point for the substitute.  U+25A1 (□ WHITE SQUARE)
 * matches the DaVinci-Resolve tofu appearance.  Exported so
 * `font-metrics.ts` can seed its per-font pick list without duplicating
 * the constant, and so tests can reference it symbolically instead of
 * hard-coding `'□'`.
 */
export const TOFU_PREFERRED_CODE_POINT = 0x25A1

/**
 * Ordered candidate list used by the per-font picker.  Every entry is a
 * "rectangle-ish" or "missing-glyph"-signalling character that a font
 * might reasonably include.  U+003F "?" is a hard last resort — it's
 * present in EVERY font in the current registry (REQ-0154 §Part B
 * verified the ASCII probes hit 6/6 for all 13 fonts), so the picker
 * always finds at least one candidate.
 *
 * Order rationale (from Step 0 probe in REQ-0160 §1):
 *   - U+25A1 hits 10 / 13 fonts (all four candidates for pure-JP faces
 *     + Anton + Montserrat).
 *   - U+FFFD hits Mochiy Pop One (which lacks U+25A1).
 *   - U+003F is the guaranteed fallback for Bebas Neue + Poppins.
 */
export const TOFU_CANDIDATE_CODE_POINTS: readonly number[] = Object.freeze([
  TOFU_PREFERRED_CODE_POINT,              // U+25A1 □
  0x2610,                                  // U+2610 ☐ BALLOT BOX
  0x25AF,                                  // U+25AF ▯ WHITE VERTICAL RECTANGLE
  0xFFFD,                                  // U+FFFD � REPLACEMENT CHARACTER
  0x25FB,                                  // U+25FB ◻ WHITE MEDIUM SQUARE
  0x25A0,                                  // U+25A0 ■ BLACK SQUARE
  0x2588,                                  // U+2588 █ FULL BLOCK
  0x003F,                                  // U+003F ? (universal fallback)
])

/**
 * Walk `text` code-point-by-code-point.  When a code point is not in
 * `cmapCoverage`, replace it with `tofuSubstitute`.  Otherwise pass
 * through verbatim.
 *
 * Fast-path skips:
 *   - ASCII control characters (`< 0x20`) — never substituted so the
 *     ASS `\N` marker (two characters `\` + `N`, both ASCII printable
 *     ≥ 0x20 but relied on by libass control-code detection) and any
 *     transient `\n` newlines pass through unchanged.  A font that
 *     technically doesn't have U+000A in cmap would otherwise get a
 *     tofu inserted into a control position, breaking libass wrap.
 *   - ASCII space (`0x20`) — always available and always the correct
 *     visual (a gap, not a tofu).  Kept as a defensive rule even though
 *     every font in the current registry does declare U+0020.
 *
 * Returns the original string reference when no substitution was needed
 * (=every code point was in `cmapCoverage`).  Callers relying on
 * shallow-equal reference checks (React memoisation) therefore skip
 * re-renders on the common "text is fully supported" path.
 */
export function substituteMissingGlyphs(
  text: string,
  cmapCoverage: Set<number>,
  tofuSubstitute: string,
): string {
  // Fast pre-check: if every code point is present, avoid allocating a
  // new string.  This makes the JA-font + JA-text hot path a single
  // Set.has() per code point with no builder overhead.
  let needsWork = false
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || cp === 0x20) continue
    if (!cmapCoverage.has(cp)) { needsWork = true; break }
  }
  if (!needsWork) return text

  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || cp === 0x20) { out += ch; continue }
    out += cmapCoverage.has(cp) ? ch : tofuSubstitute
  }
  return out
}

/**
 * Pick the substitute character for a font from its cmap coverage using
 * `TOFU_CANDIDATE_CODE_POINTS`.  Called once at font-load time; result
 * is cached alongside the font entry.
 *
 * Returns U+003F "?" if none of the candidates match — but that branch
 * is unreachable in practice because "?" is itself the last candidate
 * and every registered font declares basic ASCII (REQ-0154 verified).
 */
export function pickTofuSubstitute(cmapCoverage: Set<number>): string {
  for (const cp of TOFU_CANDIDATE_CODE_POINTS) {
    if (cmapCoverage.has(cp)) return String.fromCodePoint(cp)
  }
  return '?'
}
