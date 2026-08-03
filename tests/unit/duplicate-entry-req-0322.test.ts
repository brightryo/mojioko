import { describe, it, expect } from 'vitest'
import { buildDuplicateEntry, SUBTITLE_ENTRY_DUPLICATION } from '../../src/renderer/lib/duplicate-entry'
import { areWordsValidForText } from '../../src/shared/words-validity'
import { resolveEmphasisRanges } from '../../src/shared/emphasis'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0322 §2 — duplicating a row must carry EVERY `SubtitleEntry` field.
 *
 * The pre-REQ-0322 `duplicateRow` listed 15 of 31 fields inline, so a
 * duplicate lost its karaoke `words` (falling back to even-split timing)
 * and its `emphasisSpans` (losing the emphasis entirely), plus 14 other
 * style-effect fields.  These tests pin the two user-visible symptoms the
 * owner named, plus the structural guarantees.
 */

/** A maximally-populated entry — every optional field present. */
function makeRichEntry(): SubtitleEntry {
  const original = {
    startSec: 1, endSec: 3,
    text: 'Hello brave World',
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeDurationSec: 0.2,
    fontId: 'noto-sans-jp' as const,
    horizontalPosition: 'center' as const,
    verticalPosition: 'bottom' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: true, color: 'black' as const, opacityPercent: 60 },
    posX: 120, posY: 340,
    // REQ-0332 — line spacing (行間); a non-default value so a dropped
    // `copy` classification shows up as a missing field, not a matching zero.
    lineSpacingPercent: -25,
    // REQ-0392 — z-order; non-default so a dropped `copy` shows up as a miss.
    layer: 7,
    casing: 'uppercase' as const,
    shadowDepth: 8, shadowColor: '#112233', shadowAlpha: 70,
    textAlpha: 90, outlineAlpha: 80,
    rotation: 15,
    karaokeEnabled: true,
    karaokeHighlightColor: '#FFCC00',
    karaokeStyle: 'sweep' as const,
    // REQ-0336 §2 — non-default (`false`) so a dropped `copy` classification
    // shows up as a missing field rather than a matching default.
    karaokeUseWordTimings: false,
    animationType: 'pop' as const,
    animationInEnabled: true,
    animationOutEnabled: false,
    animationDurationSec: 0.4,
    animationDirection: 'up' as const,
    animationDistancePx: 60,
    animationStartScalePercent: 35,
    animationBlurPx: 12,
    words: [
      { startSec: 1.0, endSec: 1.4, text: 'Hello' },
      { startSec: 1.4, endSec: 2.2, text: ' brave' },
      { startSec: 2.2, endSec: 3.0, text: ' World' },
    ],
    keywordEmphasisEnabled: true,
    emphasisColorHex: '#FF0066',
    emphasisScalePercent: 130,
    emphasisSpans: [{ start: 6, end: 11, text: 'brave' }],
    emphasisKeywords: ['brave'],
    emphasizedWordIndices: [1],
  }
  return {
    id: 'src-1',
    ...original,
    isDeleted: false,
    isEdited: false,
    original: structuredClone(original),
  }
}

