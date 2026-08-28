import { describe, it, expect } from 'vitest'
import { projectCueWhitespaceOntoWords } from '../../src/shared/karaoke-ass'
import { resolveKaraokeUnits } from '../../src/shared/karaoke-units'
import { areWordsValidForText } from '../../src/shared/words-validity'
import { commitTextEditWithHistory } from '../../src/renderer/lib/commit-text-edit'
import type { SubtitleEntry, WordSpan } from '../../src/shared/types'

/**
 * REQ-0515 — a karaoke cue spells its OWN text.
 *
 * ## The defect
 *
 * `areWordsValidForText` compares `words` against `text` with all whitespace
 * stripped (REQ-0287, deliberately, so an auto-line-break `\N` does not kill
 * karaoke).  Both renderers then took the DISPLAY text from `words`.  So typing
 * a space into a karaoke cue changed `text`, left the predicate true, and the
 * space reached neither the preview nor the MP4.
 *
 * The owner's 「1文字消すと空白も一緒に出る」 is the same mechanism seen from the
 * other side: deleting a character is what finally breaks the stripped
 * comparison, which drops the cue to the equal-split fallback — and that
 * fallback builds its units from `text`, so every previously-swallowed space
 * arrives at once.  **That observation is also the proof the spaces were in the
 * store all along**: nothing retypes them, they simply start being drawn.
 *
 * ## What is pinned here, and what is not
 *
 * The authority for this REQ is the real-pixel gate `npm run
 * verify:text-whitespace`, which measures the cue's rendered ink width in both
 * engines with a negative control. These are the fast structural pins beneath
 * it: the projection's semantics, the byte-identity guarantee the ASS baseline
 * depends on, and the absence of a whitespace-normalising guard on the commit
 * path.  Neither replaces the other.
 */

const WORDS: readonly WordSpan[] = [
  { text: 'テスト', startSec: 1, endSec: 2 },
  { text: 'です', startSec: 2, endSec: 3 },
]
/** The libass hard-break sentinel as it lives in stored text. */
const BR = '\\N'

const texts = (units: readonly WordSpan[]): string[] => units.map((u) => u.text)

describe('REQ-0515 — projectCueWhitespaceOntoWords', () => {
  it('★ the reported case: typed spaces land on the units', () => {
    expect(texts(projectCueWhitespaceOntoWords('テスト   です', WORDS)))
      .toEqual(['テスト', '   です'])
  })

  it('attaches whitespace as LEADING, matching faster-whisper and the fallback', () => {
    // Latin transcription already spells it this way (' World'), so the
    // convention is inherited, not invented.
    const latin: WordSpan[] = [
      { text: 'Hello', startSec: 1, endSec: 2 },
      { text: ' World', startSec: 2, endSec: 3 },
    ]
    expect(texts(projectCueWhitespaceOntoWords('Hello World', latin)))
      .toEqual(['Hello', ' World'])
    expect(texts(projectCueWhitespaceOntoWords('Hello   World', latin)))
      .toEqual(['Hello', '   World'])
  })

  it('handles full-width spaces — `\\s` covers U+3000, so the old bug did too', () => {
    expect(texts(projectCueWhitespaceOntoWords('テスト　　　です', WORDS)))
      .toEqual(['テスト', '　　　です'])
  })

  it('keeps leading and trailing whitespace (libass trims them; we do not)', () => {
    expect(texts(projectCueWhitespaceOntoWords('   テストです', WORDS)))
      .toEqual(['   テスト', 'です'])
    expect(texts(projectCueWhitespaceOntoWords('テストです   ', WORDS)))
      .toEqual(['テスト', 'です   '])
  })

  it('★ never copies a `\\N` into unit text — line breaks stay computeKaraokeBreaks\' job', () => {
    const out = projectCueWhitespaceOntoWords(`テスト${BR}です`, WORDS)
    expect(texts(out)).toEqual(['テスト', 'です'])
    for (const u of out) expect(u.text).not.toContain(BR)
  })

  it('★ returns the SAME array reference when nothing moves (ASS byte-identity)', () => {
    // Every transcribed cue the user has not retyped whitespace into takes this
    // path, which is why `ass-generator-baseline-ac1fd67.test.ts` still passes.
    expect(projectCueWhitespaceOntoWords('テストです', WORDS)).toBe(WORDS)
    expect(projectCueWhitespaceOntoWords(`テスト${BR}です`, WORDS)).toBe(WORDS)
  })

  it('preserves every unit\'s timing — it rewrites text only', () => {
    const out = projectCueWhitespaceOntoWords('テスト   です', WORDS)
    expect(out.map((u) => [u.startSec, u.endSec])).toEqual([[1, 2], [2, 3]])
  })

  it('keeps the stripped-lockstep invariant the rest of the mapping code walks', () => {
    const text = 'テスト   です'
    const out = projectCueWhitespaceOntoWords(text, WORDS)
    expect(areWordsValidForText(out, text)).toBe(true)
  })

  it('bails out untouched when the visible characters do not line up', () => {
    // Precondition violated by the caller — return the input rather than
    // scramble the cue.
    expect(projectCueWhitespaceOntoWords('まったく別の文', WORDS)).toBe(WORDS)
    expect(projectCueWhitespaceOntoWords('', WORDS)).toBe(WORDS)
  })
})

