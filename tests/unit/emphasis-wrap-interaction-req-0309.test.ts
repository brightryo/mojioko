import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import {
  resolveEmphasisSpans,
  resolveEmphasisRanges,
  tokenizeEmphasis,
  buildEmphasisBody,
  emphasizedWordRanges,
  mapRangesAcrossBreakCollapse,
  clampEmphasisScalePercent,
} from '../../src/shared/emphasis'
import {
  splitWordsAtHardBreaks,
  buildKaraokeAssText,
  computeKaraokeBreaks,
} from '../../src/shared/karaoke-ass'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'
import { computeOverflowSync } from '../../src/renderer/lib/overflow-calculator'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import type { SubtitleEntry, WordSpan } from '../../src/shared/types'

/**
 * REQ-0309 — the emphasis × auto-line-break feedback loop.
 *
 * Measured cause (REQ-0309 §2, confirmed): the wrap measured the cue WITH the
 * emphasis enlargement, chose a break that landed inside the emphasised run,
 * and that break then destroyed the anchor. With the emphasis gone the cue
 * measured NARROWER than when the break was chosen, so one more character now
 * fitted on the line and a second press produced a DIFFERENT wrap. The user was
 * left re-emphasising text around the break by hand.
 *
 * Two independent fixes, both pinned here:
 *   (A) anchors are matched with `\N` ignored, so a break inside an emphasised
 *       run no longer clears it — this breaks the loop at its root;
 *   (B) the wrap prefers to move a whole emphasised run to the next line rather
 *       than split it, falling back to splitting when the run exceeds one line.
 */

type Cue = {
  text: string
  emphasisSpans?: unknown[]
  keywordEmphasisEnabled?: boolean
  emphasisScalePercent?: number
}

/** Exactly what `wrapRow` in entry-row-actions.ts does, for one press. */
function wrapOnce(c: Cue, mode: 'pack' | 'overflow', fs = 50, outline = 3, vw = 1920): string {
  const input = mode === 'pack' ? c.text.replace(/\\N/g, '') : c.text
  const emphasis = c.keywordEmphasisEnabled === true
    ? {
        ranges: mode === 'pack'
          ? mapRangesAcrossBreakCollapse(c.text, resolveEmphasisRanges(c as never), 0)
          : resolveEmphasisRanges(c as never),
        scale: clampEmphasisScalePercent(c.emphasisScalePercent) / 100,
      }
    : undefined
  return applyAutoLineBreak(input, fs, outline, vw, undefined, undefined, emphasis)
}

/** Press the wrap button `n` times, threading the result back like the store does. */
function wrapRepeatedly(c: Cue, mode: 'pack' | 'overflow', n: number): string[] {
  const out: string[] = []
  let cur = c
  for (let i = 0; i < n; i++) {
    const next = wrapOnce(cur, mode)
    out.push(next)
    cur = { ...cur, text: next }
  }
  return out
}

// ---------------------------------------------------------------------------
// (A) — a break inside an emphasised run no longer clears it
// ---------------------------------------------------------------------------

