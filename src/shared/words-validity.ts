import type { WordSpan } from './types'

/**
 * REQ-0285 §4 / REQ-0288 — words↔text validity helper.
 *
 * `SubtitleEntry.words` captures per-word timing at transcribe time.
 * If the user subsequently edits the cue's `text`, or splits/merges
 * cues, the stored `words` may no longer align with the current text.
 * Phase B visual features (karaoke fill, keyword highlight, speaking-
 * word pill) MUST refuse to render per-word visuals on such rows or
 * they will highlight the wrong glyph, mid-word.
 *
 * ## Invalidation strategy (REQ-0288 update)
 *
 * SINGLE-LAYER defence: `words` is preserved through every text edit
 * (never proactively cleared), and Phase B renderers call
 * `areWordsValidForText(words, text)` at RENDER TIME to decide whether
 * per-word rendering is safe.
 *
 * This helper is that predicate.  It returns:
 *   - `true`  → words align with text (after strip-all-whitespace
 *               normalisation) → Phase B may render per-word visuals
 *   - `false` → mismatch OR no words data → Phase B falls back to
 *               plain rendering
 *
 * The pre-REQ-0288 design was two-layer: Layer 1 (proactive clear on
 * every text mutation via `commit-text-edit.ts` / `entry-row-actions.ts`)
 * + Layer 2 (this defensive check).  Layer 1 was removed by REQ-0288
 * because it created a reversibility bug: "edit → revert to original
 * text" cleared words then couldn't restore them, so karaoke stayed
 * off even though the text was back to its transcribed form.  The
 * Reset button and timeline-clip "edited" colour disagreed with the
 * karaoke on/off state.  Removing Layer 1 collapses the three signals
 * to one truth ("does the text still match the transcribed words?"),
 * which this predicate answers.
 *
 * ## Validity rule (REQ-0287 §1-D — updated to strip-all-whitespace)
 *
 * The word-text concatenation MUST match the cue text after
 * whitespace STRIPPING:
 *
 *   stripAllWhitespace(text) === stripAllWhitespace(words.map(w => w.text).join(''))
 *
 * `stripAllWhitespace` removes every whitespace character (space,
 * tab, newline, `\N` sentinel) entirely — NOT collapse-to-single-
 * space.  This handles both Latin and CJK transcripts uniformly:
 *
 *   - Latin (faster-whisper prefixes non-first words with ' '):
 *       cue text     = "hello\\Nworld"  (auto-line-break inserted \N)
 *       words concat = "hello world"
 *       stripped     = "helloworld"  ↔  "helloworld"  → match ✓
 *
 *   - CJK (faster-whisper emits words WITHOUT leading spaces):
 *       cue text     = "こんにちは\\N世界"
 *       words concat = "こんにちは世界"
 *       stripped     = "こんにちは世界"  ↔  "こんにちは世界"  → match ✓
 *
 * The pre-REQ-0287 rule (`\N` → space + collapse) worked for Latin
 * but broke CJK: it turned cue-text `\N` into a space that the
 * word-concat had no counterpart for, and every JA karaoke cue
 * silently fell back to plain rendering.  See REQ-0287 §1-D for
 * the failure trace.
 *
 * ## What still counts as invalid (edit detection unchanged)
 *
 *   - a word inserted / deleted / replaced: stripped text differs
 *     from stripped concat → false → plain fallback
 *   - a punctuation change: "Hi" → "Hi." — stripped differs → false
 *   - case change if text is stored in alt case (mojioko never
 *     stores case-transformed text; casing is display-only per
 *     REQ-0277 §1 — so this case shouldn't arise in practice)
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
  const wordsConcat = stripAllWhitespace(words.map((w) => w.text).join(''))
  const textStripped = stripAllWhitespace(text)
  return wordsConcat === textStripped
}

/**
 * REQ-0287 §1-D — strip EVERY whitespace character (spaces, tabs,
 * newlines, and the libass `\N` hard-break sentinel).  Chosen over
 * collapse-to-single-space so CJK transcripts (no leading spaces
 * on faster-whisper's word output) match after auto-line-break
 * inserts `\N` sentinels into the cue text.  See the docstring on
 * `areWordsValidForText` above for the full derivation.
 *
 * Retains the old export name `normaliseWhitespace` as an alias so
 * external tests (`tests/unit/words-validity.test.ts`) don't break
 * from the semantic change alone — they get updated to assert the
 * new behaviour explicitly.  The alias is documented as "prefer
 * stripAllWhitespace for new code".
 */
export function stripAllWhitespace(s: string): string {
  return s
    .replace(/\\N/g, '')  // libass hard-break sentinel: remove entirely
    .replace(/\s+/g, '')  // strip every whitespace run
}

/**
 * Legacy alias — REQ-0285 named the helper `normaliseWhitespace` on
 * the "collapse to single space" contract; REQ-0287 tightened it to
 * "strip all whitespace" for CJK correctness.  The export is retained
 * only so third-party test callers (if any) don't break unexpectedly;
 * new code should call `stripAllWhitespace` directly.
 */
export function normaliseWhitespace(s: string): string {
  return stripAllWhitespace(s)
}
