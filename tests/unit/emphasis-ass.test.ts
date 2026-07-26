import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import {
  canUseKeywordEmphasisInTier,
  clampEmphasisScalePercent,
  resolveEmphasisKeywords,
  resolveEmphasisSpans,
  resolveEmphasis,
  spansFromSelection,
  selectionFromRanges,
  computeEmphasisRanges,
  tokenizeEmphasis,
  emphasizedWordRanges,
  splitTextByLocalRanges,
  buildEmphasisBody,
  EMPHASIS_DEFAULT_SCALE_PERCENT,
  type EmphasisSpan,
} from '../../src/shared/emphasis'
import type { SubtitleEntry, VideoInfo, BurninPosition, WordSpan } from '../../src/shared/types'

/**
 * REQ-0307 — per-character, anchored-span keyword emphasis (rework of the
 * REQ-0306 keyword model).
 *
 * The headline pin is §2/§3 of the REQ: when a substring occurs more than once
 * in a cue, ONLY the occurrence the user picked is emphasised — while a text
 * edit still re-anchors rather than silently emphasising the wrong glyphs.
 * Also pinned: `words`-independence, karaoke coexistence across `\k`
 * boundaries, override well-formedness (REQ-0291) and legacy-save tolerance.
 */

const video: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const burnin: BurninPosition = { horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40 }

const validWords: WordSpan[] = [
  { startSec: 0, endSec: 0.5, text: 'hello' },
  { startSec: 0.5, endSec: 1.0, text: ' world' },
]

function makeEntry(patch: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base: SubtitleEntry = {
    id: 'e1',
    startSec: 0, endSec: 2,
    text: 'hello world',
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0,
    horizontalPosition: 'center',
    verticalPosition: 'bottom',
    verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    isDeleted: false,
    isEdited: false,
    original: {
      startSec: 0, endSec: 2, text: 'hello world',
      fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
      outlineThicknessPx: 3, fadeDurationSec: 0,
      horizontalPosition: 'center', verticalPosition: 'bottom',
      verticalMarginPx: 40,
      subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    },
  }
  return { ...base, ...patch }
}

/** Span covering the Nth (0-based) occurrence of `needle` in `text`. */
function spanAt(text: string, needle: string, occurrence = 0): EmphasisSpan {
  let idx = -1
  for (let n = 0; n <= occurrence; n++) idx = text.indexOf(needle, idx + 1)
  return { start: idx, end: idx + needle.length, text: needle }
}

const dialogueLineOf = (ass: string): string =>
  ass.split('\n').find((l) => l.startsWith('Dialogue:')) ?? ''

const bodyOf = (line: string): string => line.slice(line.indexOf(',,') + 2)

/** No override tag may live outside a `{...}` block (REQ-0291); `\N` allowed. */
function assertNoBareOverrides(body: string): void {
  const withoutBlocks = body.replace(/\{[^}]*\}/g, '')
  const withoutBreaks = withoutBlocks.replace(/\\N/g, '')
  expect(withoutBreaks.includes('\\')).toBe(false)
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
describe('REQ-0307 emphasis helpers', () => {
  it('tier gate is free', () => {
    expect(canUseKeywordEmphasisInTier(true)).toBe(true)
    expect(canUseKeywordEmphasisInTier(false)).toBe(true)
  })

  it('clampEmphasisScalePercent clamps/rounds/defaults', () => {
    expect(clampEmphasisScalePercent(undefined)).toBe(EMPHASIS_DEFAULT_SCALE_PERCENT)
    expect(clampEmphasisScalePercent(50)).toBe(100)
    expect(clampEmphasisScalePercent(999)).toBe(200)
    expect(clampEmphasisScalePercent(NaN)).toBe(EMPHASIS_DEFAULT_SCALE_PERCENT)
  })

  it('resolveEmphasisKeywords survives as the legacy migration step only', () => {
    expect(resolveEmphasisKeywords(['fox'], [0], validWords)).toEqual(['fox'])
    expect(resolveEmphasisKeywords([], [0], validWords)).toEqual([])
    expect(resolveEmphasisKeywords(undefined, [1], validWords)).toEqual(['world'])
    expect(resolveEmphasisKeywords(undefined, undefined, undefined)).toEqual([])
    expect(resolveEmphasisKeywords(undefined, [0], undefined)).toEqual([])
  })
})

