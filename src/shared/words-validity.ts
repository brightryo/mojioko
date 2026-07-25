import type { WordSpan } from './types'

/**
 * REQ-0285 §4 — words↔text validity helper.
 *
 * `SubtitleEntry.words` captures per-word timing at transcribe time.
 * If the user subsequently edits the cue's `text`, or splits/merges
 * cues, the stored `words` may no longer align with the current text.
 * Phase B visual features (karaoke fill, keyword highlight, speaking-
 * word pill) MUST refuse to render per-word visuals on such rows or
 * they will highlight the wrong glyph, mid-word.
 *
 * ## Invalidation strategy (REQ-0285 §4 decision)
 *
 * TWO-LAYER defence:
 *
 *   Layer 1 — proactive clear at commit time.  Every code path that
 *     mutates `entry.text` must set `entry.words = undefined`.  This
 *     is the primary defence; it turns most invalid states into
 *     the fully-safe "no words data" state before any renderer sees
 *     the row.  Wired at `src/renderer/lib/commit-text-edit.ts` for
 *     the text-cell / inspector flow; future cue split/merge REQs
 *     must follow the same pattern.
 *
 *   Layer 2 — this defensive check.  Belt-and-braces for state that
 *     slipped past Layer 1: project files edited by hand, legacy
 *     projects with stale words, split/merge sites the future
 *     visual REQ hasn't audited yet.  `areWordsValidForText` returns
 *     `false` on any mismatch, and Phase B renderers gate on it.
 *
 * ## Validity rule
 *
 * The word-text concatenation MUST match the cue text after
 * whitespace normalisation:
 *
 *   normalise(text) === normalise(words.map(w => w.text).join(''))
 *
 * `normalise` collapses every run of whitespace (spaces, `\N`
 * hard-breaks from auto-line-break, `\n`, tabs) to a single space AND
 * trims the ends.  This tolerates:
 *   - the auto-line-break pass (adds `\N` between words)
 *   - display casing (renderer transform, doesn't mutate `text`)
 *   - faster-whisper's per-word leading spaces
 *
 * It does NOT tolerate:
 *   - a word inserted / deleted / replaced
 *   - a punctuation change ("Hi" → "Hi.")
 *   - case changes if `text` is stored in the alt case (mojioko never
 *     stores case-transformed text — casing is a display effect only,
 *     per REQ-0277 §1 — so this case shouldn't arise in practice)
 *
 * ## Why not fuzzy-match
 *
 * A fuzzy comparator (Levenshtein, longest-common-substring) would
 * let SOME edited rows keep per-word timing.  Rejected because:
 *   1. Any partial alignment risks highlighting the wrong glyph at the
 *      wrong time — the visual bug is louder than "no highlight at all".
 *   2. Cost of fuzzy match runs O(N × M) per frame for karaoke.
 *   3. The proactive-clear layer already handles the common case;
 *      the defensive check just needs to be a fast, obvious gate.
 *
 * `words === undefined` OR `words.length === 0` also count as "not
 * valid" (nothing to render per-word), so Phase B renderers can gate
 * on the single boolean result without additional null-checks.
 */
export function areWordsValidForText(words: readonly WordSpan[] | undefined, text: string): boolean {
  if (!words || words.length === 0) return false
  const wordsConcat = normaliseWhitespace(words.map((w) => w.text).join(''))
  const textNorm = normaliseWhitespace(text)
  return wordsConcat === textNorm
}

/**
 * Collapse every run of whitespace (space, tab, newline, `\N` hard-
 * break sentinel from auto-line-break) to a single space AND trim
 * the ends.
 *
 * The literal string `\N` is treated as whitespace because that's the
 * libass hard-break sentinel that `applyAutoLineBreak` inserts into
 * cue text — the words themselves have no `\N`, so a raw string
 * comparison would falsely fail after auto-break has fired.
 */
export function normaliseWhitespace(s: string): string {
  return s
    .replace(/\\N/g, ' ')       // libass hard-break sentinel
    .replace(/\s+/g, ' ')       // collapse whitespace runs
    .trim()
}
