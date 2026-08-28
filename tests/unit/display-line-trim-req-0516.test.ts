import { describe, it, expect } from 'vitest'
import {
  trimCueTextLineEdges,
  trimLineEdgePieces,
  trimPiecesByBreaks,
} from '../../src/shared/display-line-trim'

/**
 * REQ-0516 §1 — whitespace at a display line's edges is not drawn.
 *
 * libass drops it; the preview's CSS `white-space: pre` kept it, so the preview
 * showed an indent the exported video never had.  The rule and the measurements
 * behind it are in `src/shared/display-line-trim.ts`.
 *
 * The authority is the real-pixel gate `npm run verify:text-whitespace`, which
 * renders both engines and carries a negative control.  These are the fast pins
 * for the two properties that gate depends on and that are easy to break by
 * editing a regex: WHICH characters count, and WHERE the boundaries are.
 */

const BR = '\\N'

describe('REQ-0516 — which characters are dropped', () => {
  it('★ drops ASCII space and tab — the two libass drops, measured', () => {
    expect(trimCueTextLineEdges('  テスト  ')).toBe('テスト')
    expect(trimCueTextLineEdges('\tテスト\t')).toBe('テスト')
  })

  it('★ KEEPS the full-width space — libass draws it, so the preview must too', () => {
    // This is not a detail: a Japanese keyboard produces U+3000 constantly, and
    // a `\s`-based trim (the first cut of REQ-0516) would hide a character the
    // MP4 shows.  The pixel gate caught it; this keeps it caught in seconds.
    expect(trimCueTextLineEdges('　　テスト　　')).toBe('　　テスト　　')
  })

  it('keeps the other Unicode spaces libass was measured to draw', () => {
    expect(trimCueTextLineEdges(' テスト ')).toBe(' テスト ') // no-break
    expect(trimCueTextLineEdges(' テスト ')).toBe(' テスト ') // thin
  })

  it('★ never touches interior whitespace — that is REQ-0515\'s subject', () => {
    expect(trimCueTextLineEdges('テスト   です')).toBe('テスト   です')
    expect(trimCueTextLineEdges('  テスト   です  ')).toBe('テスト   です')
  })
})

describe('REQ-0516 — where the boundaries are', () => {
  it('★ trims PER LINE, not per cue — line 2\'s leading space goes too', () => {
    expect(trimCueTextLineEdges(`  テスト  ${BR}  です  `)).toBe(`テスト${BR}です`)
  })

  it('preserves the `\\N` separators exactly, so the result is still cue text', () => {
    expect(trimCueTextLineEdges(`a${BR}b${BR}c`)).toBe(`a${BR}b${BR}c`)
    expect(trimCueTextLineEdges(`  a  ${BR}  b  `).split(BR)).toEqual(['a', 'b'])
  })

  it('an all-whitespace line collapses to empty without eating its neighbours', () => {
    expect(trimCueTextLineEdges(`a${BR}   ${BR}b`)).toBe(`a${BR}${BR}b`)
  })

  it('leaves a cue with no edge whitespace byte-identical', () => {
    const t = `テスト${BR}です`
    expect(trimCueTextLineEdges(t)).toBe(t)
  })
})

describe('REQ-0516 — lines built from several pieces (karaoke units, emphasis runs)', () => {
  it('trims across pieces, so a whitespace-only leading piece disappears', () => {
    expect(trimLineEdgePieces(['  ', '  テスト', 'です  ', '  ']))
      .toEqual(['', 'テスト', 'です', ''])
  })

  it('★ leaves whitespace BETWEEN pieces alone', () => {
    // The gap between two karaoke units is interior to the line even though it
    // sits at a piece boundary.
    expect(trimLineEdgePieces(['テスト', '   です'])).toEqual(['テスト', '   です'])
  })

  it('splits pieces into lines at the breaks and trims each line\'s own edges', () => {
    // Pieces:      0        1          2         3
    // Lines:    [  0    ,   1  ] [     2    ,    3   ]
    const out = trimPiecesByBreaks(
      ['  テス', 'ト  ', '  です', 'です  '],
      (i) => i === 2,
    )
    expect(out).toEqual(['テス', 'ト', 'です', 'です'])
  })

  it('★ subsumes REQ-0294 — the unit after a break loses its leading whitespace', () => {
    // REQ-0294 stripped exactly this one case in the ASS writer.  The general
    // rule must still cover it, or the burn and the preview would disagree
    // about the second line's indent.
    expect(trimPiecesByBreaks(['テスト', '   です'], (i) => i === 1))
      .toEqual(['テスト', 'です'])
  })

  it('returns the pieces unchanged when there is nothing at any edge', () => {
    expect(trimPiecesByBreaks(['テスト', 'です'], () => false)).toEqual(['テスト', 'です'])
  })
})
