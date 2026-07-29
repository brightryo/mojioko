import type { WordSpan } from './types'

/**
 * REQ-0289 §1–§2 — equal-split karaoke fallback.
 *
 * ## Why this exists
 *
 * REQ-0286 added karaoke that syncs to per-word Whisper timestamps
 * (`entry.words`).  REQ-0288 preserves those timestamps through text
 * edits, but the render-time predicate `areWordsValidForText` returns
 * `false` whenever the current text no longer matches the words'
 * concatenation (user rewrote the cue, split/merged cues, imported
 * from SRT, etc.).  Prior to REQ-0289 those cues fell through to plain
 * rendering — the karaoke sweep just vanished, producing an
 * inconsistent mix of highlighted and plain cues in a single video.
 *
 * REQ-0289 turns that fallback into an *equal-split* karaoke: the cue's
 * display window is divided evenly across its visible units (JA
 * characters, EN words, mixed by run) and the same libass `\k` machinery
 * + preview rAF drives the sweep.  Users get "some" karaoke on every
 * cue where the toggle is on; only cues with the toggle *off* fall
 * through to plain rendering.
 *
 * ## What this ISN'T
 *
 * A replacement for Whisper timing.  When `entry.words` still aligns
 * with `entry.text` the ass-generator / subtitle-overlay branches
 * continue to feed the real word list into karaoke-ass.ts unchanged
 * (REQ-0289 constraint: "words 有効時は Whisper timing のまま").
 * Equal-split is deliberately approximate — CJK characters and Latin
 * words rarely spend the same real-world duration on-screen, so the
 * sweep will run slightly ahead or behind the actual speech.  This is
 * the intended trade-off vs. "no karaoke at all".
 *
 * ## Unit-splitting rule
 *
 * - Each **CJK codepoint** (Hiragana / Katakana / Han / Hangul /
 *   CJK punctuation / fullwidth forms) is one unit.  CJK is written
 *   without inter-character whitespace, so per-character granularity
 *   is the natural karaoke rhythm.
 * - Each **Latin run** (letters/digits/punctuation delimited by
 *   whitespace or CJK) is one unit.  Latin has explicit word
 *   boundaries via whitespace; splitting per character would produce
 *   distractingly fine-grained sweeps.
 * - Whitespace and the libass `\N` hard-break sentinel are NOT counted
 *   as units.  For splitting purposes `\N` is treated as a single
 *   space so a `Hello\Nworld` cue tokenises to `[Hello, ' world']`
 *   (preserving the space between the Latin words).  On a JA cue like
 *   `こんにちは\N世界` this introduces a phantom leading space on the
 *   first unit after the break — a known trade-off for using fallback
 *   timing.  The precise-timing path (words valid) is unaffected.
 *
 * ## Duration formula
 *
 *   perUnit = (cueEnd - cueStart) / units.length
 *   unit[i].startSec = cueStart + i * perUnit
 *   unit[i].endSec   = cueStart + (i + 1) * perUnit
 *
 * `buildKaraokeAssText` (in karaoke-ass.ts) then computes each unit's
 * `\k` centisecond count from the **next** unit's startSec, so a
 * rounding drift in the middle of the cue can't accumulate past the
 * cue's total duration.
 *
 * ## Zero-unit / zero-duration safety
 *
 * Returns an empty array (→ ass-generator / subtitle-overlay treat as
 * "karaoke inactive" → plain fallback) when either:
 *   - `splitTextIntoKaraokeUnits(text)` yields no units (empty text,
 *     whitespace-only text, `\N`-only text, etc.), or
 *   - `cueEndSec <= cueStartSec` (defensive; a well-formed cue always
 *     has positive duration but the guard avoids `perUnit = ±Infinity`
 *     if an upstream bug ever produces a degenerate span).
 *
 * These cases collapse to `karaokeWords.length === 0 →
 * karaokeActive = false → plain rendering`, matching REQ-0289's
 * ゼロ除算回避 requirement without a separate branch at every caller.
 */
