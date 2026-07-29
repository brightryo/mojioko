import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import type { SubtitleEntry } from '../../src/shared/types'

const BACKSLASH_N = String.fromCharCode(92) + 'N'
const LF = String.fromCharCode(10)

/**
 * REQ-0315 §1 — the coupling that broke the outline ring.
 *
 * The plain render path turns the ASS `\N` sentinel into a REAL NEWLINE inside a
 * SINGLE text node and lets `white-space: pre` break it.  `outline-ring.ts`'s
 * `measureRuns` therefore cannot assume "one text node == one line": a `Range`
 * over such a node spans several line boxes and `getBoundingClientRect()`
 * returns their UNION.  Using that union put the ring at the widest line's left
 * and at a baseline computed from both lines' height, so a two-line cue was
 * drawn offset down-and-left and looked doubled.
 *
 * These assertions pin the precondition rather than the pixels (which need a
 * real browser — measured separately in RES-0315 §1).  If the render path ever
 * switches to `<br>` elements, this test fails and is the prompt to re-check
 * `measureRuns`, whose newline splitting would then be dead code.
 */
function markup(text: string, extra: Record<string, unknown> = {}): string {
  const entry = {
    ...sampleEntries[0],
    text,
    fontSizePx: 100,
    outlineThicknessPx: 8,
    karaokeEnabled: false,
    keywordEmphasisEnabled: false,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    ...extra,
  } as unknown as SubtitleEntry
  return renderToStaticMarkup(
    React.createElement(SubtitleOverlay, { entry, videoWidthPx: 1920, containerWidthPx: 641 }),
  )
}

/** Everything inside the text wrapper — the region `measureRuns` walks. */
function wrapperBody(html: string): string {
  const i = html.indexOf('data-subtitle-text-wrapper')
  const open = html.indexOf('>', i) + 1
  return html.slice(open, html.lastIndexOf('</span></span>'))
}

describe('REQ-0315 §1 — the plain path encodes line breaks as newlines, not <br>', () => {
  it('renders a two-line cue as ONE text node containing a real newline', () => {
    const html = markup('いちぎょうめ' + BACKSLASH_N + 'にぎょうめ')
    expect(html).toContain(LF)
    // No <br> — so the ring cannot rely on separate text nodes per line.
    const wrapper = html.slice(html.indexOf('data-subtitle-text-wrapper'))
    expect(wrapper).not.toContain('<br')
    // And the sentinel itself must not survive into the rendered text.
    expect(html).not.toContain(BACKSLASH_N)
  })

  it('a single-line cue contains no newline, so it takes the one-segment path', () => {
    const html = markup('いちぎょうだけ')
    const wrapper = html.slice(html.indexOf('data-subtitle-text-wrapper'))
    expect(wrapper.slice(0, wrapper.indexOf('</span>'))).not.toContain(LF)
  })

  it('three lines produce two newlines', () => {
    const html = markup(['A', 'B', 'C'].join(BACKSLASH_N))
    const wrapper = html.slice(html.indexOf('data-subtitle-text-wrapper'))
    const body = wrapper.slice(0, wrapper.indexOf('</span>'))
    expect(body.split(LF).length - 1).toBe(2)
  })
})

/**
 * REQ-0316 §1-3 — the THREE render paths do not agree on how they encode a line
 * break, and `measureRuns` has to cope with both encodings.  REQ-0313's
 * verification harness hand-built its multi-line fixture with `<br>`, which
 * matches the emphasis and karaoke paths but NOT the plain one — so the union
 * rect bug (RES-0315 §1) went unseen precisely because the harness disagreed
 * with production in the dimension under test.
 *
 * Pinning all three here means a future change to any path shows up as a test
 * failure rather than as a silently mis-measured ring.
 */
describe('REQ-0316 §1-3 — line-break encoding per render path', () => {
  const TWO_LINES = 'いちぎょうめ' + BACKSLASH_N + 'にぎょうめ'

  it('PLAIN path: a real newline inside ONE text node, no <br>', () => {
    const body = wrapperBody(markup(TWO_LINES))
    expect(body).toContain(LF)
    expect(body).not.toContain('<br')
  })

  it('EMPHASIS path: <br> ELEMENTS, no raw newline', () => {
    const body = wrapperBody(
      markup(TWO_LINES, {
        keywordEmphasisEnabled: true,
        emphasisColorHex: '#FFD400',
        emphasisScalePercent: 130,
        emphasisSpans: [{ start: 0, end: 3, text: 'いちぎ' }],
      }),
    )
    expect(body).toContain('<br')
    expect(body).not.toContain(LF)
  })

  it('KARAOKE path: <br> ELEMENTS, no raw newline', () => {
    const body = wrapperBody(
      markup(TWO_LINES, {
        karaokeEnabled: true,
        startSec: 0,
        endSec: 2,
        words: [
          { startSec: 0, endSec: 1, text: 'いちぎょうめ' },
          { startSec: 1, endSec: 2, text: 'にぎょうめ' },
        ],
      }),
    )
    expect(body).toContain('<br')
    expect(body).not.toContain(LF)
  })

  it('so measureRuns must handle BOTH encodings — this is the contract', () => {
    const plain = wrapperBody(markup(TWO_LINES))
    const emph = wrapperBody(
      markup(TWO_LINES, {
        keywordEmphasisEnabled: true,
        emphasisColorHex: '#FFD400',
        emphasisScalePercent: 130,
        emphasisSpans: [{ start: 0, end: 3, text: 'いちぎ' }],
      }),
    )
    // The two paths genuinely differ; if this ever stops being true, the
    // newline-splitting in outline-ring.ts may have become dead code.
    expect(plain.includes(LF)).toBe(true)
    expect(emph.includes('<br')).toBe(true)
    expect(plain.includes('<br')).toBe(false)
  })
})
