import { describe, it, expect } from 'vitest'
import {
  clampLineSpacingPercent,
  cueLineAnchors,
  cueLineCount,
  estimateCueHeightAssPx,
  lineLeadingCorrectionAssPx,
  linePitchAssPx,
  lineSpacingFactor,
  resolveLineSpacingPercent,
  LINE_SPACING_MIN_PERCENT,
  LINE_SPACING_MAX_PERCENT,
  LINE_SPACING_DEFAULT_PERCENT,
} from '../../src/shared/line-spacing'
import { groupByTimeOverlap } from '../../src/shared/simultaneous-groups'
import { expandCueToEvents } from '../../src/shared/cue-events'
import { generateAss } from '../../src/main/services/ass-generator'
import type { SubtitleEntry, VideoInfo } from '../../src/shared/types'

/**
 * REQ-0332 — line spacing.
 *
 * The load-bearing numbers in here are NOT invented by this file; they were
 * measured against ffmpeg/libass in REQ-0332 §6 (see `cueLineAnchors`'s
 * docblock).  What the tests below pin is that the code still expresses those
 * measurements, and — above all — that 0 % changes nothing.
 */

const video = {
  path: 'x.mp4', widthPx: 1920, heightPx: 1080, durationSec: 10,
  fps: 30, audioTracks: [], hasVideo: true,
} as unknown as VideoInfo

const burnin = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 } as const

function entry(p: Partial<SubtitleEntry>): SubtitleEntry {
  return {
    id: 'e1', startSec: 0, endSec: 5,
    text: 'AAA\\NBBB',
    fontSizePx: 100,
    textColorHex: '#FFFFFF', outlineColorHex: '#000000', outlineThicknessPx: 3,
    fadeDurationSec: 0, fontId: 'noto-sans-jp',
    horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 60 },
    isDeleted: false, isEdited: false, animationType: 'none',
    ...p,
    // REQ-0336 §1-5 — the karaoke timing resolver reads `original.startSec` /
    // `original.endSec` to tell an untouched cue from one whose times the user
    // dragged.  These fixtures never edit times, so the snapshot mirrors the
    // live values; the previous `{} as …` left both `undefined`, which every
    // real entry-creation path fills in (`SubtitleEntryOriginal` declares them
    // required) and which made the karaoke case here read as "times edited".
    original: {
      startSec: p.startSec ?? 0,
      endSec: p.endSec ?? 5,
      ...p.original,
    } as SubtitleEntry['original'],
  } as SubtitleEntry
}

const ass = (entries: SubtitleEntry[]): string => generateAss(entries, video, burnin)
const dialogues = (s: string): string[] => s.split('\n').filter((l) => l.startsWith('Dialogue:'))

describe('REQ-0332 §2 — the field', () => {
  it('absent and 0 are the same thing', () => {
    expect(resolveLineSpacingPercent({})).toBe(LINE_SPACING_DEFAULT_PERCENT)
    expect(resolveLineSpacingPercent({ lineSpacingPercent: 0 })).toBe(0)
    expect(lineSpacingFactor(0)).toBe(1)
  })

  it('clamps to the supported range and survives garbage', () => {
    expect(clampLineSpacingPercent(-999)).toBe(LINE_SPACING_MIN_PERCENT)
    expect(clampLineSpacingPercent(999)).toBe(LINE_SPACING_MAX_PERCENT)
    expect(clampLineSpacingPercent(NaN)).toBe(LINE_SPACING_DEFAULT_PERCENT)
    expect(resolveLineSpacingPercent({ lineSpacingPercent: 500 })).toBe(LINE_SPACING_MAX_PERCENT)
  })
})

describe('REQ-0332 §3-1 — pitch and geometry', () => {
  it('★ pitch is fontSizePx × factor, with NO libassScale factor', () => {
    // Measured: `\fs100` two-line cue → 100.000px between the ink tops;
    // `\fs150` → 150.  RES-0330 §2's `× libassScale` form would have given
    // 69.06 and is what this pins against.
    expect(linePitchAssPx(100, 0)).toBe(100)
    expect(linePitchAssPx(150, 0)).toBe(150)
    expect(linePitchAssPx(100, -50)).toBe(50)
    expect(linePitchAssPx(100, 100)).toBe(200)
  })

  it('counts display lines from the `\\N` markers', () => {
    expect(cueLineCount('one')).toBe(1)
    expect(cueLineCount('one\\Ntwo')).toBe(2)
    expect(cueLineCount('a\\Nb\\Nc\\Nd')).toBe(4)
  })

  it('★ height reserves the INK extent, not the CSS box', () => {
    // (L−1)×pitch + fontSizePx + 2×outline.  The `L×pitch` form let a −50 %
    // two-line cue collide with the cue stacked above it by 8px (REQ-0332 §6).
    const e = { text: 'a\\Nb', fontSizePx: 100, outlineThicknessPx: 3 }
    expect(estimateCueHeightAssPx({ ...e })).toBe(206)                      // 0 %
    expect(estimateCueHeightAssPx({ ...e, lineSpacingPercent: -50 })).toBe(156)
    expect(estimateCueHeightAssPx({ ...e, lineSpacingPercent: 100 })).toBe(306)
  })

  it('height at 0 % is the pre-REQ-0332 lineCount × fontSizePx + 2 × outline', () => {
    for (const [text, lines] of [['a', 1], ['a\\Nb', 2], ['a\\Nb\\Nc', 3]] as const) {
      expect(estimateCueHeightAssPx({ text, fontSizePx: 80, outlineThicknessPx: 5 }))
        .toBe(lines * 80 + 2 * 5)
    }
  })

  it('the CSS half-leading correction is zero at 0 % and half the delta otherwise', () => {
    expect(lineLeadingCorrectionAssPx(100, 0)).toBe(0)
    expect(lineLeadingCorrectionAssPx(100, 100)).toBe(50)
    expect(lineLeadingCorrectionAssPx(100, -50)).toBe(-25)
  })
})

