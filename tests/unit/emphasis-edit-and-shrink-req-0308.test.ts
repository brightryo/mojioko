import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import React from 'react'
import { resolveEmphasisSpans, clampEmphasisScalePercent } from '../../src/shared/emphasis'
import { applyAutoLineBreak } from '../../src/renderer/lib/auto-line-break'
import { computeOverflowSync } from '../../src/renderer/lib/overflow-calculator'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import { generateAss } from '../../src/main/services/ass-generator'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'

const VIDEO: VideoInfo = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 10, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 0,
}
const BURNIN: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'bottom', verticalMarginPx: 40,
}

/**
 * REQ-0308 §2 — these cases ARE the specification of the warning shown in the
 * emphasis picker dialog (`step2:emphasisPicker.editNote`).  The owner reported
 * "editing the text clears the emphasis" while RES-0307 claimed it survives;
 * the truth is conditional, and the note promises exactly the conditions
 * asserted here.  **If one of these expectations ever changes, the note's
 * wording must change with it** — otherwise the UI lies to the user.
 */
describe('REQ-0308 §2 — what a text edit does to an emphasis span', () => {
  const CUE = '今日はとても良い天気'
  const ANCHOR = 'とても'

  /** Resolve the span for `ANCHOR` (taken from CUE) against an edited text. */
  function survives(edited: string, anchor = ANCHOR, from = CUE): boolean {
    const start = from.indexOf(anchor)
    return resolveEmphasisSpans(edited, [{ start, end: start + anchor.length, text: anchor }]).ranges.length > 0
  }

  it('SURVIVES when the edit is after the emphasised text', () => {
    expect(survives('今日はとても良い天候です')).toBe(true)
  })

  it('SURVIVES when the edit is before it and the text is still unique', () => {
    // Offsets shifted, so this is the re-anchor rule doing the work.
    expect(survives('そして今日はとても良い天気')).toBe(true)
  })

  it('SURVIVES when auto-line-break inserts a `\\N` before it', () => {
    expect(survives('今日は\\Nとても良い天気')).toBe(true)
  })

  it('DROPS when the emphasised text is deleted', () => {
    expect(survives('今日は良い天気')).toBe(false)
  })

  it('DROPS when the emphasised text is itself rewritten', () => {
    expect(survives('今日はとっても良い天気')).toBe(false)
  })

  it('DROPS when a `\\N` is inserted inside the emphasised text', () => {
    expect(survives('今日はとて\\Nも良い天気')).toBe(false)
  })

  it('DROPS when the edit makes the emphasised text ambiguous (now appears twice)', () => {
    expect(survives('とても寒いが今日はとても良い天気')).toBe(false)
  })

  it('a repeated string keeps its ONE chosen occurrence while offsets still hold', () => {
    // This is why the span model beats the REQ-0306 keyword model: 'あ' occurs
    // four times but only the clicked one is emphasised.
    const r = resolveEmphasisSpans('ああああ!', [{ start: 2, end: 3, text: 'あ' }])
    expect(r.ranges).toEqual([[2, 3]])
  })

  it('drops only the affected span — siblings are untouched', () => {
    const after = '赤と黄と緑' // 青 replaced by 黄
    const r = resolveEmphasisSpans(after, [
      { start: 0, end: 1, text: '赤' },
      { start: 2, end: 3, text: '青' },
      { start: 4, end: 5, text: '緑' },
    ])
    expect(r.ranges.map(([s, e]) => after.slice(s, e))).toEqual(['赤', '緑'])
  })
})

/**
 * REQ-0308 §4-4 — the emphasis multiplier range became 50–200 %, so a span can
 * now SHRINK.  Every width measurer had a `scale > 1` guard that would have
 * measured a shrunk span at full size; those are now `scale !== 1`.  Measuring
 * too wide is "safe" only in the sense that it never overflows — it wraps
 * earlier than necessary, which the owner would see as spurious line breaks.
 */