// -----------------------------------------------------------------------
// §2 — span resolution (the heart of REQ-0307)
// -----------------------------------------------------------------------
describe('REQ-0307 §2 — resolveEmphasisSpans resolution order', () => {
  it('rule 1 — exact offsets+anchor pick ONLY the chosen duplicate', () => {
    const text = 'fox and fox'
    const second = spanAt(text, 'fox', 1)     // [8, 11)
    const r = resolveEmphasisSpans(text, [second])
    expect(r.ranges).toEqual([[8, 11]])
    expect(r.changed).toBe(false)
    // ...and picking the FIRST one gives the first range, nothing else.
    expect(resolveEmphasisSpans(text, [spanAt(text, 'fox', 0)]).ranges).toEqual([[0, 3]])
  })

  it('rule 1 — a stale offset that happens to land on the same text is kept', () => {
    // "abc" at 0 still reads "abc" after an unrelated edit further right.
    const r = resolveEmphasisSpans('abc def GHI', [{ start: 0, end: 3, text: 'abc' }])
    expect(r.ranges).toEqual([[0, 3]])
    expect(r.changed).toBe(false)
  })

  it('rule 2 — a unique anchor elsewhere re-anchors, and reports changed', () => {
    // Stored against "the fox"; the user prefixed "oh " so everything shifted.
    const r = resolveEmphasisSpans('oh the fox', [{ start: 4, end: 7, text: 'fox' }])
    expect(r.ranges).toEqual([[7, 10]])
    expect(r.spans).toEqual([{ start: 7, end: 10, text: 'fox' }])
    expect(r.changed).toBe(true)
  })

  it('rule 3 — an absent anchor drops that span and leaves the others', () => {
    const text = 'the quick fox'
    const r = resolveEmphasisSpans(text, [
      { start: 4, end: 9, text: 'quick' },     // resolves
      { start: 20, end: 25, text: 'zebra' },   // gone from the text
    ])
    expect(r.ranges).toEqual([[4, 9]])
    expect(r.spans).toEqual([{ start: 4, end: 9, text: 'quick' }])
    expect(r.changed).toBe(true)
  })

  it('rule 3 — an AMBIGUOUS anchor is dropped rather than guessed', () => {
    // Offsets no longer valid AND "fox" occurs twice → we cannot know which one
    // the user meant, so the span dies (better than emphasising the wrong one).
    const text = 'fox and fox'
    const r = resolveEmphasisSpans(text, [
      { start: 99, end: 102, text: 'fox' },
      { start: 4, end: 7, text: 'and' },       // unambiguous, survives
    ])
    expect(r.ranges).toEqual([[4, 7]])
    expect(r.changed).toBe(true)
  })

  it('overlapping resolved spans merge into one render range', () => {
    const r = resolveEmphasisSpans('abcdef', [
      { start: 0, end: 3, text: 'abc' },
      { start: 2, end: 5, text: 'cde' },
    ])
    expect(r.ranges).toEqual([[0, 5]])
  })

  it('never throws on corrupt / legacy-shaped input', () => {
    const junk = [null, 42, 'nope', {}, { start: 1 }, { start: NaN, end: 3, text: 'a' }, { start: 0, end: 1, text: '' }]
    expect(() => resolveEmphasisSpans('abc', junk)).not.toThrow()
    expect(resolveEmphasisSpans('abc', junk).ranges).toEqual([])
    expect(resolveEmphasisSpans('abc', undefined).ranges).toEqual([])
  })
})