describe('REQ-0332 §3-1 — per-line `\\pos` anchors', () => {
  const base = {
    lineCount: 2, pitchPx: 100, playResX: 1920, playResY: 1080, marginLrPx: 120,
    verticalMarginPx: 40,
  } as const

  it('★ bottom-centre: the LAST line keeps the unsplit block position', () => {
    // Validated pixel-identical against the unsplit cue (REQ-0332 §6, 10/10).
    const a = cueLineAnchors({ ...base, horizontalPosition: 'center', verticalPosition: 'bottom' })
    expect(a).toEqual([{ x: 960, y: 940 }, { x: 960, y: 1040 }])
  })

  it('top anchors from MarginV downward; centre straddles PlayResY/2', () => {
    expect(cueLineAnchors({ ...base, horizontalPosition: 'center', verticalPosition: 'top' }))
      .toEqual([{ x: 960, y: 40 }, { x: 960, y: 140 }])
    expect(cueLineAnchors({ ...base, horizontalPosition: 'center', verticalPosition: 'center' }))
      .toEqual([{ x: 960, y: 490 }, { x: 960, y: 590 }])
  })

  it('x is the alignment anchor — no text measurement involved', () => {
    const x = (h: 'left' | 'center' | 'right') =>
      cueLineAnchors({ ...base, horizontalPosition: h, verticalPosition: 'bottom' })[0].x
    expect(x('left')).toBe(120)
    expect(x('center')).toBe(960)
    expect(x('right')).toBe(1800)
  })

  it('a pinned cue arranges its lines around its own pinned point', () => {
    expect(cueLineAnchors({
      ...base, horizontalPosition: 'center', verticalPosition: 'bottom', posX: 300, posY: 700,
    })).toEqual([{ x: 300, y: 600 }, { x: 300, y: 700 }])
  })
})

describe('REQ-0332 §3-2 — simultaneously-visible groups', () => {
  it('is the transitive closure of overlap, not the pairwise relation', () => {
    // A–B overlap, B–C overlap, A–C do NOT — all three are still one group,
    // because B cannot be positioned two different ways.
    expect(groupByTimeOverlap([
      { startSec: 0, endSec: 4 },
      { startSec: 3, endSec: 8 },
      { startSec: 6, endSec: 9 },
    ])).toEqual([[0, 1, 2]])
  })

  it('separates cues that never share a frame, end-EXCLUSIVE', () => {
    expect(groupByTimeOverlap([
      { startSec: 0, endSec: 2 },
      { startSec: 2, endSec: 4 },
    ])).toEqual([[0], [1]])
  })

  it('groups by indices into the caller\'s own order', () => {
    expect(groupByTimeOverlap([
      { startSec: 5, endSec: 9 },
      { startSec: 0, endSec: 1 },
      { startSec: 6, endSec: 7 },
    ])).toEqual([[1], [0, 2]])
  })

  it('handles the empty list', () => {
    expect(groupByTimeOverlap([])).toEqual([])
  })
})

describe('REQ-0332 §3 — the splitter is a no-op at 0 %', () => {
  it('expandCueToEvents rejoins with `\\N` when no per-line tags are given', () => {
    const pieces = expandCueToEvents({
      startSec: 0, endSec: 1, marginV: 40, styleTag: '\\an2', lineBodies: ['A', 'B'],
    })
    expect(pieces).toHaveLength(1)
    expect(pieces[0].body).toBe('A\\NB')
  })

  it('throws rather than emit a mismatched split', () => {
    expect(() => expandCueToEvents({
      startSec: 0, endSec: 1, marginV: 0, styleTag: '', lineBodies: ['A', 'B'],
      lineStyleTags: ['\\pos(1,2)'],
    })).toThrow()
  })

  it('★ a 0 % cue emits ONE event with no `\\pos`', () => {
    const lines = dialogues(ass([entry({})]))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toContain('\\pos')
    expect(lines[0]).toContain('AAA\\NBBB')
    // …and an explicit 0 is byte-identical to the absent field.
    expect(ass([entry({ lineSpacingPercent: 0 })])).toBe(ass([entry({})]))
  })

  it('★ a single-line cue never splits, whatever the spacing says', () => {
    expect(ass([entry({ text: 'AAA', lineSpacingPercent: 100 })]))
      .toBe(ass([entry({ text: 'AAA' })]))
  })
})

