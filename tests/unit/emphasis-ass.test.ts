import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import { buildKaraokeAssText } from '../../src/shared/karaoke-ass'
import {
  canUseKeywordEmphasisInTier,
  clampEmphasisScalePercent,
  resolveEmphasisIndices,
  toggleEmphasisIndex,
  buildEmphasisAssText,
  EMPHASIS_DEFAULT_SCALE_PERCENT,
} from '../../src/shared/emphasis'
import type { SubtitleEntry, VideoInfo, BurninPosition, WordSpan } from '../../src/shared/types'

/**
 * REQ-0305 — Hormozi-style keyword emphasis.  Pins:
 *   - the pure helpers (index resolve/toggle, scale clamp, tier gate),
 *   - the ASS text builders (karaoke-OFF `buildEmphasisAssText` and the
 *     karaoke-ON fs overlay on `buildKaraokeAssText`),
 *   - override well-formedness (every tag brace-enclosed — REQ-0291),
 *   - end-to-end emission through `generateAss` including the
 *     words-invalid fallback, karaoke coexistence, and additive-optional
 *     back-compat (no emphasis fields ⇒ byte-identical to plain).
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

/**
 * Well-formedness: after removing every `{...}` override block and the
 * `\N` line-break sentinel, no bare backslash (= stray override tag) may
 * remain.  Mirrors karaoke-ass.test.ts's `\k`-enclosure assertion but
 * generalised to any override.  (Test fixtures contain no literal
 * backslash / brace in their word text, so any survivor is a real bug.)
 */
function assertNoBareOverrides(body: string): void {
  const withoutBlocks = body.replace(/\{[^}]*\}/g, '')
  const withoutBreaks = withoutBlocks.replace(/\\N/g, '')
  expect(withoutBreaks.includes('\\')).toBe(false)
}

// -----------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------
describe('REQ-0305 helpers', () => {
  it('canUseKeywordEmphasisInTier is free for every tier', () => {
    expect(canUseKeywordEmphasisInTier(true)).toBe(true)
    expect(canUseKeywordEmphasisInTier(false)).toBe(true)
  })

  it('clampEmphasisScalePercent clamps, rounds, and defaults', () => {
    expect(clampEmphasisScalePercent(undefined)).toBe(EMPHASIS_DEFAULT_SCALE_PERCENT)
    expect(clampEmphasisScalePercent(130)).toBe(130)
    expect(clampEmphasisScalePercent(50)).toBe(100)   // below min
    expect(clampEmphasisScalePercent(999)).toBe(200)  // above max
    expect(clampEmphasisScalePercent(133.7)).toBe(134) // rounds
    expect(clampEmphasisScalePercent(NaN)).toBe(EMPHASIS_DEFAULT_SCALE_PERCENT)
  })

  it('resolveEmphasisIndices drops stale / invalid / duplicate indices', () => {
    expect([...resolveEmphasisIndices(undefined, 3)]).toEqual([])
    expect([...resolveEmphasisIndices([0, 2], 3)].sort()).toEqual([0, 2])
    // out-of-range (word list shrank), negative, and non-integer dropped:
    expect([...resolveEmphasisIndices([0, 5, -1, 1.5], 3)].sort()).toEqual([0])
    // duplicates collapse:
    expect([...resolveEmphasisIndices([1, 1, 1], 3)]).toEqual([1])
  })

  it('toggleEmphasisIndex adds/removes and stays sorted', () => {
    expect(toggleEmphasisIndex(undefined, 1, 3)).toEqual([1])
    expect(toggleEmphasisIndex([0, 2], 1, 3)).toEqual([0, 1, 2])
    expect(toggleEmphasisIndex([0, 1, 2], 1, 3)).toEqual([0, 2]) // remove
    expect(toggleEmphasisIndex([0], 9, 3)).toEqual([0])          // out-of-range ignored
  })
})

// -----------------------------------------------------------------------
// buildEmphasisAssText (karaoke-OFF path)
// -----------------------------------------------------------------------
describe('REQ-0305 buildEmphasisAssText', () => {
  const escape = (s: string) => s // identity escaper for these fixtures

  it('wraps only emphasised words; leaves others as plain escaped text', () => {
    const body = buildEmphasisAssText(
      validWords, 'hello world', escape,
      new Set([0]),
      '\\fs130\\c&H0000D4FF&',
      '\\fs100\\c&H00FFFFFF&',
    )
    expect(body).toBe('{\\fs130\\c&H0000D4FF&}hello{\\fs100\\c&H00FFFFFF&} world')
    assertNoBareOverrides(body)
  })

  it('with no emphasised index reconstructs the plain cue text', () => {
    const body = buildEmphasisAssText(
      validWords, 'hello world', escape, new Set<number>(), '\\fs130', '\\fs100',
    )
    expect(body).toBe('hello world')
  })

  it('honours `\\N` line breaks and strips the post-break leading space', () => {
    // cueText carries a break between the two words.
    const body = buildEmphasisAssText(
      validWords, 'hello\\Nworld', escape,
      new Set([1]),
      '\\fs130', '\\fs100',
    )
    // word 1 ("world") is preceded by \N, its leading space stripped, and
    // it is emphasised → wrapped.
    expect(body).toBe('hello\\N{\\fs130}world{\\fs100}')
    assertNoBareOverrides(body)
  })
})

