import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import {
  canUseKeywordEmphasisInTier,
  clampEmphasisScalePercent,
  resolveEmphasisKeywords,
  addEmphasisKeyword,
  removeEmphasisKeyword,
  toggleEmphasisKeyword,
  computeEmphasisRanges,
  tokenizeEmphasis,
  emphasizedWordSet,
  buildEmphasisBody,
  EMPHASIS_DEFAULT_SCALE_PERCENT,
} from '../../src/shared/emphasis'
import type { SubtitleEntry, VideoInfo, BurninPosition, WordSpan } from '../../src/shared/types'

/**
 * REQ-0306 — keyword/text-based keyword emphasis (rework of REQ-0305).
 * Pins: the keyword helpers + legacy migration, range/tokeniser, the
 * karaoke-word mapping, override well-formedness, and end-to-end emission —
 * crucially that emphasis works WITHOUT / with invalid `words` (the core fix)
 * and that karaoke coexistence follows Option A (grow + emphasis colour when
 * spoken).
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
describe('REQ-0306 keyword helpers', () => {
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

  it('add/remove/toggle keep the list trimmed + de-duplicated', () => {
    expect(addEmphasisKeyword([], '  fox ')).toEqual(['fox'])
    expect(addEmphasisKeyword(['fox'], 'fox')).toEqual(['fox']) // dedupe
    expect(removeEmphasisKeyword(['fox', 'cat'], ' fox ')).toEqual(['cat'])
    expect(toggleEmphasisKeyword(['fox'], 'fox')).toEqual([])
    expect(toggleEmphasisKeyword(['fox'], 'cat')).toEqual(['fox', 'cat'])
    expect(toggleEmphasisKeyword([], '   ')).toEqual([]) // blank ignored
  })

  it('resolveEmphasisKeywords prefers keywords, else migrates legacy indices', () => {
    // New format wins (even empty).
    expect(resolveEmphasisKeywords(['fox'], [0], validWords)).toEqual(['fox'])
    expect(resolveEmphasisKeywords([], [0], validWords)).toEqual([])
    // Legacy migration: index 1 → words[1].text (' world') trimmed.
    expect(resolveEmphasisKeywords(undefined, [1], validWords)).toEqual(['world'])
    // Neither → empty.
    expect(resolveEmphasisKeywords(undefined, undefined, undefined)).toEqual([])
    // Legacy indices but no words → empty (no throw).
    expect(resolveEmphasisKeywords(undefined, [0], undefined)).toEqual([])
  })
})

// -----------------------------------------------------------------------
// Ranges + tokeniser
// -----------------------------------------------------------------------
describe('REQ-0306 ranges + tokeniser', () => {
  it('finds every occurrence and merges overlaps', () => {
    expect(computeEmphasisRanges('the fox and the fox', ['fox'])).toEqual([[4, 7], [16, 19]])
    // Overlapping keywords merge into one range.
    expect(computeEmphasisRanges('abcdef', ['abc', 'cde'])).toEqual([[0, 5]])
    expect(computeEmphasisRanges('nothing here', ['xyz'])).toEqual([])
  })

  it('a keyword never matches across a \\N sentinel', () => {
    // "ab\Ncd" has no literal "bc" (the sentinel sits between b and c).
    expect(computeEmphasisRanges('ab\\Ncd', ['bc'])).toEqual([])
  })

  it('tokenize round-trips the text and marks emphasised runs', () => {
    const toks = tokenizeEmphasis('the fox ran', computeEmphasisRanges('the fox ran', ['fox']))
    // Reconstruct → original.
    const rebuilt = toks.map((t) => (t.kind === 'break' ? '\\N' : t.text)).join('')
    expect(rebuilt).toBe('the fox ran')
    expect(toks).toEqual([
      { kind: 'text', text: 'the ', emphasized: false },
      { kind: 'text', text: 'fox', emphasized: true },
      { kind: 'text', text: ' ran', emphasized: false },
    ])
  })

  it('tokenize emits breaks for \\N', () => {
    const toks = tokenizeEmphasis('a\\Nb', [])
    expect(toks).toEqual([
      { kind: 'text', text: 'a', emphasized: false },
      { kind: 'break' },
      { kind: 'text', text: 'b', emphasized: false },
    ])
  })

  it('emphasizedWordSet maps keywords onto karaoke word units (stripped)', () => {
    // keyword "hello" → word 0; "world" → word 1.
    expect([...emphasizedWordSet('hello world', validWords, ['hello'])]).toEqual([0])
    expect([...emphasizedWordSet('hello world', validWords, ['world'])]).toEqual([1])
    expect([...emphasizedWordSet('hello world', validWords, ['zzz'])]).toEqual([])
  })
})

// -----------------------------------------------------------------------
// buildEmphasisBody (karaoke-OFF)
// -----------------------------------------------------------------------
describe('REQ-0306 buildEmphasisBody', () => {
  const esc = (s: string) => s
  it('wraps emphasised runs, leaves the rest plain, well-formed', () => {
    const body = buildEmphasisBody(
      'the fox ran',
      computeEmphasisRanges('the fox ran', ['fox']),
      esc,
      '\\fs130\\c&H0000D4FF&',
      '\\fs100\\c&H00FFFFFF&',
    )
    expect(body).toBe('the {\\fs130\\c&H0000D4FF&}fox{\\fs100\\c&H00FFFFFF&} ran')
    assertNoBareOverrides(body)
  })

  it('preserves \\N breaks', () => {
    const body = buildEmphasisBody('a\\Nfox', computeEmphasisRanges('a\\Nfox', ['fox']), esc, '\\fs130', '\\fs100')
    expect(body).toBe('a\\N{\\fs130}fox{\\fs100}')
  })
})

// -----------------------------------------------------------------------
// End-to-end through generateAss
// -----------------------------------------------------------------------
describe('REQ-0306 generateAss integration', () => {
  it('emphasises a keyword with fs + colour (karaoke off), well-formed', () => {
    const entry = makeEntry({
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FFD400',
      emphasisScalePercent: 130,
      emphasisKeywords: ['hello'],
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toContain('\\fs130')
    expect(line).toContain('\\fs100')
    expect(line).toContain('hello')
    assertNoBareOverrides(bodyOf(line))
  })

  it('§1 CORE — emphasis works with NO words at all', () => {
    const entry = makeEntry({
      text: 'jump over the fence',
      words: undefined,
      keywordEmphasisEnabled: true,
      emphasisKeywords: ['fence'],
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toContain('\\fs130')
    expect(line).toMatch(/\{\\fs130[^}]*\}fence\{/)
  })

  it('§1 CORE — emphasis works when words are INVALID (edited text)', () => {
    // words no longer match text (user edited) — emphasis must still fire
    // because it no longer depends on areWordsValidForText.
    const entry = makeEntry({
      text: 'the quick fox',
      words: [{ startSec: 0, endSec: 1, text: 'completelyDifferent' }],
      keywordEmphasisEnabled: true,
      emphasisKeywords: ['fox'],
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toMatch(/\{\\fs130[^}]*\}fox\{/)
  })

  it('migrates legacy emphasizedWordIndices when no keywords present', () => {
    const entry = makeEntry({
      keywordEmphasisEnabled: true,
      emphasizedWordIndices: [0], // → "hello"
      words: validWords,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toMatch(/\{\\fs130[^}]*\}hello\{/)
  })

  it('no emphasis fields → byte-identical to a plain cue', () => {
    const plain = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const off = dialogueLineOf(generateAss([makeEntry({ keywordEmphasisEnabled: false })], video, burnin, undefined, undefined, true))
    expect(off).toBe(plain)
  })

  it('enabled but keyword matches nothing → plain render', () => {
    const plain = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const noMatch = dialogueLineOf(generateAss(
      [makeEntry({ keywordEmphasisEnabled: true, emphasisKeywords: ['zzz'] })],
      video, burnin, undefined, undefined, true,
    ))
    expect(noMatch).toBe(plain)
  })

  it('§3 karaoke + emphasis (Option A) — emphasised word gets fs + emphasis colour, restores highlight', () => {
    const entry = makeEntry({
      karaokeEnabled: true,
      karaokeHighlightColor: '#FFFF00',
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FFD400',
      emphasisScalePercent: 150,
      emphasisKeywords: ['hello'],
      words: validWords,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toContain('\\k')   // karaoke active
    expect(line).toContain('\\2c')  // base (unspoken) colour
    // emphasised word 0 → \k + \fs150 + \c<emph> in the same block.
    expect(/\\k\d+\\fs150\\c&H[0-9A-F]{8}&/.test(line)).toBe(true)
    // hexToAss('#FFD400') = &H0000D4FF& (BGR) — the emphasis colour.
    expect(line).toContain('\\c&H0000D4FF&')
    assertNoBareOverrides(bodyOf(line))
  })
})