export function buildFallbackKaraokeUnits(
  text: string,
  cueStartSec: number,
  cueEndSec: number,
): WordSpan[] {
  const units = splitTextIntoKaraokeUnits(text)
  if (units.length === 0) return []
  const duration = cueEndSec - cueStartSec
  if (duration <= 0) return []
  const perUnit = duration / units.length
  return units.map((u, i) => ({
    startSec: cueStartSec + i * perUnit,
    endSec: cueStartSec + (i + 1) * perUnit,
    text: u,
  }))
}

/**
 * REQ-0289 §2 — tokenise a cue text into karaoke units for the
 * equal-split fallback.  See `buildFallbackKaraokeUnits` for the
 * rationale; this function is the pure lexer half so tests can pin
 * the tokeniser without going through duration arithmetic.
 *
 * Detection ranges:
 *   - Hiragana: U+3040-U+309F
 *   - Katakana: U+30A0-U+30FF
 *   - CJK Unified Ideographs: U+4E00-U+9FFF
 *   - CJK Symbols/Punctuation: U+3000-U+303F
 *   - Fullwidth ASCII / Halfwidth Katakana: U+FF00-U+FFEF
 *   - Hangul Syllables: U+AC00-U+D7AF
 *
 * Codepoints outside these ranges (basic ASCII, Latin-1 Supplement,
 * accented Latin, etc.) are treated as Latin.  Non-BMP CJK extensions
 * (surrogate pairs in the U+20000+ range) fall through to the Latin
 * branch — negligible in practice and simplifies iteration.
 */
export function splitTextIntoKaraokeUnits(text: string): string[] {
  // `\N` sentinel → single space so Latin `Hello\Nworld` tokenises
  // with a space between the words.  See docstring for the JA
  // trade-off (phantom leading space on the unit after a break).
  const cleaned = text.replace(/\\N/g, ' ')

  const units: string[] = []
  let pendingWs = ''
  let latinBuf = ''

  const flushLatin = (): void => {
    if (latinBuf.length > 0) {
      units.push(latinBuf)
      latinBuf = ''
    }
  }

  for (const ch of cleaned) {
    if (isWhitespace(ch)) {
      flushLatin()
      pendingWs += ch
    } else if (isCjkChar(ch)) {
      flushLatin()
      // Absorb any pending whitespace as a leading space on the CJK
      // unit so `Hello 世界` renders with the intended gap between
      // the Latin word and the first CJK character.
      units.push(pendingWs + ch)
      pendingWs = ''
    } else {
      // Latin (letters / digits / punctuation / any non-CJK non-ws char).
      // On the first char of a new Latin run, absorb any pending
      // whitespace so `Hello world` tokenises to `['Hello', ' world']`
      // (matches faster-whisper's leading-space convention for words).
      if (latinBuf.length === 0 && pendingWs.length > 0) {
        latinBuf = pendingWs
      }
      latinBuf += ch
      pendingWs = ''
    }
  }
  flushLatin()

  return units
}

// Explicit `\u` ranges (not raw glyphs) so the source stays ASCII-safe
// across editors that might silently re-encode CJK content — also
// clears the `no-irregular-whitespace` ESLint rule which flags the
// raw U+3000 IDEOGRAPHIC SPACE that starts the CJK-symbols range.
//
//   U+3000-U+303F — CJK Symbols and Punctuation
//   U+3040-U+309F — Hiragana
//   U+30A0-U+30FF — Katakana
//   U+4E00-U+9FFF — CJK Unified Ideographs
//   U+AC00-U+D7AF — Hangul Syllables
//   U+FF00-U+FFEF — Halfwidth and Fullwidth Forms
const CJK_CHAR_RE = /[\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]/

function isCjkChar(ch: string): boolean {
  return CJK_CHAR_RE.test(ch)
}

function isWhitespace(ch: string): boolean {
  // Matches spaces, tabs, newlines, and other Unicode whitespace.
  return /\s/.test(ch)
}
