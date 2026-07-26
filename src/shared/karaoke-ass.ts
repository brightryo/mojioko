import type { WordSpan } from './types'
import { splitTextByLocalRanges, type EmphasisRange } from './emphasis'

/**
 * REQ-0286 §2 — build the karaoke text for one cue's ASS Dialogue line.
 *
 * ## What this produces
 *
 * A string of the form:
 *
 *   [{\k<leading>}]{\k<dur_1>}word_1{\k<dur_2>}word_2...{\k<dur_n>}word_n
 *
 * where `dur_i` is the CENTISECOND (1/100 s) count for how long word i
 * stays "current" before word i+1 activates.  libass's `\k` tag switches
 * the FOLLOWING syllable from SecondaryColour to PrimaryColour when its
 * activation time is reached and leaves it there — so playing this text
 * back yields the "words light up as they're spoken" effect the REQ asks
 * for (§0 "words light up as spoken").
 *
 * ## ASS override-tag enclosure (REQ-0291 bugfix)
 *
 * Every `\k` tag MUST live inside its own `{...}` override block.
 * libass parses override tags ONLY inside curly braces; a bare `\k50`
 * in the text stream is treated as the literal five-character string
 * "\k50" (the `\` gets escaped to `\\`) and gets DRAWN as text on the
 * video — the exact regression REQ-0291 was filed to fix.  Do NOT
 * merge the `\k` tag into the style-override block preceding the
 * karaoke body: the caller emits `{style}` and immediately concatenates
 * this function's output, so `{style}{\k<dur>}word` is the correct
 * final shape (two adjacent `{}` blocks are legal libass syntax).
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
 * - Doesn't apply casing — the text baked into each word comes from
 *   `words[i].text` verbatim; casing is applied by the caller's
 *   `escapeText` callback so uppercase karaoke still works.
 * - Doesn't validate word ordering.  Caller must supply `words` sorted
 *   by `startSec` ascending (the sidecar always does).
 *
 * ## `\N` (line-break) handling — REQ-0294
 *
 * When the caller passes the cue's `text` as the optional 5th
 * argument, `\N` breaks are HONOURED: a `\N` literal is inserted
 * into the emitted karaoke body at the position corresponding to
 * each `\N` in `text`, and the leading whitespace of any word that
 * lands right after a break is stripped so the second line doesn't
 * indent by a stray space.  This lets karaoke cues wrap identically
 * to their plain (karaoke-off) counterparts — pre-REQ-0294 this
 * function silently collapsed every karaoke cue to one line
 * (RES-0286 §3 documented that as an intentional trade-off, but
 * REQ-0294 reversed the call because two-line karaoke was
 * important enough to justify the extra bookkeeping).
 *
 * When `cueText` is omitted (legacy call shape), the function
 * behaves exactly like the pre-REQ-0294 emitter: no `\N` in the
 * output, everything on a single line.  Existing tests that don't
 * care about line breaks keep passing.  Callers that care (the
 * ass-generator, and the subtitle-overlay via `computeKaraokeBreaks`
 * on its own) MUST pass `cueText` to get the correct layout.
 *
 * The break-position mapping is delegated to
 * `computeKaraokeBreaks` — see that function's docstring for the
 * character-walking algorithm and the edge case where a `\N` falls
 * mid-word (gracefully collapses to "no break at that word").
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
  cueText?: string,
  // REQ-0305 / REQ-0307 — optional keyword-emphasis overlay.
  //
  // `ranges` maps a word index to the emphasised `[start, end)` ranges in that
  // word's whitespace-stripped character coordinates (produced by
  // `emphasizedWordRanges`).  Because REQ-0307 lets the user select individual
  // CHARACTERS, an emphasis span can begin mid-word and can straddle two `\k`
  // blocks; the caller has already clipped it per word, and we split the word
  // text here so the `{openTag}` … `{closeTag}` pair sits exactly around the
  // emphasised characters.  Both stay brace-enclosed (REQ-0291).
  //
  // When a word is emphasised from its first visible character, the open tag is
  // folded into that word's `{\k…}` block (one block instead of two adjacent
  // ones) — this is also what keeps whole-word emphasis byte-identical to the
  // REQ-0306 output.  `undefined` → byte-identical to the pre-REQ-0305 output
  // (existing callers/tests unaffected).
  emphasis?: {
    ranges: ReadonlyMap<number, readonly EmphasisRange[]>
    openTag: string
    closeTag: string
  },
): string {
  if (words.length === 0) return ''

  const toCs = (sec: number): number => Math.max(0, Math.round(sec * 100))

  // REQ-0294 — when the caller supplies `cueText`, look up which word
  // indices should be preceded by a `\N` line break.  Empty set when
  // `cueText` is omitted OR contains no `\N`, which keeps the pre-
  // REQ-0294 single-line behaviour byte-identical for callers that
  // don't need multiline karaoke (existing unit tests hit this path).
  const breaks = cueText !== undefined
    ? computeKaraokeBreaks(cueText, words)
    : new Set<number>()

  const parts: string[] = []

  // Leading offset — the cue starts before the first word.  Emit a
  // silent `{\k<offset>}` so the first word's activation is delayed
  // until its actual startSec.  The braces MUST enclose the tag; see
  // the "ASS override-tag enclosure" docstring section for why bare
  // `\k` breaks libass.
  const leadingOffsetSec = words[0].startSec - cueStartSec
  if (leadingOffsetSec > 0) {
    parts.push(`{\\k${toCs(leadingOffsetSec)}}`)
  }

  // Each word: optional `\N` (REQ-0294 line-break, unescaped literal
  // — libass parses `\N` in the text field as a hard line break) +
  // `{\k<duration>}` (override block) + escaped text (rendered as
  // literal).  Word text passes through the caller's `escapeText`
  // which handles `{` / `}` / `\` — the override braces wrapping
  // the `\k` and the `\N` line-break sentinel are added HERE
  // (unescaped by design), never in the escaper.
  //
  // When a word lands right after a break, its leading whitespace
  // is stripped so the second line doesn't render an indent from
  // faster-whisper's " word" convention.  For CJK words (no leading
  // whitespace anyway) the strip is a no-op.
  for (let i = 0; i < words.length; i++) {
    const nextActivationSec =
      i + 1 < words.length
        ? words[i + 1].startSec
        : cueEndSec // last word holds until cue ends
    const durationSec = Math.max(0, nextActivationSec - words[i].startSec)
    if (breaks.has(i)) {
      parts.push('\\N')
    }
    const rawWordText = breaks.has(i)
      ? words[i].text.replace(/^\s+/, '')
      : words[i].text
    const kTag = `\\k${toCs(durationSec)}`
    // REQ-0307 §4 — character-level emphasis inside this `\k` block.  The word
    // is split into alternating plain / emphasised runs; each emphasised run is
    // opened with `{openTag}` and closed with `{closeTag}` so the style always
    // returns to the karaoke baseline before the next run (and the next word).
    // A run that starts at the word's first visible character folds its open
    // tag into the `\k` block, keeping the common whole-word case to a single
    // override block.
    const localRanges = emphasis?.ranges.get(i)
    if (!localRanges || localRanges.length === 0) {
      parts.push(`{${kTag}}${escapeText(rawWordText)}`)
      continue
    }
    const runs = splitTextByLocalRanges(rawWordText, localRanges)
    if (runs.length === 0) {
      // Empty word text — still emit the `\k` block so the timeline is intact.
      parts.push(`{${kTag}}`)
      continue
    }
    let opened = false
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r]
      if (run.emphasized) {
        if (r === 0) {
          // Fold into the `\k` block — `{\k70\fs150\c…}TEXT`.
          parts.push(`{${kTag}${emphasis!.openTag}}`)
        } else {
          parts.push(`{${emphasis!.openTag}}`)
        }
        parts.push(escapeText(run.text))
        opened = true
      } else {
        if (r === 0) parts.push(`{${kTag}}`)
        if (opened) {
          parts.push(`{${emphasis!.closeTag}}`)
          opened = false
        }
        parts.push(escapeText(run.text))
      }
    }
    if (opened) parts.push(`{${emphasis!.closeTag}}`)
  }

  return parts.join('')
}

/**
 * REQ-0294 — figure out which word indices should be preceded by a
 * `\N` line break so the karaoke render matches the plain (karaoke-
 * off) render's wrap positions.
 *
 * ## Algorithm
 *
 * Walk `cueText` character-by-character, skipping whitespace and
 * skipping the two-character `\N` sentinel (marking the position it
 * lands at).  In parallel, walk each word's stripped characters
 * (whitespace removed, `\N` never appears in word text) and
 * accumulate a global cursor into the stripped cue.  Just before
 * consuming the FIRST character of word `w` (for `w > 0`), check
 * whether the position just before that character was tagged as
 * "followed by `\N`" during the cueText walk.  If so, `w` is
 * marked for a leading break.
 *
 * ## Correctness assumption
 *
 * The `areWordsValidForText` predicate (REQ-0287) guarantees that
 * `stripAllWhitespace(cueText) === stripAllWhitespace(words concat)`
 * when the caller decides karaoke is active.  That means walking
 * both in stripped-char lockstep is a valid one-to-one mapping.
 * When called from the fallback path the same invariant holds —
 * fallback units are literally derived from `cueText` (with `\N`
 * replaced by whitespace for tokenisation), so their stripped
 * concat equals the stripped cue.
 *
 * ## Mid-word `\N` (edge case)
 *
 * If a `\N` in `cueText` falls in the middle of a word (uncommon —
 * auto-line-break inserts `\N` at safe boundaries between words),
 * this function silently drops the break at that position.  The
 * karaoke render then has no line break at that word, matching the
 * pre-REQ-0294 behaviour for that specific case.  A future REQ
 * could split the affected word into two `\k` blocks separated by
 * `\N` if the owner ever needs it; not worth the complexity for
 * v1.3.6.
 *
 * ## Return value
 *
 * A `Set` of word indices (0-based).  `breaks.has(w) === true`
 * means "emit `\N` right before word[w] in the karaoke output."
 * The set is always empty when `cueText` contains no `\N`.
 */