describe('REQ-0307 §3 — resolveEmphasis migration precedence', () => {
  it('spans win, even when empty', () => {
    expect(resolveEmphasis({ text: 'hello world', emphasisSpans: [], emphasisKeywords: ['hello'] }).ranges).toEqual([])
  })

  it('migrates a REQ-0306 keyword list into per-occurrence spans', () => {
    const r = resolveEmphasis({ text: 'fox and fox', emphasisKeywords: ['fox'] })
    // The old model emphasised every occurrence — migration preserves that, but
    // now as explicit spans the user can prune in the picker.
    expect(r.ranges).toEqual([[0, 3], [8, 11]])
    expect(r.spans).toEqual([
      { start: 0, end: 3, text: 'fox' },
      { start: 8, end: 11, text: 'fox' },
    ])
    expect(r.changed).toBe(true)
  })

  it('migrates REQ-0305 word indices via the word text', () => {
    const r = resolveEmphasis({ text: 'hello world', emphasizedWordIndices: [1], words: validWords })
    expect(r.ranges).toEqual([[6, 11]])
  })

  it('no emphasis data at all → nothing, unchanged', () => {
    expect(resolveEmphasis({ text: 'hello world' })).toEqual({ ranges: [], spans: [], changed: false })
  })
})

// -----------------------------------------------------------------------
// §1 — picker selection ↔ span conversion
// -----------------------------------------------------------------------
describe('REQ-0307 §1 — selection ↔ spans', () => {
  /** Mirror of the dialog's cell builder for a text with no `\N`. */
  const cellsOf = (text: string): Array<{ start: number; length: number }> =>
    [...text].map((_, i) => ({ start: i, length: 1 }))

  it('merges physically adjacent selected cells into one span', () => {
    const text = 'abcdef'
    const spans = spansFromSelection(text, cellsOf(text), new Set([1, 2, 3]))
    expect(spans).toEqual([{ start: 1, end: 4, text: 'bcd' }])
  })

  it('a gap in the selection produces two spans', () => {
    const text = 'abcdef'
    const spans = spansFromSelection(text, cellsOf(text), new Set([0, 1, 4, 5]))
    expect(spans).toEqual([
      { start: 0, end: 2, text: 'ab' },
      { start: 4, end: 6, text: 'ef' },
    ])
  })

  it('a `\\N` between selected characters splits the span (no backslash anchors)', () => {
    const text = 'ab\\Ncd'
    // Cells skip the two-character sentinel, exactly like the dialog does.
    const cells = [
      { start: 0, length: 1 }, { start: 1, length: 1 },
      { start: 4, length: 1 }, { start: 5, length: 1 },
    ]
    const spans = spansFromSelection(text, cells, new Set([1, 4]))
    expect(spans).toEqual([
      { start: 1, end: 2, text: 'b' },
      { start: 4, end: 5, text: 'c' },
    ])
    for (const s of spans) expect(s.text).not.toContain('\\')
  })

  it('selectionFromRanges round-trips through spansFromSelection', () => {
    const text = 'the fox ran'
    const cells = cellsOf(text)
    const selected = new Set([4, 5, 6])
    const spans = spansFromSelection(text, cells, selected)
    const { ranges } = resolveEmphasisSpans(text, spans)
    expect(selectionFromRanges(cells, ranges)).toEqual(selected)
  })

  it('an empty selection clears emphasis', () => {
    expect(spansFromSelection('abc', cellsOf('abc'), new Set())).toEqual([])
  })
})