describe('REQ-0332 §3 — splitting', () => {
  it('★ emits one event per display line, each with its own `\\pos`', () => {
    const lines = dialogues(ass([entry({ lineSpacingPercent: -50 })]))
    expect(lines).toHaveLength(2)
    // pitch 50, bottom-centre, MarginV 40 ⇒ 1080−40−50 and 1080−40.
    expect(lines[0]).toContain('\\pos(960,990)')
    expect(lines[1]).toContain('\\pos(960,1040)')
    expect(lines[0]).toContain('}AAA')
    expect(lines[1]).toContain('}BBB')
    // MarginV column zeroed, as the pinned path already did.
    for (const l of lines) expect(l).toMatch(/Default,0,0,0,,/)
  })

  it('★ a split cue drags its whole simultaneously-visible group along', () => {
    const lines = dialogues(ass([
      entry({ id: 'a', text: 'AAA\\NBBB', lineSpacingPercent: -50 }),
      entry({ id: 'b', text: 'CCC', startSec: 1, endSec: 4 }),
    ]))
    expect(lines).toHaveLength(3)
    // Every cue on screen is positioned by us — never a mix of authorities.
    for (const l of lines) expect(l).toContain('\\pos(')
    // …and the unsplit neighbour clears the split cue's ink extent:
    // height = 1×50 + 100 + 2×3 = 156 ⇒ 1080 − (40 + 156).
    expect(lines[2]).toContain('\\pos(960,884)')
  })

  it('a cue that never shares a frame with a split cue is left to libass', () => {
    const lines = dialogues(ass([
      entry({ id: 'a', text: 'AAA\\NBBB', startSec: 0, endSec: 2, lineSpacingPercent: -50 }),
      entry({ id: 'b', text: 'CCC', startSec: 5, endSec: 8 }),
    ]))
    expect(lines).toHaveLength(3)
    expect(lines[2]).not.toContain('\\pos(')
  })

  it('a pinned cue splits around its pin without dragging anyone', () => {
    const lines = dialogues(ass([
      entry({ id: 'a', posX: 400, posY: 800, lineSpacingPercent: 100 }),
      entry({ id: 'b', text: 'CCC' }),
    ]))
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('\\pos(400,600)')
    expect(lines[1]).toContain('\\pos(400,800)')
    expect(lines[2]).not.toContain('\\pos(')
  })

  it('★ karaoke: a continuation line opens with its own leading silence', () => {
    // `\k` is an EVENT-local clock and every split line's event spans the
    // whole cue, so without a leading block line 2 would sweep from t=0 and
    // the lines would run in parallel.
    const words = [
      { startSec: 0, endSec: 1.5, text: 'AAA' },
      { startSec: 3.5, endSec: 5, text: ' BBB' },
    ]
    const joined = dialogues(generateAss(
      [entry({ karaokeEnabled: true, words })], video, burnin, undefined,
      'Noto Sans JP SemiBold', true, 'sweep',
    ))
    expect(joined).toHaveLength(1)
    // Joined form: the silence sits BEFORE the `\N` (RES-0330 §1-3).
    expect(joined[0]).toContain('{\\k200}\\N')

    const split = dialogues(generateAss(
      [entry({ karaokeEnabled: true, words, lineSpacingPercent: 50 })], video, burnin, undefined,
      'Noto Sans JP SemiBold', true, 'sweep',
    ))
    expect(split).toHaveLength(2)
    expect(split[1]).toContain('{\\k350}{\\kf150}BBB')
    expect(split[1]).not.toContain('\\N')
  })

  it('emphasis spans that straddle a `\\N` land on both lines', () => {
    const lines = dialogues(generateAss([entry({
      lineSpacingPercent: -50,
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FF0066',
      emphasisScalePercent: 100,
      // 'AAA\NBBB' — indices 2..6 cover the last A, the break, the first B.
      emphasisSpans: [{ start: 2, end: 6, text: 'A\\NB' }],
    })], video, burnin, undefined, 'Noto Sans JP SemiBold', true))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('AA{\\fs100\\c&H006600FF&}A')
    expect(lines[1]).toContain('{\\fs100\\c&H006600FF&}B')
  })
})
