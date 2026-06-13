import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import type { SubtitleEntry, VideoInfo, BurninPosition } from '../../src/shared/types'
import { makeEntryLayoutDefaults } from '../../src/shared/burnin-defaults'

/**
 * REQ-20260613-016 Phase 2 — verify the per-row ASS generation contract.
 *
 * v1.2.2 retires the v1.1 "single Style + global burnin" model.  Each entry
 * now carries its own alignment / MarginV / background, and the generator:
 *   1. emits TWO Style: rows (Default + WithBox)
 *   2. picks per-Dialogue Style by `entry.subtitleBackground.enabled`
 *   3. puts `entry.verticalMarginPx` in the Dialogue MarginV column
 *   4. emits inline `\an<N>` from horizontal × vertical
 *   5. emits inline `\4c`/`\4a` ONLY for WithBox rows
 *   6. preserves the existing per-row `\fs`/`\c`/`\3c`/`\bord`/`\fad`
 *
 * These tests pin each of those points.  Phase 4-5 will add UI; until then
 * unit tests are the only verification of per-row correctness because
 * exporting an actual ASS at runtime in Phase 2 produces a uniform output
 * (all rows seeded with the same defaults).
 */

const VIDEO: VideoInfo = {
  path: '/test/video.mp4',
  hasVideoStream: true,
  widthPx: 1920,
  heightPx: 1080,
  durationSec: 60,
  fps: 30,
  container: 'mp4',
  videoCodec: 'h264',
  audioTracks: [],
  fileSizeBytes: 0,
}

// vestigial — generator no longer reads these, but the signature kept them
// for ABI continuity (see ass-generator.ts JSDoc).
const VESTIGIAL_BURNIN: BurninPosition = {
  horizontalPosition: 'center',
  verticalPosition: 'bottom',
  verticalMarginPx: 40,
}

function makeEntry(
  id: string,
  startSec: number,
  endSec: number,
  text: string,
  overrides?: Partial<SubtitleEntry>,
): SubtitleEntry {
  const layoutDefaults = makeEntryLayoutDefaults()
  const base = {
    startSec,
    endSec,
    text,
    fontSizePx: 100,
    textColorHex: '#FFFFFF',
    outlineColorHex: '#000000',
    outlineThicknessPx: 3,
    fadeEnabled: false,
    ...layoutDefaults,
  }
  return {
    id,
    ...base,
    isDeleted: false,
    isEdited: false,
    original: { ...base, subtitleBackground: { ...base.subtitleBackground } },
    ...overrides,
  }
}

describe('generateAss — Style header (REQ-20260613-016 Phase 2)', () => {
  it('emits BOTH Default and WithBox Style rows', () => {
    const ass = generateAss([], VIDEO, VESTIGIAL_BURNIN, 0.2)
    const styleLines = ass.split('\n').filter((l) => l.startsWith('Style:'))
    expect(styleLines).toHaveLength(2)
    // Default is BorderStyle=1 (outline+shadow); WithBox is BorderStyle=3 (opaque box).
    expect(styleLines[0]).toContain('Style: Default,')
    expect(styleLines[0]).toMatch(/,1,3,/)
    expect(styleLines[1]).toContain('Style: WithBox,')
    expect(styleLines[1]).toMatch(/,3,3,/)
  })

  it('Style header carries assFontName for both styles', () => {
    const ass = generateAss([], VIDEO, VESTIGIAL_BURNIN, 0.2, undefined, 'Custom Font Name')
    expect(ass).toMatch(/Style: Default,Custom Font Name,/)
    expect(ass).toMatch(/Style: WithBox,Custom Font Name,/)
  })
})