describe('REQ-0309 §3(A) — emphasis survives a `\\N` inside its own range', () => {
  it('keeps the span and widens the range across the break', () => {
    const before = '今日はとても良い天気'
    const after = '今日はとて\\Nも良い天気'
    const start = before.indexOf('とても')
    const r = resolveEmphasisSpans(after, [{ start, end: start + 3, text: 'とても' }])
    expect(r.ranges).toEqual([[3, 8]])
    expect(after.slice(3, 8)).toBe('とて\\Nも')
    // The persisted span keeps a backslash-free anchor.
    expect(r.spans).toEqual([{ start: 3, end: 8, text: 'とても' }])
    expect(r.spans[0].text).not.toContain('\\')
  })

  it('still re-anchors across a break when the offsets also shifted', () => {
    // Text edited BEFORE the run *and* wrapped inside it — rule 2 on the
    // `\N`-free projection has to handle both at once.
    const r = resolveEmphasisSpans('そして今日はとて\\Nも良い天気', [
      { start: 3, end: 6, text: 'とても' },
    ])
    expect(r.ranges.length).toBe(1)
    const [s, e] = r.ranges[0]
    expect('そして今日はとて\\Nも良い天気'.slice(s, e)).toBe('とて\\Nも')
  })

  it('handles two breaks inside one run', () => {
    const after = 'あと\\Nて\\Nもい'
    const r = resolveEmphasisSpans(after, [{ start: 1, end: 4, text: 'とても' }])
    expect(r.ranges.length).toBe(1)
    const [s, e] = r.ranges[0]
    expect(after.slice(s, e)).toBe('と\\Nて\\Nも')
  })

  it('does NOT swallow a `\\N` that merely follows the run', () => {
    // Range must stop at the last emphasised character, not run past it.
    const r = resolveEmphasisSpans('ab\\Ncd', [{ start: 0, end: 2, text: 'ab' }])
    expect(r.ranges).toEqual([[0, 2]])
  })

  it('still DROPS a genuinely absent or ambiguous anchor (rule 3 intact)', () => {
    // Absent even ignoring breaks.
    expect(resolveEmphasisSpans('今日は良い天気', [{ start: 3, end: 6, text: 'とても' }]).ranges).toEqual([])
    // Ambiguous: the span was made at offset 3 of '今日はとても良い天気'; the edit
    // both shifted it AND duplicated the anchor, so neither rule 1 nor rule 1′
    // holds and rule 2 finds two candidates.
    expect(
      resolveEmphasisSpans('とても寒いが今日はとても良い天気', [{ start: 3, end: 6, text: 'とても' }]).ranges.length,
    ).toBe(0)
  })

  it('rule 1 still wins over an ambiguous re-anchor (REQ-0307 disambiguation)', () => {
    // Offsets that DO still hold pick the user's occurrence even though the
    // anchor now appears twice — the `\N` tolerance must not weaken this.
    const text = 'とても寒いが今日はとても良い天気'
    expect(resolveEmphasisSpans(text, [{ start: 9, end: 12, text: 'とても' }]).ranges).toEqual([[9, 12]])
  })
})

describe('REQ-0309 §3(A) — a cross-break run renders on BOTH lines', () => {
  const text = 'あいうとて\\Nもえお'
  const spans = [{ start: 3, end: 8, text: 'とても' }]
  const ranges = resolveEmphasisRanges({ text, emphasisSpans: spans } as never)

  it('tokenises into emphasised / break / emphasised', () => {
    expect(ranges).toEqual([[3, 8]])
    expect(tokenizeEmphasis(text, ranges)).toEqual([
      { kind: 'text', text: 'あいう', emphasized: false },
      { kind: 'text', text: 'とて', emphasized: true },
      { kind: 'break' },
      { kind: 'text', text: 'も', emphasized: true },
      { kind: 'text', text: 'えお', emphasized: false },
    ])
  })

  it('burn-in wraps BOTH sides of the break, with well-formed overrides', () => {
    const body = buildEmphasisBody(text, ranges, (s) => s, 'OPEN', 'CLOSE')
    expect(body).toBe('あいう{OPEN}とて{CLOSE}\\N{OPEN}も{CLOSE}えお')
    expectWellFormedOverrides(body)
  })

  it('preview paints BOTH sides of the break', () => {
    const entry = {
      ...sampleEntries[0],
      text,
      karaokeEnabled: false,
      keywordEmphasisEnabled: true,
      emphasisSpans: spans,
    } as SubtitleEntry
    const html = renderToStaticMarkup(
      React.createElement(SubtitleOverlay, { entry, videoWidthPx: 1920, containerWidthPx: 400 }),
    )
    // One emphasised span before the <br> and one after it.
    const [head, tail] = html.split('<br/>')
    expect(head).toContain('font-size:1.3em')
    expect(tail).toContain('font-size:1.3em')
    expect(head).toContain('とて')
    expect(tail).toContain('も')
  })

  it('karaoke ON: the run is emphasised on both lines and `\\k` timing survives', () => {
    const words: WordSpan[] = [
      { startSec: 0, endSec: 1, text: 'あいうとて' },
      { startSec: 1, endSec: 2, text: 'もえお' },
    ]
    // REQ-0308's splitter runs first; the two must compose.
    const split = splitWordsAtHardBreaks(text, words)
    expect(computeKaraokeBreaks(text, split).size).toBe(1)
    const wr = emphasizedWordRanges(text, split, ranges)
    // Word 0's last two chars and word 1's first char.
    expect([...wr.entries()]).toEqual([[0, [[3, 5]]], [1, [[0, 1]]]])
    const body = buildKaraokeAssText(split, 0, 2, (s) => s, text, {
      ranges: wr,
      openTag: 'OPEN',
      closeTag: 'CLOSE',
    })
    expect(body).toBe('{\\k100}あいう{OPEN}とて{CLOSE}\\N{\\k100OPEN}も{CLOSE}えお')
    expectWellFormedOverrides(body)
    // Visible text still reconstructs the cue.
    expect(body.replace(/\{[^}]*\}/g, '')).toBe(text)
  })
})

