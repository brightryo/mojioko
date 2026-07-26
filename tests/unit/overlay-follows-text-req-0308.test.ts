import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import type { SubtitleEntry, WordSpan } from '../../src/shared/types'

/**
 * REQ-0308 §1 — "the preview always shows the cue's own text".
 *
 * The reported symptom was that running auto-line-break left the video preview
 * on the PRE-wrap text while the editor and the table showed the wrapped one.
 * The overlay itself turned out to be a pure function of `entry.text` with no
 * memoisation on either the plain or the emphasis path — the divergence came
 * from the KARAOKE path, where line breaks are derived from word units rather
 * than read off `\N` directly, and a mid-word break was silently dropped
 * (see `karaoke-hard-break-split-req-0308.test.ts`).
 *
 * These tests pin the property that actually matters, at the render boundary
 * and for ALL THREE paths, so any future memoisation or break-mapping change
 * that reintroduces the divergence fails here:
 *
 *   rendered line count === (number of `\N` in entry.text) + 1
 *
 * Rendering goes through `react-dom/server`, which needs no DOM — the overlay's
 * `useEffect` work is skipped and its store reads fall back to their initial
 * state, both of which are irrelevant to line structure.
 */

function baseEntry(patch: Partial<SubtitleEntry>): SubtitleEntry {
  return { ...sampleEntries[0], ...patch } as SubtitleEntry
}

function html(entry: SubtitleEntry): string {
  return renderToStaticMarkup(
    React.createElement(SubtitleOverlay, {
      entry,
      videoWidthPx: 1920,
      containerWidthPx: 400,
    }),
  )
}

/**
 * Lines the browser would lay out: `<br>` elements plus the newlines the
 * `white-space: pre` text path emits.  One of the two mechanisms is used
 * depending on the render path; counting both makes the assertion
 * path-agnostic, which is the point.
 */
function renderedLineCount(entry: SubtitleEntry): number {
  const markup = html(entry)
  const brs = (markup.match(/<br\s*\/?>/g) ?? []).length
  const newlines = (markup.match(/\n/g) ?? []).length
  return brs + newlines + 1
}

function expectedLineCount(text: string): number {
  return (text.match(/\\N/g) ?? []).length + 1
}

const TEXTS = [
  'ひとつの行だけ',
  'いちぎょうめ\\Nにぎょうめ',
  'いち\\Nに\\Nさん',
  'aaaa\\Nbbbb\\Ncccc\\Ndddd',
]

describe('REQ-0308 §1 — the overlay renders exactly the cue text’s line structure', () => {
  it('plain path (no karaoke, no emphasis)', () => {
    for (const text of TEXTS) {
      const entry = baseEntry({ text, karaokeEnabled: false, keywordEmphasisEnabled: false })
      expect(renderedLineCount(entry)).toBe(expectedLineCount(text))
    }
  })

  it('emphasis path (emphasis ON, karaoke OFF) — the owner’s reported setup', () => {
    for (const text of TEXTS) {
      // Emphasise the first two characters of the cue so the emphasis render
      // path is genuinely taken (it needs at least one surviving span).
      const entry = baseEntry({
        text,
        karaokeEnabled: false,
        keywordEmphasisEnabled: true,
        emphasisSpans: [{ start: 0, end: 2, text: text.slice(0, 2) }],
      })
      expect(html(entry)).toContain('font-size:1.3em') // emphasis path really ran
      expect(renderedLineCount(entry)).toBe(expectedLineCount(text))
    }
  })

  it('karaoke path with a mid-word `\\N` — the actual regression', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 1, text: 'あいうえおかきくけこ' },
      { startSec: 1, endSec: 2, text: 'さしすせそたちつてと' },
    ]
    const text = 'あいうえお\\Nかきくけこさしすせそたちつてと'
    const entry = baseEntry({
      text,
      startSec: 0,
      endSec: 2,
      words,
      karaokeEnabled: true,
      keywordEmphasisEnabled: false,
    })
    expect(html(entry)).toContain('data-karaoke-word-idx') // karaoke path really ran
    expect(renderedLineCount(entry)).toBe(expectedLineCount(text))
  })

  it('karaoke + emphasis together, with a mid-word `\\N`', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 1, text: 'あいうえおかきくけこ' },
      { startSec: 1, endSec: 2, text: 'さしすせそたちつてと' },
    ]
    const text = 'あいうえお\\Nかきくけこさしすせそたちつてと'
    const entry = baseEntry({
      text,
      startSec: 0,
      endSec: 2,
      words,
      karaokeEnabled: true,
      keywordEmphasisEnabled: true,
      emphasisSpans: [{ start: 0, end: 3, text: 'あいう' }],
    })
    expect(renderedLineCount(entry)).toBe(expectedLineCount(text))
  })

  it('changing only `text` changes the render (no stale memoisation)', () => {
    const before = baseEntry({ text: 'あいうえおかきくけこ', keywordEmphasisEnabled: true, emphasisSpans: [{ start: 0, end: 2, text: 'あい' }] })
    const after = baseEntry({ text: 'あいうえお\\Nかきくけこ', keywordEmphasisEnabled: true, emphasisSpans: [{ start: 0, end: 2, text: 'あい' }] })
    expect(renderedLineCount(before)).toBe(1)
    expect(renderedLineCount(after)).toBe(2)
    expect(html(before)).not.toBe(html(after))
  })
})