describe('REQ-0322 §2 — duplicateRow carries every SubtitleEntry field', () => {
  it('the classification covers every field of SubtitleEntry', () => {
    // Runtime companion to the compile-time `-?` mapped type: catches a
    // field that exists on a live entry but has no rule (which would mean
    // the type and the value have drifted apart).
    const entry = makeRichEntry()
    const unclassified = Object.keys(entry).filter(
      (k) => !(k in SUBTITLE_ENTRY_DUPLICATION),
    )
    expect(unclassified).toEqual([])
    // And every classified field is exercised by the fixture, so the
    // assertions below are not silently skipping optional fields.
    const unexercised = Object.keys(SUBTITLE_ENTRY_DUPLICATION).filter(
      (k) => !(k in entry),
    )
    expect(unexercised).toEqual([])
  })

  it('★ karaoke does NOT fall back to even-split: words survive and stay valid', () => {
    const src = makeRichEntry()
    expect(areWordsValidForText(src.words, src.text)).toBe(true)

    const dup = buildDuplicateEntry(src, 'dup-1')

    // This is the regression: pre-REQ-0322 `dup.words` was `undefined`,
    // `areWordsValidForText` returned false, and the renderer fell back
    // to even-split karaoke timing.
    expect(dup.words).toBeDefined()
    expect(dup.words).toEqual(src.words)
    expect(areWordsValidForText(dup.words, dup.text)).toBe(true)
    expect(dup.karaokeEnabled).toBe(true)
    expect(dup.karaokeHighlightColor).toBe('#FFCC00')
    // original snapshot too — "Reset row" must not destroy the words.
    expect(areWordsValidForText(dup.original.words, dup.original.text)).toBe(true)
  })

  it('★ emphasis survives duplication and resolves to the same ranges', () => {
    const src = makeRichEntry()
    const dup = buildDuplicateEntry(src, 'dup-2')

    expect(dup.keywordEmphasisEnabled).toBe(true)
    expect(dup.emphasisSpans).toEqual(src.emphasisSpans)
    expect(dup.emphasisColorHex).toBe('#FF0066')
    expect(dup.emphasisScalePercent).toBe(130)

    const srcRanges = resolveEmphasisRanges(src)
    const dupRanges = resolveEmphasisRanges(dup)
    expect(dupRanges).toEqual(srcRanges)
    expect(dupRanges.length).toBeGreaterThan(0)
  })

  it('carries the REQ-0277 / REQ-0310 style effects', () => {
    const src = makeRichEntry()
    const dup = buildDuplicateEntry(src, 'dup-3')
    for (const k of [
      'casing', 'shadowDepth', 'shadowColor', 'shadowAlpha',
      'textAlpha', 'outlineAlpha', 'rotation',
    ] as const) {
      expect(dup[k]).toEqual(src[k])
    }
  })

  it('regenerates the id and resets the bookkeeping flags', () => {
    const dup = buildDuplicateEntry(makeRichEntry(), 'dup-4')
    expect(dup.id).toBe('dup-4')
    expect(dup.isDeleted).toBe(false)
    expect(dup.isEdited).toBe(true)
  })

  it('keeps the source timecodes (copy, not shift) — pre-REQ-0322 behaviour', () => {
    const src = makeRichEntry()
    const dup = buildDuplicateEntry(src, 'dup-5')
    expect(dup.startSec).toBe(src.startSec)
    expect(dup.endSec).toBe(src.endSec)
  })

  it('REQ-0396 — the duplicate lands on the layer ONE ABOVE the source (front)', () => {
    // makeRichEntry has layer 7 → the duplicate shifts up to 8 (front / upper
    // row), so it does not share and overlap the source's row.  The snapshot
    // carries the shifted layer too, so the duplicate is not "edited" on layer.
    const src = makeRichEntry() // layer: 7
    const dup = buildDuplicateEntry(src, 'dup-layer')
    expect(dup.layer).toBe(8)
    expect(dup.original.layer).toBe(8)
  })

  it('REQ-0396 — a default (layer-absent) source duplicates to layer 1', () => {
    const src = { ...makeRichEntry(), layer: undefined, original: { ...makeRichEntry().original, layer: undefined } }
    const dup = buildDuplicateEntry(src, 'dup-default-layer')
    expect(dup.layer).toBe(1) // resolveLayer(undefined) 0 → +1
  })

  it('REQ-0397 §2 — the duplicate layer is never negative (legacy negative source clamps to 0)', () => {
    // A project saved before the REQ-0397 §1 clamp may carry a negative layer.
    // Duplicating such a cue must not produce another negative: -1 + 1 = 0, and
    // an even-lower legacy layer is floored at 0 rather than staying negative.
    const src = { ...makeRichEntry(), layer: -1, original: { ...makeRichEntry().original, layer: -1 } }
    const dup = buildDuplicateEntry(src, 'dup-neg-layer')
    expect(dup.layer).toBe(0)
    expect(dup.original.layer).toBe(0)
    const deep = { ...makeRichEntry(), layer: -5, original: { ...makeRichEntry().original, layer: -5 } }
    expect(buildDuplicateEntry(deep, 'dup-neg-deep').layer).toBe(0)
  })

  it('deep-copies mutable structures: no shared identity anywhere', () => {
    const src = makeRichEntry()
    const dup = buildDuplicateEntry(src, 'dup-6')

    // live vs source
    expect(dup.subtitleBackground).not.toBe(src.subtitleBackground)
    expect(dup.words).not.toBe(src.words)
    expect(dup.words?.[0]).not.toBe(src.words?.[0])
    expect(dup.emphasisSpans).not.toBe(src.emphasisSpans)
    expect(dup.emphasisSpans?.[0]).not.toBe(src.emphasisSpans?.[0])
    expect(dup.emphasisKeywords).not.toBe(src.emphasisKeywords)
    expect(dup.emphasizedWordIndices).not.toBe(src.emphasizedWordIndices)

    // live vs its own original snapshot
    expect(dup.original.subtitleBackground).not.toBe(dup.subtitleBackground)
    expect(dup.original.words).not.toBe(dup.words)
    expect(dup.original.emphasisSpans).not.toBe(dup.emphasisSpans)

    // mutating the duplicate must not reach back into the source
    dup.subtitleBackground.opacityPercent = 5
    dup.words![0].text = 'MUTATED'
    expect(src.subtitleBackground.opacityPercent).toBe(60)
    expect(src.words![0].text).toBe('Hello')
  })

  it('preserves ABSENCE — an unset optional key is not written as undefined', () => {
    const src = makeRichEntry()
    delete src.emphasisSpans
    delete src.words
    const dup = buildDuplicateEntry(src, 'dup-7')

    // `resolveEmphasis` distinguishes "spans absent → fall back to
    // emphasisKeywords" from "spans present but empty → nothing
    // selected".  Writing `undefined` would flip that judgement.
    expect('emphasisSpans' in dup).toBe(false)
    expect('words' in dup).toBe(false)
    expect('emphasisSpans' in dup.original).toBe(false)
    // the legacy fallback path still has its input
    expect(dup.emphasisKeywords).toEqual(['brave'])
  })

  it('the original snapshot mirrors the duplicate field for field', () => {
    const dup = buildDuplicateEntry(makeRichEntry(), 'dup-8')
    const carried = Object.entries(SUBTITLE_ENTRY_DUPLICATION)
      .filter(([, rule]) => rule === 'copy' || rule === 'deep-copy')
      .map(([k]) => k)
    for (const k of carried) {
      expect((dup.original as Record<string, unknown>)[k]).toEqual(
        (dup as unknown as Record<string, unknown>)[k],
      )
    }
  })
})
