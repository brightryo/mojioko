import { ASS_HARD_BREAK } from './line-spacing'

/**
 * REQ-0516 §1 — the ONE rule for whitespace at a display line's edges.
 *
 * ## What libass does, measured
 *
 * libass drops leading and trailing whitespace **on every display line**, not
 * merely at the event's edges.  Measured on real burned pixels with a
 * hand-written ASS (so the measurement is of libass, not of our writer): a cue
 * `テスト\Nです` and the four variants that add spaces before/after either
 * line all produce ink at exactly `x=[862,1053]`, byte-identical, while a space
 * *inside* a line widens it to `[839,1077]`.  The same holds whether the two
 * lines arrive as one event containing `\N` or as one event per line — which
 * matters because the all-`\pos` runtime emits both shapes.
 *
 * The preview, however, uses CSS `white-space: pre`, which preserves those
 * edge spaces.  So the preview was showing an indent that the exported video
 * would never have — the one thing Phase C forbids.
 *
 * ## The rule
 *
 * **Trim each display line's outer whitespace at RENDER time only.**
 *
 * - Per LINE, not per cue: line 2's leading space goes too (measured above).
 * - Interior whitespace is untouched.  That is REQ-0515's subject and the
 *   reason this is a trim and not a `.trim()` on the whole cue.
 * - Only the characters libass itself drops — ASCII space and tab.  See
 *   `EDGE_WS_START` below; a full-width space at a line edge IS drawn, in both
 *   engines.
 * - `entry.text` is NOT modified.  What the user typed stays in the store, in
 *   the textarea, and in the saved `.mojioko`; only the drawing drops it.
 * - The ASS writer is NOT changed either, so no emitted byte moves: libass
 *   already does this, and having MOJIOKO pre-trim would only duplicate it.
 *
 * ## Relationship to REQ-0294
 *
 * `buildKaraokeAssText` already strips the leading whitespace of a karaoke
 * unit that a `\N` lands in front of, so the burned second line does not
 * indent.  That is the same rule seen from the ASS side, restricted to the one
 * case that path could express.  This module is the general form, and the
 * preview's karaoke path now routes through it instead of keeping its own
 * copy of the strip — one rule, applied everywhere, rather than two rules that
 * happen to agree on one case.
 */

/**
 * The characters libass actually drops at a line edge — ASCII space and tab,
 * and NOTHING else.  Measured against real burned pixels by putting three of
 * each in front of a cue and comparing the ink box to the bare cue:
 *
 *   U+0020 space      DROPPED      U+3000 ideographic space   KEPT
 *   U+0009 tab        DROPPED      U+00A0 no-break space      KEPT
 *                                  U+2009 thin space          KEPT
 *
 * ★ This is deliberately NOT `\s`.  `\s` matches U+3000, which Japanese
 * keyboards produce constantly — trimming it would have made the preview wrong
 * in the OTHER direction, hiding a full-width space that the MP4 does draw.
 * The first cut of REQ-0516 used `\s` and the pixel gate caught it.
 */
const EDGE_WS_START = /^[ \t]+/
const EDGE_WS_END = /[ \t]+$/

/** Trim the leading whitespace of a line's opening run of pieces. */
function trimStart(pieces: string[]): void {
  for (let i = 0; i < pieces.length; i++) {
    pieces[i] = pieces[i].replace(EDGE_WS_START, '')
    // A piece that is ALL whitespace collapses to '' and the trim continues
    // into the next one, so a line built from several pieces trims as if it
    // were one string.
    if (pieces[i] !== '') return
  }
}

/** Trim the trailing whitespace of a line's closing run of pieces. */
function trimEnd(pieces: string[]): void {
  for (let i = pieces.length - 1; i >= 0; i--) {
    pieces[i] = pieces[i].replace(EDGE_WS_END, '')
    if (pieces[i] !== '') return
  }
}

/**
 * Trim the outer whitespace of one display line that is made of several
 * pieces (karaoke units, emphasis runs).  Returns a new array; interior
 * whitespace, and whitespace between pieces, is left alone.
 */
export function trimLineEdgePieces(pieces: readonly string[]): string[] {
  const out = [...pieces]
  trimStart(out)
  trimEnd(out)
  return out
}

/**
 * Trim every display line of a whole cue whose pieces are indexed 0..n-1 and
 * whose line breaks are given as "a break sits BEFORE piece i" — the shape
 * both the karaoke path (`computeKaraokeBreaks`) and the emphasis path
 * (a `break` token) already produce.
 */
export function trimPiecesByBreaks(
  pieces: readonly string[],
  breakBefore: (index: number) => boolean,
): string[] {
  const out: string[] = []
  let line: string[] = []
  const flush = (): void => {
    if (line.length > 0) out.push(...trimLineEdgePieces(line))
    line = []
  }
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0 && breakBefore(i)) flush()
    line.push(pieces[i])
  }
  flush()
  return out
}

/**
 * Trim every display line of a plain cue string.  `\N` separators are
 * preserved exactly, so the result is still a cue text — just one whose lines
 * have no outer whitespace.
 */
export function trimCueTextLineEdges(text: string): string {
  return text
    .split(ASS_HARD_BREAK)
    .map((line) => line.replace(EDGE_WS_START, '').replace(EDGE_WS_END, ''))
    .join(ASS_HARD_BREAK)
}
