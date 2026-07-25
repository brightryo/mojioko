import type { WordSpan } from './types'

/**
 * REQ-0286 §2 — build the karaoke text for one cue's ASS Dialogue line.
 *
 * ## What this produces
 *
 * A string of the form:
 *
 *   [<leading \k>][\k<dur_1>{word_1}][\k<dur_2>{word_2}]...[\k<dur_n>{word_n}]
 *
 * where `dur_i` is the CENTISECOND (1/100 s) count for how long word i
 * stays "current" before word i+1 activates.  libass's `\k` tag switches
 * the FOLLOWING syllable from SecondaryColour to PrimaryColour when its
 * activation time is reached and leaves it there — so playing this text
 * back yields the "words light up as they're spoken" effect the REQ asks
 * for (§0 "words light up as spoken").
 *
 * ## Tag choice: \k (not \kf)
 *
 * libass has three karaoke tags:
 *   - `\k`  — instantaneous colour switch at the syllable's activation
 *   - `\kf` — left-to-right sweep FILL over the syllable's duration
 *   - `\ko` — outline-only karaoke effect
 *
 * `\k` is chosen because the preview reproduction (rAF loop that reads
 * currentTime and swaps span colour) is trivially exact for an
 * instantaneous switch, and much more expensive for a sweep (`\kf`
 * would require per-pixel gradient masking to reproduce faithfully in
 * CSS — outside REQ-0286's scope).  Owner may request `\kf` in a
 * future REQ; the swap is one line change here + a subtitle-overlay
 * CSS gradient in the preview.
 *
 * ## Duration semantics — activation offsets
 *
 * A syllable's `\k` duration is NOT its own duration; it is the delay
 * until the NEXT syllable activates.  Concrete example:
 *
 *   cue [1.0, 3.0], words: [
 *     { start: 1.0, end: 1.5, text: 'hello' },
 *     { start: 1.7, end: 2.5, text: ' world' },
 *   ]
 *
 * We want:
 *   - "hello" lights at t=1.0 (immediately when cue starts)
 *   - " world" lights at t=1.7 (0.7 s after cue start)
 *   - " world" stays lit until cue ends at t=3.0
 *
 * Translation to `\k`:
 *   - Leading offset: 1.0 - 1.0 = 0 s → no leading tag needed
 *   - hello's \k duration = time until " world" activates
 *                        = 1.7 - 1.0 = 0.7 s = 70 cs → `\k70{hello}`
 *   - world's \k duration = remaining cue time (nothing activates
 *                          after it, but a duration keeps the syllable
 *                          "held" so the highlight stays visible)
 *                        = 3.0 - 1.7 = 1.3 s = 130 cs → `\k130{ world}`
 *
 * Final emit: `\k70{hello}\k130{ world}` (with leading `\k<offset>`
 * inserted only when the first word starts AFTER the cue start).
 *
 * ## Leading offset (cue starts before the first word)
 *
 * If `words[0].startSec > cueStart`, prepend `\k<offset_cs>` so the
 * first word's activation is delayed appropriately.  The empty leading
 * syllable is just silence with no text.
 *
 * ## Gaps between words
 *
 * A gap between `words[i].endSec` and `words[i+1].startSec` is
 * naturally absorbed by word i's `\k` duration (which is calculated
 * as `words[i+1].startSec - words[i].startSec`, NOT
 * `words[i].endSec - words[i].startSec`).  So a "silence gap" between
 * two spoken words just means word i stays highlighted a bit longer
 * before word i+1 activates — matching what the ear expects.
 *
 * ## Trailing (cue ends after the last word)
 *
 * The last word's `\k` duration is `cueEnd - words[last].startSec`
 * (not `words[last].endSec - words[last].startSec`).  If the cue ends
 * later than the last word's `.endSec`, that trailing silence is just
 * held-highlight time — visually the last word stays lit until the cue
 * unmounts.  This matches the natural feel: the last spoken word is
 * still on-screen (and highlighted) during the pause before the cue
 * disappears.
 *
 * ## Text escaping
 *
 * Word text is passed through the caller's ASS escaper (`escapeAssText`
 * in ass-generator.ts) BEFORE being handed to this function.  This
 * module deliberately doesn't import that escaper to stay dependency-
 * free for unit tests.  Callers escape once per cue's full text OR
 * once per word — both approaches yield the same output because
 * ASS-escaping is character-local (no cross-word interactions).
 *
 * ## What this DOES NOT do
 *
 * - Doesn't emit `\c` / `\2c` (Primary/Secondary colour).  Caller
 *   emits those separately at the start of the styleTag so the
 *   colours are established BEFORE the first `\k` applies.
 * - Doesn't apply casing / auto-line-break — the text baked into each
 *   word comes from `words[i].text` verbatim, so the karaoke render
 *   is unaffected by the cue's `\N` breaks.  This is a deliberate
 *   trade-off (REQ-0286 §3 note on preview↔burn-in parity): karaoke
 *   cues use natural word-wrap on both sides rather than the
 *   auto-line-break `\N` positions of the plain cue text.
 * - Doesn't validate word ordering.  Caller must supply `words` sorted
 *   by `startSec` ascending (the sidecar always does).
 *
 * ## Empty edge cases
 *
 * - Empty `words` array → returns empty string.  Caller should avoid
 *   calling here in that case (guarded by `areWordsValidForText` which
 *   short-circuits on empty) but we degrade gracefully rather than
 *   throw.
 */
export function buildKaraokeAssText(
  words: readonly WordSpan[],
  cueStartSec: number,
  cueEndSec: number,
  escapeText: (s: string) => string,
): string {
  if (words.length === 0) return ''

  const toCs = (sec: number): number => Math.max(0, Math.round(sec * 100))

  const parts: string[] = []

  // Leading offset — the cue starts before the first word.  Emit a
  // silent `\k<offset>` so the first word's activation is delayed
  // until its actual startSec.
  const leadingOffsetSec = words[0].startSec - cueStartSec
  if (leadingOffsetSec > 0) {
    parts.push(`\\k${toCs(leadingOffsetSec)}`)
  }

  // Each word: activation-until-next-word duration + escaped text.
  for (let i = 0; i < words.length; i++) {
    const nextActivationSec =
      i + 1 < words.length
        ? words[i + 1].startSec
        : cueEndSec // last word holds until cue ends
    const durationSec = Math.max(0, nextActivationSec - words[i].startSec)
    parts.push(`\\k${toCs(durationSec)}${escapeText(words[i].text)}`)
  }

  return parts.join('')
}