// -----------------------------------------------------------------------
// Tokeniser + body builder (karaoke OFF)
// -----------------------------------------------------------------------
describe('REQ-0307 tokeniser + buildEmphasisBody', () => {
  const esc = (s: string) => s

  it('tokenize round-trips the text and marks emphasised runs', () => {
    const toks = tokenizeEmphasis('the fox ran', [[4, 7]])
    const rebuilt = toks.map((t) => (t.kind === 'break' ? '\\N' : t.text)).join('')
    expect(rebuilt).toBe('the fox ran')
    expect(toks).toEqual([
      { kind: 'text', text: 'the ', emphasized: false },
      { kind: 'text', text: 'fox', emphasized: true },
      { kind: 'text', text: ' ran', emphasized: false },
    ])
  })

  it('tokenize emits breaks for \\N', () => {
    expect(tokenizeEmphasis('a\\Nb', [])).toEqual([
      { kind: 'text', text: 'a', emphasized: false },
      { kind: 'break' },
      { kind: 'text', text: 'b', emphasized: false },
    ])
  })

  it('wraps emphasised runs, leaves the rest plain, well-formed', () => {
    const body = buildEmphasisBody('the fox ran', [[4, 7]], esc, '\\fs130\\c&H0000D4FF&', '\\fs100\\c&H00FFFFFF&')
    expect(body).toBe('the {\\fs130\\c&H0000D4FF&}fox{\\fs100\\c&H00FFFFFF&} ran')
    assertNoBareOverrides(body)
  })

  it('REQ-0307 §4 — a span need not align with a word boundary', () => {
    // Emphasise "ck fo" straddling the space: still one well-formed run.
    const text = 'the quick fox'
    const body = buildEmphasisBody(text, [[7, 12]], esc, '\\fs130', '\\fs100')
    expect(body).toBe('the qui{\\fs130}ck fo{\\fs100}x')
    assertNoBareOverrides(body)
  })

  it('preserves \\N breaks', () => {
    const body = buildEmphasisBody('a\\Nfox', [[3, 6]], esc, '\\fs130', '\\fs100')
    expect(body).toBe('a\\N{\\fs130}fox{\\fs100}')
  })

  // computeEmphasisRanges is migration-only now, but its semantics still
  // matter because a legacy save's rendering must not change.
  it('legacy computeEmphasisRanges still finds every occurrence + merges', () => {
    expect(computeEmphasisRanges('the fox and the fox', ['fox'])).toEqual([[4, 7], [16, 19]])
    expect(computeEmphasisRanges('abcdef', ['abc', 'cde'])).toEqual([[0, 5]])
    expect(computeEmphasisRanges('ab\\Ncd', ['bc'])).toEqual([])
  })
})

// -----------------------------------------------------------------------
// §4 — karaoke coexistence at character granularity
// -----------------------------------------------------------------------
describe('REQ-0307 §4 — emphasizedWordRanges + splitTextByLocalRanges', () => {
  it('clips a whole-word span to that word only', () => {
    const m = emphasizedWordRanges('hello world', validWords, [[0, 5]])
    expect([...m.entries()]).toEqual([[0, [[0, 5]]]])
  })

  it('splits a span that straddles two `\\k` blocks at the boundary', () => {
    // "lo wo" — 2 chars of word 0, 2 chars of word 1, space in between.
    const m = emphasizedWordRanges('hello world', validWords, [[3, 8]])
    expect(m.get(0)).toEqual([[3, 5]])   // "lo" inside "hello"
    expect(m.get(1)).toEqual([[0, 2]])   // "wo" inside " world"
  })

  it('splitTextByLocalRanges reproduces the word text exactly', () => {
    const runs = splitTextByLocalRanges(' world', [[0, 2]])
    expect(runs).toEqual([
      { text: ' ', emphasized: false },   // leading space never grows
      { text: 'wo', emphasized: true },
      { text: 'rld', emphasized: false },
    ])
    expect(runs.map((r) => r.text).join('')).toBe(' world')
  })

  it('an unemphasised word yields a single plain run', () => {
    expect(splitTextByLocalRanges('hello', [])).toEqual([{ text: 'hello', emphasized: false }])
  })

  it('maps onto equal-split fallback units too (edited cue, `words` invalid)', () => {
    // Fallback units are derived from the cue text, so the stripped-concat
    // invariant holds and emphasis still rides along with karaoke.
    const fallback: WordSpan[] = [
      { startSec: 0, endSec: 1, text: 'あい' },
      { startSec: 1, endSec: 2, text: 'うえ' },
    ]
    const m = emphasizedWordRanges('あいうえ', fallback, [[1, 3]])
    expect(m.get(0)).toEqual([[1, 2]])
    expect(m.get(1)).toEqual([[0, 1]])
  })
})

