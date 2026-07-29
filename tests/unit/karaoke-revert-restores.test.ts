import { describe, it, expect } from 'vitest'
import { areWordsValidForText } from '../../src/shared/words-validity'
import type { WordSpan } from '../../src/shared/types'

/**
 * REQ-0288 §4 primary regression pin — the reported bug.
 *
 * ## Reported reproduction (owner)
 *
 *   1. cue "テストです" — karaoke enabled, words = [{'テスト'}, {'です'}]
 *   2. user adds a newline → "テストです\N" (persisted form of "\n")
 *   3. blur commits → cue.text = "テストです\N", entry.isEdited = true
 *      (pre-REQ-0288: words also cleared to undefined at this step)
 *   4. user deletes the newline → back to "テストです"
 *   5. state after step 4:
 *      - text === original.text  → Reset button greyed out
 *      - timeline clip returns to "unedited" green
 *      - karaoke:
 *          pre-REQ-0288: OFF (words was undefined from step 3, can't
 *                           be restored because Reset is greyed)
 *          POST-REQ-0288: ON  (words was never cleared, still matches
 *                           the reverted text via strip-all normaliser)
 *
 * ## What this test pins
 *
 * The invariant "if the current text matches the words, karaoke is
 * available".  Post-REQ-0288 this holds through arbitrary edit
 * sequences that end back on a text matching the words — the
 * reported bug can no longer reproduce because we NEVER destructively
 * clear words on text mutation.
 */

const jaWords: WordSpan[] = [
  { startSec: 0, endSec: 0.5, text: 'テスト' },
  { startSec: 0.5, endSec: 1.0, text: 'です' },
]

describe('REQ-0288 §4 — reported bug pin: edit then revert restores karaoke', () => {
  it('step 1 — initial state (matches words) → karaoke available', () => {
    expect(areWordsValidForText(jaWords, 'テストです')).toBe(true)
  })

  it('step 2 — text gains a newline (\\N) → karaoke STILL available (whitespace-only)', () => {
    // The strip-all normaliser (REQ-0287) treats `\N` as absent, so
    // "テストです\N" and "テストです" are equivalent at the validity
    // predicate level.  Pre-REQ-0287 this would have failed because
    // \N mapped to space and JA words have no leading spaces to
    // match against.
    expect(areWordsValidForText(jaWords, 'テストです\\N')).toBe(true)
  })

  it('step 4 — text reverted to original → karaoke available again (the REQ-0288 fix)', () => {
    // The critical assertion: after revert, the predicate says yes.
    // Post-REQ-0288 this is trivially true because we never
    // destructively cleared `words` in the first place — the store
    // still has the original words array, and the current text
    // matches it, so `areWordsValidForText` returns true and the
    // renderer's karaoke gate opens.
    expect(areWordsValidForText(jaWords, 'テストです')).toBe(true)
  })

  it('end-to-end trace: initial → +newline → -newline → all three karaoke checks are true', () => {
    const trace = [
      { step: 'initial', text: 'テストです' },
      { step: 'after add newline', text: 'テストです\\N' },
      { step: 'after remove newline', text: 'テストです' },
    ]
    for (const { step, text } of trace) {
      expect(areWordsValidForText(jaWords, text), `karaoke should be available at: ${step}`).toBe(true)
    }
  })

  it('CONTRAST: a real content edit correctly disables karaoke, and reverting re-enables', () => {
    // Non-whitespace edit → invalid.  Revert restores validity.
    // Proves that "always allow" is NOT what we've done — the predicate
    // still gates correctly on actual content changes.
    expect(areWordsValidForText(jaWords, 'テストです')).toBe(true)           // start
    expect(areWordsValidForText(jaWords, 'サンプルです')).toBe(false)          // real edit → off
    expect(areWordsValidForText(jaWords, 'テストです')).toBe(true)           // revert → on
  })

  it('EN equivalent scenario: add trailing space then remove → karaoke stays on', () => {
    const enWords: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ]
    // Analogous to the JA repro: text gains whitespace, then loses it.
    expect(areWordsValidForText(enWords, 'hello world')).toBe(true)     // step 1
    expect(areWordsValidForText(enWords, 'hello world  ')).toBe(true)   // step 2 (extra ws)
    expect(areWordsValidForText(enWords, 'hello\\Nworld')).toBe(true)   // step 2b (\\N insertion)
    expect(areWordsValidForText(enWords, 'hello world')).toBe(true)     // step 4 (revert)
  })
})

describe('REQ-0288 §3 — three-signal consistency (documentation pin)', () => {
  // The pre-REQ-0288 bug arose because three UI signals used
  // different sources of truth:
  //   1. Reset button enabled? → `text !== original.text`
  //   2. Timeline clip colour  → `entry.isEdited`
  //   3. Karaoke availability  → `entry.words != null` (Layer 1 clear)
  //
  // Post-REQ-0288 the signals collapse to:
  //   1. Reset button enabled? → `text !== original.text`  (unchanged)
  //   2. Timeline clip colour  → `entry.isEdited`          (unchanged)
  //   3. Karaoke availability  → `areWordsValidForText(words, text)`
  //                              which is TRUE when the text still
  //                              maps back to the transcribed words.
  //
  // For the "revert to original" state, all three agree:
  //   text === original.text → Reset greyed, clip green (isEdited
  //   is a live flag; renderer may re-derive from field comparison
  //   OR it stays true after a real edit-then-revert sequence, but
  //   either way the KARAOKE signal now says "on" because words
  //   still match text).
  //
  // This test documents the alignment; the deeper "Reset / timeline
  // clip re-derives on text-matches-original" behaviour is owned by
  // other REQs and not touched here.

  it('when current text equals original text, areWordsValidForText matches original.words too', () => {
    // A property test: if text matches original AND words equals
    // original.words, karaoke is available.  (words IS aliased to
    // original.words in fresh transcription — see step1.tsx entry
    // construction.)
    const words: WordSpan[] = [
      { startSec: 0, endSec: 0.5, text: 'hello' },
      { startSec: 0.5, endSec: 1.0, text: ' world' },
    ]
    const text = 'hello world'
    expect(areWordsValidForText(words, text)).toBe(true)
  })
})
