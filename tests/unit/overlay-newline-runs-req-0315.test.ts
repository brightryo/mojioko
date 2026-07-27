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
function markup(text: string): string {
  const entry = {
    ...sampleEntries[0],
    text,
    fontSizePx: 100,
    outlineThicknessPx: 8,
    karaokeEnabled: false,
    keywordEmphasisEnabled: false,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
  } as unknown as SubtitleEntry
  return renderToStaticMarkup(
    React.createElement(SubtitleOverlay, { entry, videoWidthPx: 1920, containerWidthPx: 641 }),
  )
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
