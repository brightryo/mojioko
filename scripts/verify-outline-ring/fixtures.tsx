/**
 * REQ-0317 §1 — fixtures for the outline-ring verification harness.
 *
 * These are rendered from the REAL `subtitle-overlay.tsx`.  Hand-writing the
 * HTML is what made REQ-0313's harness useless: it built multi-line fixtures as
 * `Hello<br>World`, which splits text nodes, while the plain production path
 * uses a real newline inside ONE text node.  The union-rect bug (REQ-0315 §1)
 * was therefore invisible to the very harness meant to catch it.
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SubtitleOverlay } from '../../src/renderer/components/subtitle-overlay/subtitle-overlay'
import { sampleEntries } from '../../src/renderer/lib/fixtures'
import type { SubtitleEntry } from '../../src/shared/types'

/** The ASS hard-break sentinel, built without a literal escape. */
const N = String.fromCharCode(92) + 'N'
const TWO = 'これはテストの字幕です' + N + 'もう一行あります'
const ONE = 'これはテストの字幕です'

const EMPHASIS = {
  keywordEmphasisEnabled: true,
  emphasisColorHex: '#FFD400',
  emphasisScalePercent: 130,
  emphasisSpans: [{ start: 0, end: 4, text: 'これはテ' }],
}
const KARAOKE = {
  karaokeEnabled: true,
  karaokeHighlightColor: '#B4FF39',
  words: [
    { startSec: 0, endSec: 1, text: 'これはテストの字幕です' },
    { startSec: 1, endSec: 2, text: 'もう一行あります' },
  ],
}

export interface Case {
  name: string
  html: string
}

function render(name: string, extra: Record<string, unknown>, text: string): Case {
  const entry = {
    ...sampleEntries[0],
    text,
    fontSizePx: 100,
    outlineThicknessPx: 8,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    textAlpha: 100,
    outlineAlpha: 100,
    shadowDepth: 0,
    rotation: 0,
    casing: 'none',
    karaokeEnabled: false,
    keywordEmphasisEnabled: false,
    horizontalPosition: 'center',
    startSec: 0,
    endSec: 2,
    subtitleBackground: { enabled: false, color: 'black', opacityPercent: 50 },
    ...extra,
  } as unknown as SubtitleEntry
  return {
    name,
    html: renderToStaticMarkup(
      React.createElement(SubtitleOverlay, {
        entry,
        videoWidthPx: 1920,
        // 1920 shown at 641 — the owner's ~1/3 preview scale (REQ-0315 §1).
        containerWidthPx: 641,
      }),
    ),
  }
}

export function buildCases(): Case[] {
  return [
    render('plain', {}, ONE),
    render('multiline', {}, TWO),
    render('emphasis', EMPHASIS, ONE),
    render('multiline+emphasis', EMPHASIS, TWO),
    render('uppercase', { casing: 'uppercase' }, 'hello world' + N + 'second line'),
    render('rotated', { rotation: 12 }, ONE),
    render('rotated+multiline', { rotation: -8 }, TWO),
    render('shadow', { shadowDepth: 14, shadowColor: '#000000', shadowAlpha: 100 }, ONE),
    render('cjk', {}, 'こんにちは' + N + '世界'),
    render('karaoke', KARAOKE, ONE),
    render('multiline+karaoke', KARAOKE, TWO),
    render('multiline+emphasis+karaoke', { ...EMPHASIS, ...KARAOKE }, TWO),
    render('multiline+alpha0', { textAlpha: 0 }, TWO),
    render('multiline+alpha0+outline20', { textAlpha: 0, outlineThicknessPx: 20 }, TWO),
  ]
}