// -----------------------------------------------------------------------
// buildKaraokeAssText emphasis overlay (karaoke-ON path, fs only)
// -----------------------------------------------------------------------
describe('REQ-0305 karaoke + emphasis overlay (size only)', () => {
  const escape = (s: string) => s

  it('folds `\\fs` into the emphasised word\'s `\\k` block and restores after', () => {
    const body = buildKaraokeAssText(
      validWords, 0, 2, escape, 'hello world',
      { indices: new Set([0]), openTag: '\\fs130', closeTag: '\\fs100' },
    )
    // emphasised word 0 → `\k` and `\fs130` in the SAME brace block, then
    // a `{\fs100}` restore; the emphasis overlay adds NO colour tag.
    expect(/\{\\k\d+\\fs130\}hello\{\\fs100\}/.test(body)).toBe(true)
    // word 1 is a normal `\k` block, no fs:
    expect(/\{\\k\d+\} world/.test(body)).toBe(true)
    assertNoBareOverrides(body)
  })

  it('is byte-identical to the pre-REQ-0305 output when no emphasis passed', () => {
    const withoutParam = buildKaraokeAssText(validWords, 0, 2, escape, 'hello world')
    const withUndefined = buildKaraokeAssText(validWords, 0, 2, escape, 'hello world', undefined)
    expect(withUndefined).toBe(withoutParam)
  })
})

// -----------------------------------------------------------------------
// End-to-end through generateAss
// -----------------------------------------------------------------------
describe('REQ-0305 generateAss integration', () => {
  it('emphasis ON + valid words → emphasised word carries fs + colour, well-formed', () => {
    const entry = makeEntry({
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FFD400',
      emphasisScalePercent: 130,
      emphasizedWordIndices: [0],
      words: validWords,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    // 130% of fontSize 100 = 130 px; base restore = 100 px.
    expect(line).toContain('\\fs130')
    expect(line).toContain('\\fs100')
    expect(line).toContain('hello')
    expect(line).toContain('world')
    assertNoBareOverrides(line.slice(line.indexOf(',,') + 2))
  })

  it('emphasis ON but words INVALID → plain render (no emphasis tags)', () => {
    const off = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const on = dialogueLineOf(generateAss(
      [makeEntry({
        keywordEmphasisEnabled: true,
        emphasisColorHex: '#FFD400',
        emphasizedWordIndices: [0],
        // words do NOT match text → areWordsValidForText false
        words: [{ startSec: 0, endSec: 1, text: 'different' }],
      })],
      video, burnin, undefined, undefined, true,
    ))
    expect(on).toBe(off)
  })

  it('emphasis ON but NO index selected → plain render', () => {
    const off = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const on = dialogueLineOf(generateAss(
      [makeEntry({ keywordEmphasisEnabled: true, words: validWords, emphasizedWordIndices: [] })],
      video, burnin, undefined, undefined, true,
    ))
    expect(on).toBe(off)
  })

  it('no emphasis fields → byte-identical to a plain cue (additive/back-compat)', () => {
    const plain = dialogueLineOf(generateAss([makeEntry()], video, burnin, undefined, undefined, true))
    const alsoPlain = dialogueLineOf(generateAss([makeEntry({ words: validWords })], video, burnin, undefined, undefined, true))
    expect(alsoPlain).toBe(plain)
  })

  it('karaoke + emphasis both ON → `\\k` present, emphasised word gets fs, colour stays karaoke', () => {
    const entry = makeEntry({
      karaokeEnabled: true,
      karaokeHighlightColor: '#FFFF00',
      keywordEmphasisEnabled: true,
      emphasisColorHex: '#FFD400',
      emphasisScalePercent: 150,
      emphasizedWordIndices: [0],
      words: validWords,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toContain('\\k')          // karaoke active
    expect(line).toContain('\\2c')         // karaoke base colour
    expect(line).toContain('\\fs150')      // emphasis size (150% of 100)
    // fs folded into a \k block (size-only overlay), not a standalone colour swap:
    expect(/\\k\d+\\fs150/.test(line)).toBe(true)
    assertNoBareOverrides(line.slice(line.indexOf(',,') + 2))
  })

  it('emphasis honours uppercase casing on the emphasised word', () => {
    const entry = makeEntry({
      casing: 'uppercase',
      keywordEmphasisEnabled: true,
      emphasizedWordIndices: [0],
      words: validWords,
    })
    const line = dialogueLineOf(generateAss([entry], video, burnin, undefined, undefined, true))
    expect(line).toContain('HELLO')
    expect(line).toContain('WORLD')
  })
})