describe('REQ-0309 §3(A) — a cross-break range is measured on both lines', () => {
  it('the overflow badge scales the emphasised glyphs on either side of the break', () => {
    // Line 2 holds 30 wide glyphs — comfortably inside 280px at base size, but
    // over it once the range that starts on line 1 keeps scaling into line 2.
    const text = 'あ'.repeat(4) + '\\N' + 'い'.repeat(30)
    const spans = [{ start: 2, end: 4 + 2 + 30, text: 'ああ' + 'い'.repeat(30) }]
    const ranges = resolveEmphasisRanges({ text, emphasisSpans: spans } as never)
    expect(ranges.length).toBe(1)
    const measure = (scale?: number) =>
      computeOverflowSync({
        text,
        fontFamily: 'MOJIOKO Noto Sans JP',
        fontSizePx: 50,
        outlineThicknessPx: 0,
        videoWidthPx: 1200,
        emphasisRanges: scale === undefined ? undefined : ranges,
        emphasisScale: scale,
      }).overflowStartIndex
    expect(measure(undefined)).toBe(-1) // fits at base size
    expect(measure(2)).toBeGreaterThan(4) // overflow lands on line 2, past the newline
  })
})

// ---------------------------------------------------------------------------
// (B) — the wrap avoids splitting an emphasised run
// ---------------------------------------------------------------------------