describe('generateAss — per-row alignment (\\an)', () => {
  const alignmentCases: Array<{
    h: 'left' | 'center' | 'right'
    v: 'top' | 'bottom'
    expected: number
  }> = [
    { h: 'left', v: 'top', expected: 7 },
    { h: 'center', v: 'top', expected: 8 },
    { h: 'right', v: 'top', expected: 9 },
    { h: 'left', v: 'bottom', expected: 1 },
    { h: 'center', v: 'bottom', expected: 2 },
    { h: 'right', v: 'bottom', expected: 3 },
  ]

  for (const { h, v, expected } of alignmentCases) {
    it(`horizontal=${h}, vertical=${v} → \\an${expected}`, () => {
      const ass = generateAss(
        [makeEntry('e1', 0, 1, 'hi', { horizontalPosition: h, verticalPosition: v })],
        VIDEO,
        VESTIGIAL_BURNIN,
        0.2,
      )
      const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
      expect(dialogue).toContain(`\\an${expected}`)
    })
  }
})

describe('generateAss — per-row MarginV', () => {
  it('uses entry.verticalMarginPx in the Dialogue MarginV column', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'a', { verticalMarginPx: 40 }),
        makeEntry('e2', 1, 2, 'b', { verticalMarginPx: 120 }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    // Dialogue format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
    expect(dialogues[0].split(',').slice(0, 8).join(',')).toMatch(/,0,0,40,/)
    expect(dialogues[1].split(',').slice(0, 8).join(',')).toMatch(/,0,0,120,/)
  })
})

describe('generateAss — Style selection (WithBox vs Default)', () => {
  it('background disabled → Style: Default, no \\4c/\\4a tags', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'hi')], // default background.enabled=false
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain(',Default,')
    expect(dialogue).not.toContain('\\4c')
    expect(dialogue).not.toContain('\\4a')
  })

  it('background enabled → Style: WithBox, with \\4c and \\4a tags', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain(',WithBox,')
    expect(dialogue).toContain('\\4c')
    expect(dialogue).toContain('\\4a')
  })

  it('mixed rows pick the correct Style each', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'plain'),
        makeEntry('e2', 1, 2, 'boxed', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 },
        }),
        makeEntry('e3', 2, 3, 'plain again'),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues[0]).toContain(',Default,')
    expect(dialogues[1]).toContain(',WithBox,')
    expect(dialogues[2]).toContain(',Default,')
  })
})

describe('generateAss — \\4c / \\4a color and alpha', () => {
  it('black background → \\4c&H000000&', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 100 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\4c&H000000&')
  })

  it('white background → \\4c&H00FFFFFF&', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'white', opacityPercent: 100 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\4c&H00FFFFFF&')
  })

  it('opacity 100 → alpha 00 (fully opaque)', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 100 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\4a&H00&')
  })

  it('opacity 0 → alpha FF (fully transparent)', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 0 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\4a&HFF&')
  })

  it('opacity 50 → alpha 80 (halfway)', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    // (1 - 0.5) * 255 = 127.5 → rounds to 128 = 0x80
    expect(dialogue).toContain('\\4a&H80&')
  })
})

describe('generateAss — preserved per-row inline tags', () => {
  it('emits \\fs, \\c, \\3c, \\bord matching the entry values', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          fontSizePx: 64,
          textColorHex: '#FF0000',
          outlineColorHex: '#00FF00',
          outlineThicknessPx: 5,
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\fs64')
    // hex → ASS: #FF0000 → red → &H000000FF&
    expect(dialogue).toContain('\\c&H000000FF&')
    // #00FF00 → green → &H0000FF00&
    expect(dialogue).toContain('\\3c&H0000FF00&')
    expect(dialogue).toContain('\\bord5')
  })

  it('emits \\fad(durationMs,durationMs) when fadeEnabled=true', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'hi', { fadeEnabled: true })],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.3, // 300 ms
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\fad(300,300)')
  })

  it('omits \\fad when fadeEnabled=false', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'hi', { fadeEnabled: false })],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).not.toContain('\\fad')
  })

  it('soft-deleted rows are excluded from Dialogue output', () => {
    const ass = generateAss(
      [
        makeEntry('keep', 0, 1, 'keep'),
        makeEntry('drop', 1, 2, 'drop', { isDeleted: true }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
      0.2,
    )
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues).toHaveLength(1)
    expect(dialogues[0]).toContain('keep')
  })
})