function cue(text: string, patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    id: 'c1', startSec: 1, endSec: 3, text,
    words: WORDS,
    isDeleted: false, isEdited: false,
  }
  return {
    ...base,
    original: { ...base, text: 'テストです' },
    ...patch,
  } as unknown as SubtitleEntry
}

describe('REQ-0515 — resolveKaraokeUnits is the one surface', () => {
  it('★ a cue with real word timings still spells its own text', () => {
    const e = cue('テスト   です')
    // The precondition that made this bug invisible: the cue is STILL "valid".
    expect(areWordsValidForText(WORDS, e.text)).toBe(true)
    expect(texts(resolveKaraokeUnits(e, true))).toEqual(['テスト', '   です'])
  })

  it('the equal-split fallback already spelled the text — and still does', () => {
    // Deleting a character breaks the stripped comparison, which is what the
    // owner did to make the spaces appear.  That path must not regress.
    const e = cue('テス   です')
    expect(areWordsValidForText(WORDS, e.text)).toBe(false)
    expect(resolveKaraokeUnits(e, true).map((u) => u.text).join('')).toBe('テス   です')
  })

  it('an untouched transcribed cue is unchanged, unit for unit', () => {
    expect(texts(resolveKaraokeUnits(cue('テストです'), true))).toEqual(['テスト', 'です'])
  })

  it('returns nothing when the karaoke gate is off', () => {
    expect(resolveKaraokeUnits(cue('テスト   です'), false)).toEqual([])
  })
})

describe('REQ-0515 §1-1 — the input path does not normalise whitespace', () => {
  it('★ a whitespace-ONLY edit still commits', () => {
    // The REQ\'s own hypothesis was a `trim()`-based "nothing changed" guard on
    // commit.  There is none — and this pins that there never is one, because
    // such a guard would make exactly this edit vanish.
    let written: Partial<SubtitleEntry> | null = null
    const ok = commitTextEditWithHistory({
      entry: cue('テスト   です'),
      normalizedNew: 'テスト   です',
      normalizedOnFocus: 'テストです',
      label: 'edit',
      updateEntry: (_id, patch) => { written = patch },
      pushHistory: () => {},
    })
    expect(ok).toBe(true)
    expect(written).not.toBeNull()
    expect((written as unknown as Partial<SubtitleEntry>).text).toBe('テスト   です')
  })

  it('a trailing-space-only edit commits too (no trim on either side)', () => {
    let written: Partial<SubtitleEntry> | null = null
    const ok = commitTextEditWithHistory({
      entry: cue('テストです '),
      normalizedNew: 'テストです ',
      normalizedOnFocus: 'テストです',
      label: 'edit',
      updateEntry: (_id, patch) => { written = patch },
      pushHistory: () => {},
    })
    expect(ok).toBe(true)
    expect((written as unknown as Partial<SubtitleEntry>).text).toBe('テストです ')
  })
})