// -----------------------------------------------------------------------
// End-to-end through generateAss
// -----------------------------------------------------------------------
describe('REQ-0307 generateAss integration', () => {
  it('emphasises a span with fs + colour (karaoke off), well-formed', () => {
    const text = 'hello world'
    const entry = makeEntry({
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FFD400',
      emphasisScalePercent: 130,
      emphasisSpans: [spanAt(text, 'hello')],
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toContain('\\fs130')
    expect(line).toContain('\\fs100')
    expect(line).toMatch(/\{\\fs130[^}]*\}hello\{/)
    assertNoBareOverrides(bodyOf(line))
  })

  it('§2 CORE — with a duplicated substring, ONLY the chosen occurrence is emphasised', () => {
    const text = 'fox and fox'
    const entry = makeEntry({
      text,
      words: undefined,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 130,
      emphasisSpans: [spanAt(text, 'fox', 1)],   // the SECOND "fox"
    })
    const body = bodyOf(dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true)))
    // Everything up to the emphasis block is plain — so the first "fox" is not
    // wrapped — and exactly one emphasis open tag exists.
    expect(body).toMatch(/\}fox and \{\\fs130[^}]*\}fox\{\\fs100[^}]*\}$/)
    expect(body.match(/\\fs130/g)).toHaveLength(1)
    assertNoBareOverrides(body)
  })

  it('§2 — the same selection on the FIRST occurrence emphasises the first only', () => {
    const text = 'fox and fox'
    const entry = makeEntry({
      text, words: undefined,
      keywordEmphasisEnabled: true, emphasisScalePercent: 130,
      emphasisSpans: [spanAt(text, 'fox', 0)],
    })
    const body = bodyOf(dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true)))
    expect(body).toMatch(/^\{[^}]*\}\{\\fs130[^}]*\}fox\{\\fs100[^}]*\} and fox$/)
    expect(body.match(/\\fs130/g)).toHaveLength(1)
  })

  it('§2 — emphasis survives a text edit via anchor re-anchoring', () => {
    // Span was made against "the fox"; the user prefixed "oh ".
    const entry = makeEntry({
      text: 'oh the fox',
      words: undefined,
      keywordEmphasisEnabled: true, emphasisScalePercent: 130,
      emphasisSpans: [{ start: 4, end: 7, text: 'fox' }],
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toMatch(/\{\\fs130[^}]*\}fox\{/)
  })

  it('§2 — an unresolvable span is dropped without taking the others with it', () => {
    const entry = makeEntry({
      text: 'the quick fox',
      words: undefined,
      keywordEmphasisEnabled: true, emphasisScalePercent: 130,
      emphasisSpans: [
        { start: 50, end: 55, text: 'zebra' },   // gone
        { start: 4, end: 9, text: 'quick' },     // survives
      ],
    })
    const body = bodyOf(dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true)))
    expect(body).toMatch(/\{\\fs130[^}]*\}quick\{/)
    expect(body.match(/\\fs130/g)).toHaveLength(1)
    assertNoBareOverrides(body)
  })

  it('§3 CORE — emphasis works with NO words at all', () => {
    const text = 'jump over the fence'
    const entry = makeEntry({
      text, words: undefined,
      keywordEmphasisEnabled: true,
      emphasisSpans: [spanAt(text, 'fence')],
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toMatch(/\{\\fs130[^}]*\}fence\{/)
  })

  it('§3 CORE — emphasis works when words are INVALID (edited text)', () => {
    const text = 'the quick fox'
    const entry = makeEntry({
      text,
      words: [{ startSec: 0, endSec: 1, text: 'completelyDifferent' }],
      keywordEmphasisEnabled: true,
      emphasisSpans: [spanAt(text, 'fox')],
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toMatch(/\{\\fs130[^}]*\}fox\{/)
  })

  it('§3 — legacy REQ-0306 keywords still render (migrated, no throw)', () => {
    const entry = makeEntry({ keywordEmphasisEnabled: true, emphasisKeywords: ['hello'] })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toMatch(/\{\\fs130[^}]*\}hello\{/)
  })

  it('§3 — legacy REQ-0305 word indices still render (migrated, no throw)', () => {
    const entry = makeEntry({
      keywordEmphasisEnabled: true,
      emphasizedWordIndices: [0], // → "hello"
      words: validWords,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toMatch(/\{\\fs130[^}]*\}hello\{/)
  })

  it('§3 — a corrupt emphasisSpans payload degrades to plain, never throws', () => {
    const plain = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const entry = makeEntry({
      keywordEmphasisEnabled: true,
      // Deliberately not EmphasisSpan[] — mimics a hand-edited / older save.
      emphasisSpans: [{ foo: 1 }, null, 'x'] as unknown as EmphasisSpan[],
    })
    let line = ''
    expect(() => { line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true)) }).not.toThrow()
    expect(line).toBe(plain)
  })

  it('no emphasis fields → byte-identical to a plain cue', () => {
    const plain = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const off = dialogueLineOf(generateAss([makeEntry({ keywordEmphasisEnabled: false })], video, burnin, undefined, undefined, true))
    expect(off).toBe(plain)
  })

  it('enabled but no span resolves → plain render', () => {
    const plain = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const noMatch = dialogueLineOf(generateAss(
      [makeEntry({ keywordEmphasisEnabled: true, emphasisSpans: [{ start: 0, end: 3, text: 'zzz' }] })],
      video, burnin, undefined, undefined, true,
    ))
    expect(noMatch).toBe(plain)
  })

  it('§4 karaoke + emphasis (Option A) — whole word grows and lights in the emphasis colour', () => {
    const text = 'hello world'
    const entry = makeEntry({
      karaokeEnabled: true,
      karaokeHighlightColor: '#FFFF00',
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FFD400',
      emphasisScalePercent: 150,
      emphasisSpans: [spanAt(text, 'hello')],
      words: validWords,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toContain('\\k')   // karaoke active
    expect(line).toContain('\\2c')  // base (unspoken) colour
    // Whole-word emphasis keeps the folded shape: \k + \fs + \c in one block.
    expect(/\\k\d+\\fs150\\c&H[0-9A-F]{8}&/.test(line)).toBe(true)
    // hexToAss('#FFD400') = &H0000D4FF& (BGR) — the emphasis colour.
    expect(line).toContain('\\c&H0000D4FF&')
    assertNoBareOverrides(bodyOf(line))
  })

  it('§4 CORE — a span straddling a `\\k` boundary splits at the boundary, timing intact', () => {
    // "lo wo" covers the tail of "hello" and the head of " world" in the
    // default cue text ("hello world").
    const entry = makeEntry({
      karaokeEnabled: true,
      karaokeHighlightColor: '#FFFF00',
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FFD400',
      emphasisScalePercent: 150,
      emphasisSpans: [{ start: 3, end: 8, text: 'lo wo' }],
      words: validWords,
    })
    const body = bodyOf(dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true)))
    // Both karaoke blocks survive with their original durations (word 1 starts
    // at 0.5s → k50; it then holds to the cue end at 2s → k150).
    expect(body).toContain('\\k50')
    expect(body).toContain('\\k150')
    // Word 0: plain "hel", then emphasised "lo", then style restored.
    expect(body).toMatch(/\}hel\{\\fs150\\c&H0000D4FF&\}lo\{\\fs100\\c&H0000FFFF&\}/)
    // Word 1: the `\k` block, the (unemphasised) leading space, then "wo".
    expect(body).toMatch(/\{\\k150\} \{\\fs150\\c&H0000D4FF&\}wo\{\\fs100\\c&H0000FFFF&\}rld/)
    // Concatenating the visible text still reproduces the cue.
    expect(body.replace(/\{[^}]*\}/g, '')).toBe('hello world')
    assertNoBareOverrides(body)
  })

  it('§4 — karaoke without emphasis is unchanged by the REQ-0307 rework', () => {
    const withEmph = makeEntry({ karaokeEnabled: true, words: validWords, keywordEmphasisEnabled: false })
    const line = dialogueLineOf(generateAss([withEmph], video, burnin, undefined, undefined, true))
    expect(bodyOf(line).replace(/\{[^}]*\}/g, '')).toBe('hello world')
    expect(bodyOf(line)).not.toContain('\\fs150')
    assertNoBareOverrides(bodyOf(line))
  })
})
