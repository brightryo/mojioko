import { describe, it, expect } from 'vitest'
import { buildEmphasisPickerLines } from '../../src/renderer/components/step2/emphasis-picker-dialog'
import {
  spansFromSelection,
  selectionFromRanges,
  resolveEmphasisSpans,
} from '../../src/shared/emphasis'

/**
 * REQ-0307 §1 — the emphasis picker's cell model.
 *
 * The dialog itself is React, but the part that has to be RIGHT is pure: which
 * characters become clickable cells, what code-unit offset each one carries,
 * and how `\N` is handled.  Those offsets become the stored span boundaries, so
 * an off-by-one here would emphasise the wrong glyph in the burn-in.
 */

const flat = (text: string) => buildEmphasisPickerLines(text).flat()

describe('REQ-0307 §1 — buildEmphasisPickerLines', () => {
  it('makes one cell per character, carrying its code-unit offset', () => {
    expect(flat('abc')).toEqual([
      { start: 0, length: 1, char: 'a', index: 0 },
      { start: 1, length: 1, char: 'b', index: 1 },
      { start: 2, length: 1, char: 'c', index: 2 },
    ])
  })

  it('renders `\\N` as a ROW BREAK, never as a cell', () => {
    const lines = buildEmphasisPickerLines('ab\\Ncd')
    expect(lines).toHaveLength(2)
    expect(lines[0].map((c) => c.char)).toEqual(['a', 'b'])
    expect(lines[1].map((c) => c.char)).toEqual(['c', 'd'])
    // No cell is a backslash or the sentinel's "N", and the offsets skip it.
    expect(flat('ab\\Ncd').map((c) => c.start)).toEqual([0, 1, 4, 5])
    expect(flat('ab\\Ncd').some((c) => c.char === '\\')).toBe(false)
  })

  it('keeps consecutive breaks as visible empty rows', () => {
    const lines = buildEmphasisPickerLines('a\\N\\Nb')
    expect(lines.map((l) => l.map((c) => c.char).join(''))).toEqual(['a', '', 'b'])
  })

  it('treats a surrogate pair as ONE cell of length 2', () => {
    const cells = flat('a🎉b')
    expect(cells.map((c) => c.char)).toEqual(['a', '🎉', 'b'])
    expect(cells.map((c) => [c.start, c.length])).toEqual([[0, 1], [1, 2], [3, 1]])
    // The offsets still slice correctly out of the original string.
    for (const c of cells) expect('a🎉b'.slice(c.start, c.start + c.length)).toBe(c.char)
  })

  it('spaces are selectable cells (mid-span whitespace must be emphasisable)', () => {
    expect(flat('a b').map((c) => c.char)).toEqual(['a', ' ', 'b'])
  })

  it('empty text yields a single empty row (dialog shows its empty state)', () => {
    expect(buildEmphasisPickerLines('')).toEqual([[]])
  })

  it('`index` is a contiguous flat ordinal across rows (drag/shift axis)', () => {
    expect(flat('ab\\Ncd').map((c) => c.index)).toEqual([0, 1, 2, 3])
  })
})

describe('REQ-0307 §1 — picker cells → spans → render ranges, end to end', () => {
  it('selecting the SECOND of two identical words stores only that occurrence', () => {
    const text = 'fox and fox'
    const cells = flat(text)
    // The user clicks the three characters of the second "fox" (offsets 8-10).
    const selected = new Set([8, 9, 10])
    const spans = spansFromSelection(text, cells, selected)
    expect(spans).toEqual([{ start: 8, end: 11, text: 'fox' }])
    // ...and that is what renders — the first "fox" is untouched.
    expect(resolveEmphasisSpans(text, spans).ranges).toEqual([[8, 11]])
  })

  // REQ-0309 §3(A) — was "becomes two spans".  A run swept across a line break
  // is now kept as ONE span (range crosses the `\N`, anchor stored break-free),
  // so the emphasis survives the wrap that inserted that break.
  it('a selection across a line break stays ONE span, with no backslash in the anchor', () => {
    const text = 'ab\\Ncd'
    const cells = flat(text)
    const spans = spansFromSelection(text, cells, new Set([1, 4]))
    expect(spans).toEqual([{ start: 1, end: 5, text: 'bc' }])
    expect(spans[0].text).not.toContain('\\')
    // Round-trips back to the same cells — the sentinel is not a cell, so the
    // widened range selects exactly the two characters the user picked.
    const { ranges } = resolveEmphasisSpans(text, spans)
    expect(selectionFromRanges(cells, ranges)).toEqual(new Set([1, 4]))
  })

  it('a selected surrogate pair round-trips as a whole character', () => {
    const text = 'a🎉b'
    const cells = flat(text)
    const spans = spansFromSelection(text, cells, new Set([1]))
    expect(spans).toEqual([{ start: 1, end: 3, text: '🎉' }])
    const { ranges } = resolveEmphasisSpans(text, spans)
    expect(selectionFromRanges(cells, ranges)).toEqual(new Set([1]))
  })
})