describe('REQ-0308 §4-4 — shrink (scale < 1) is reflected in width measurement', () => {
  it('clamp accepts the new 50 floor and still rejects below it', () => {
    expect(clampEmphasisScalePercent(50)).toBe(50)
    expect(clampEmphasisScalePercent(49)).toBe(50)
    expect(clampEmphasisScalePercent(-100)).toBe(50)
    expect(clampEmphasisScalePercent(200)).toBe(200)
  })

  it('auto-line-break: a shrunk span fits a line that overflows at base size', () => {
    // 54 wide glyphs is exactly one line at fs50 / outline 3 / 1920 (see
    // emphasis-wrap.test.ts).  56 overflows — unless enough of it is shrunk.
    const text = 'あ'.repeat(56)
    expect(applyAutoLineBreak(text, 50, 3, 1920)).toContain('\\N')
    const shrunk = applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, {
      ranges: [[0, 56]],
      scale: 0.5,
    })
    expect(shrunk).toBe(text) // all at 50 % → 28 glyph-widths → fits, no break
  })

  it('overflow warning: a shrunk span no longer reports overflow', () => {
    const text = 'あ'.repeat(56)
    const measure = (scale?: number) =>
      computeOverflowSync({
        text,
        fontFamily: 'MOJIOKO Noto Sans JP',
        fontSizePx: 50,
        outlineThicknessPx: 3,
        videoWidthPx: 1920,
        emphasisRanges: scale === undefined ? undefined : [[0, 56]],
        emphasisScale: scale,
      }).overflowStartIndex
    expect(measure(undefined)).not.toBe(-1) // overflows at base size
    expect(measure(0.5)).toBe(-1) // fits once shrunk
  })

  it('scale exactly 1 stays byte-identical to no emphasis at all', () => {
    const text = 'あ'.repeat(60)
    const plain = applyAutoLineBreak(text, 50, 3, 1920)
    expect(
      applyAutoLineBreak(text, 50, 3, 1920, undefined, undefined, { ranges: [[0, 60]], scale: 1 }),
    ).toBe(plain)
  })

  it('preview and burn-in agree on a shrunk span', () => {
    const FONT_SIZE = 60
    const SCALE_PERCENT = 50
    const entry = {
      ...sampleEntries[0],
      text: 'あいうえお',
      fontSizePx: FONT_SIZE,
      karaokeEnabled: false,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: SCALE_PERCENT,
      emphasisSpans: [{ start: 0, end: 2, text: 'あい' }],
    } as SubtitleEntry

    // Burn-in: the emphasised run switches to `\fs30` (= 60 × 50 %) and the
    // close tag restores the cue's own size.
    const ass = generateAss([entry], VIDEO, BURNIN, undefined, undefined, true)
    expect(ass).toContain(`\\fs${(FONT_SIZE * SCALE_PERCENT) / 100}`)
    expect(ass).toContain(`\\fs${FONT_SIZE}`)

    // Preview: the same ratio, expressed relative to the cue font size.
    const markup = renderToStaticMarkup(
      React.createElement(SubtitleOverlay, {
        entry,
        videoWidthPx: 1920,
        containerWidthPx: 400,
      }),
    )
    expect(markup).toContain(`font-size:${SCALE_PERCENT / 100}em`)
  })

  it('preview renders a shrunk span below 1em (no floor clamp)', () => {
    const entry = {
      ...sampleEntries[0],
      text: 'あいうえお',
      karaokeEnabled: false,
      keywordEmphasisEnabled: true,
      emphasisScalePercent: 50,
      emphasisSpans: [{ start: 0, end: 2, text: 'あい' }],
    } as SubtitleEntry
    const markup = renderToStaticMarkup(
      React.createElement(SubtitleOverlay, {
        entry,
        videoWidthPx: 1920,
        containerWidthPx: 400,
      }),
    )
    // 50 % → 0.5em.  A `Math.max(1, …)` floor anywhere would emit 1em instead.
    expect(markup).toContain('font-size:0.5em')
  })
})