describe('REQ-0309 §3(B) — the wrap moves a whole emphasised run to the next line', () => {
  const WORD = 'プレイ'

  /** Cue whose emphasised WORD sits at `pos`, long enough to need one break. */
  function cueAt(pos: number): Cue {
    const text = 'あ'.repeat(pos) + WORD + 'い'.repeat(12)
    return {
      text,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 130,
      emphasisSpans: [{ start: pos, end: pos + WORD.length, text: WORD }],
    }
  }

  it('never breaks inside the run, across the whole window where it used to', () => {
    // pos 51-53 is precisely the window that broke pre-REQ-0309 (measured).
    for (let pos = 45; pos <= 58; pos++) {
      const c = cueAt(pos)
      const wrapped = wrapOnce(c, 'pack')
      const breakAt = wrapped.indexOf('\\N')
      expect(breakAt, `pos=${pos} should still wrap`).toBeGreaterThan(-1)
      const insideRun = breakAt > pos && breakAt < pos + WORD.length
      expect(insideRun, `pos=${pos} broke inside the emphasised run`).toBe(false)
      // And the emphasis is still there afterwards.
      expect(
        resolveEmphasisRanges({ ...c, text: wrapped } as never).length,
        `pos=${pos} lost its emphasis`,
      ).toBeGreaterThan(0)
    }
  })

  it('falls back to splitting when the run is wider than one line', () => {
    // 80 emphasised wide glyphs cannot fit one line at any break position.
    const long = 'プ'.repeat(80)
    const c: Cue = {
      text: long,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 130,
      emphasisSpans: [{ start: 0, end: 80, text: long }],
    }
    const wrapped = wrapOnce(c, 'pack')
    // It MUST break (never leave the line overflowing) …
    expect(wrapped).toContain('\\N')
    // … and (A) means the emphasis survives that forced split.
    const ranges = resolveEmphasisRanges({ ...c, text: wrapped } as never)
    expect(ranges.length).toBe(1)
    expect(wrapped.slice(ranges[0][0], ranges[0][1])).toBe(wrapped)
  })

  it('protects a Latin emphasised word without splitting the word either', () => {
    const text = 'aaaa bbbb PLAY cccc dddd eeee ffff gggg'
    const pos = text.indexOf('PLAY')
    const c: Cue = {
      text,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 200,
      emphasisSpans: [{ start: pos, end: pos + 4, text: 'PLAY' }],
    }
    const wrapped = wrapOnce(c, 'pack', 50, 0, 300)
    // No line may contain a partial 'PLAY'.
    for (const line of wrapped.split('\\N')) {
      const hasPartial = /P$|PL$|PLA$|^LAY|^AY|^Y[^A-Z]/.test(line.trim())
      expect(hasPartial, `partial PLAY in ${JSON.stringify(line)}`).toBe(false)
    }
    expect(resolveEmphasisRanges({ ...c, text: wrapped } as never).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// §4 — idempotency
// ---------------------------------------------------------------------------

describe('REQ-0309 §4 — pressing auto line-break twice gives the same result', () => {
  const JA = 'あ'.repeat(51) + 'プレイ' + 'い'.repeat(12)
  const EN = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet'
  const MIXED = 'あいう PLAY えお KEY かきく ' + 'さ'.repeat(40)

  const cases: Array<[string, Cue]> = [
    ['JA, no emphasis', { text: JA }],
    ['JA, emphasis at the old break window', {
      text: JA,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 130,
      emphasisSpans: [{ start: 51, end: 54, text: 'プレイ' }],
    }],
    ['JA, shrunk emphasis (50 %)', {
      text: JA,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 50,
      emphasisSpans: [{ start: 51, end: 54, text: 'プレイ' }],
    }],
    ['EN, no emphasis', { text: EN }],
    ['EN, emphasis', {
      text: EN,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 200,
      emphasisSpans: [{ start: EN.indexOf('charlie'), end: EN.indexOf('charlie') + 7, text: 'charlie' }],
    }],
    ['mixed JA/EN, emphasis', {
      text: MIXED,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 160,
      emphasisSpans: [{ start: MIXED.indexOf('PLAY'), end: MIXED.indexOf('PLAY') + 4, text: 'PLAY' }],
    }],
  ]

  for (const mode of ['pack', 'overflow'] as const) {
    for (const [label, cue] of cases) {
      it(`${mode}: ${label} converges on the first press`, () => {
        const [p1, p2, p3] = wrapRepeatedly(cue, mode, 3)
        expect(p2, 'second press changed the result').toBe(p1)
        expect(p3, 'third press changed the result').toBe(p1)
      })
    }
  }

  it('no line is left with room to spare for the next line’s first character', () => {
    // The owner's symptom #2: after one press, line 1 could still have taken one
    // more character.  That can only happen if the width used to CHOOSE the break
    // differed from the width the cue actually has afterwards — i.e. the loop.
    const cue: Cue = {
      text: JA,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 130,
      emphasisSpans: [{ start: 51, end: 54, text: 'プレイ' }],
    }
    const wrapped = wrapOnce(cue, 'pack')
    // Re-measuring the settled text must reproduce exactly the same breaks.
    expect(wrapOnce({ ...cue, text: wrapped }, 'overflow')).toBe(wrapped)
  })
})

// ---------------------------------------------------------------------------
// Invariant: cues without emphasis are untouched (REQ-0303)
// ---------------------------------------------------------------------------

describe('REQ-0309 — cues without emphasis wrap exactly as before', () => {
  it('the REQ-0303 Japanese fixture is byte-identical', () => {
    const text = 'あ'.repeat(60)
    expect(applyAutoLineBreak(text, 50, 3, 1920)).toBe('あ'.repeat(54) + '\\N' + 'あ'.repeat(6))
  })

  it('an emphasis descriptor with no surviving range changes nothing', () => {
    const text = 'あ'.repeat(60)
    const plain = applyAutoLineBreak(text, 50, 3, 1920)
    expect(applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, { ranges: [], scale: 1.5 })).toBe(plain)
    expect(applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, { ranges: [[0, 60]], scale: 1 })).toBe(plain)
  })

  it('English word boundaries are still respected without emphasis', () => {
    const text = 'aaaa bbbb cccc dddd eeee'
    const wrapped = applyAutoLineBreak(text, 50, 0, 300)
    expect(wrapped.split(/\\N|\s+/).filter(Boolean)).toEqual(['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee'])
  })
})

/**
 * Every ASS override tag must sit inside its own `{}` block (REQ-0291): libass
 * renders a bare `\tag` as literal text.  Strip the brace blocks and assert the
 * only backslash left is the `\N` line-break sentinel.
 */
function expectWellFormedOverrides(body: string): void {
  expect((body.match(/\{/g) ?? []).length).toBe((body.match(/\}/g) ?? []).length)
  expect(body).not.toContain('{{')
  expect(body).not.toContain('}}')
  const outsideBraces = body.replace(/\{[^}]*\}/g, '')
  expect(outsideBraces.replace(/\\N/g, '')).not.toContain('\\')
}