export function computeKaraokeBreaks(
  cueText: string,
  words: readonly WordSpan[],
): Set<number> {
  const breaks = new Set<number>()

  // Build `nAfterStripped[i] = true` iff a `\N` in `cueText` sits
  // between stripped char `i` and stripped char `i+1`.  Whitespace
  // (any Unicode whitespace) is skipped over transparently.
  const nAfterStripped: boolean[] = []
  let i = 0
  while (i < cueText.length) {
    if (cueText[i] === '\\' && cueText[i + 1] === 'N') {
      if (nAfterStripped.length > 0) {
        nAfterStripped[nAfterStripped.length - 1] = true
      }
      i += 2
      continue
    }
    if (/\s/.test(cueText[i])) {
      i++
      continue
    }
    nAfterStripped.push(false)
    i++
  }

  // Walk words in order, matching each word's stripped characters
  // against the global cursor into `nAfterStripped`.  Before
  // consuming the first char of word `w > 0`, check whether the
  // char at `cursor - 1` was flagged as "\N follows".
  let cursor = 0
  for (let w = 0; w < words.length; w++) {
    // Strip whitespace from word text.  Word text should never
    // contain a literal `\N` (faster-whisper doesn't emit them,
    // fallback splitter drops them), but strip defensively.
    const stripped = words[w].text.replace(/\\N/g, '').replace(/\s+/g, '')
    for (let c = 0; c < stripped.length; c++) {
      if (c === 0 && w > 0 && cursor > 0 && nAfterStripped[cursor - 1]) {
        breaks.add(w)
      }
      cursor++
    }
  }

  return breaks
}
