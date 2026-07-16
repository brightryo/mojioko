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
 *   5. emits inline bg-paint tags (`\3c` bg color + `\3a` bg alpha + `\shad0`)
 *      ONLY for WithBox rows — see REQ-0096 for why \3c not \4c
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
    fadeDurationSec: 0,
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
    const ass = generateAss([], VIDEO, VESTIGIAL_BURNIN)
    const styleLines = ass.split('\n').filter((l) => l.startsWith('Style:'))
    expect(styleLines).toHaveLength(2)
    // Default is BorderStyle=1 (outline+shadow); WithBox is BorderStyle=3 (opaque box).
    expect(styleLines[0]).toContain('Style: Default,')
    expect(styleLines[0]).toMatch(/,1,3,/)
    expect(styleLines[1]).toContain('Style: WithBox,')
    expect(styleLines[1]).toMatch(/,3,3,/)
  })

  it('Style header carries assFontName for both styles', () => {
    const ass = generateAss([], VIDEO, VESTIGIAL_BURNIN, undefined, 'Custom Font Name')
    expect(ass).toMatch(/Style: Default,Custom Font Name,/)
    expect(ass).toMatch(/Style: WithBox,Custom Font Name,/)
  })
})

describe('generateAss — per-row alignment (\\an)', () => {
  const alignmentCases: Array<{
    h: 'left' | 'center' | 'right'
    v: 'top' | 'center' | 'bottom'
    expected: number
  }> = [
    { h: 'left', v: 'top', expected: 7 },
    { h: 'center', v: 'top', expected: 8 },
    { h: 'right', v: 'top', expected: 9 },
    // REQ-0140 — center row maps to numpad 4/5/6.
    { h: 'left', v: 'center', expected: 4 },
    { h: 'center', v: 'center', expected: 5 },
    { h: 'right', v: 'center', expected: 6 },
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
    )
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    // Dialogue format: Layer, Start, End, Style, MarginL, MarginR, MarginV, Effect, Text
    expect(dialogues[0].split(',').slice(0, 8).join(',')).toMatch(/,0,0,40,/)
    expect(dialogues[1].split(',').slice(0, 8).join(',')).toMatch(/,0,0,120,/)
  })
})

describe('generateAss — Style selection (WithBox vs Default)', () => {
  it('background disabled → Style: Default, no \\3a/\\shad0 bg-paint tags', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'hi')], // default background.enabled=false
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain(',Default,')
    // BG-off rows must NEVER carry the bg-paint tags introduced for WithBox.
    // (\3c is allowed — that's the row's outline color, asserted elsewhere.)
    expect(dialogue).not.toContain('\\3a')
    expect(dialogue).not.toContain('\\shad0')
    // Defensive: the broken v1.3.1 \4c/\4a path must not regress, either.
    expect(dialogue).not.toContain('\\4c')
    expect(dialogue).not.toContain('\\4a')
  })

  it('background enabled → Style: WithBox, with \\3c/\\3a bg tags and \\shad0', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain(',WithBox,')
    // libass paints BorderStyle=3 box with OutlineColour (\3c), not \4c.
    expect(dialogue).toContain('\\3c')
    expect(dialogue).toContain('\\3a')
    expect(dialogue).toContain('\\shad0')
    // REQ-0096 regression guard — bg color must NOT land in \4c/\4a anymore.
    expect(dialogue).not.toContain('\\4c')
    expect(dialogue).not.toContain('\\4a')
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
    )
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues[0]).toContain(',Default,')
    expect(dialogues[1]).toContain(',WithBox,')
    expect(dialogues[2]).toContain(',Default,')
  })
})

// REQ-0096 — bg paint is written into \3c/\3a (OutlineColour/OutlineAlpha)
// because libass under BorderStyle=3 paints the opaque box from those, not
// from \4c/\4a (which is the drop-shadow).  v1.3.1 had this wrong; these
// tests pin the corrected behavior.
describe('generateAss — \\3c / \\3a bg color and alpha (REQ-0096)', () => {
  it('black background → \\3c&H000000& (last-write-wins over outline \\3c)', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 100 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\3c&H000000&')
    // Tag order: the per-row outline \3c must appear BEFORE the bg \3c so
    // libass's last-write-wins behavior gives the box the bg color.
    const outlineIdx = dialogue.indexOf('\\3c&H00000000&') // default outline
    const bgIdx = dialogue.indexOf('\\3c&H000000&')
    expect(outlineIdx).toBeGreaterThanOrEqual(0)
    expect(bgIdx).toBeGreaterThan(outlineIdx)
  })

  it('white background → \\3c&H00FFFFFF&', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'white', opacityPercent: 100 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\3c&H00FFFFFF&')
  })

  it('opacity 100 → alpha 00 (fully opaque) on \\3a', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 100 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\3a&H00&')
  })

  it('opacity 0 → alpha FF (fully transparent) on \\3a', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 0 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\3a&HFF&')
  })

  it('opacity 50 → alpha 80 (halfway) on \\3a', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    // (1 - 0.5) * 255 = 127.5 → rounds to 128 = 0x80
    expect(dialogue).toContain('\\3a&H80&')
  })

  it('BG-on row emits \\shad0 to suppress any shadow leak', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          subtitleBackground: { enabled: true, color: 'white', opacityPercent: 50 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\shad0')
  })

  it('BG-on row still emits the per-row outline \\3c (it just gets overridden)', () => {
    // We don't strip the outline tag — we rely on libass's last-write-wins.
    // Keeping the outline tag preserves any future code that reads it and
    // makes the override explicit when a human reads the ASS file.
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          outlineColorHex: '#FF00FF', // user-set magenta outline
          subtitleBackground: { enabled: true, color: 'white', opacityPercent: 100 },
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    // outline magenta is present...
    expect(dialogue).toContain('\\3c&H00FF00FF&')
    // ...and the bg white comes AFTER it.
    const outlineIdx = dialogue.indexOf('\\3c&H00FF00FF&')
    const bgIdx = dialogue.indexOf('\\3c&H00FFFFFF&')
    expect(bgIdx).toBeGreaterThan(outlineIdx)
  })

  it('BG-off row keeps \\3c as the user-set outline color (regression guard)', () => {
    const ass = generateAss(
      [
        makeEntry('e1', 0, 1, 'hi', {
          outlineColorHex: '#FF00FF', // magenta outline, BG off
        }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\3c&H00FF00FF&')
    // No bg-paint tags on BG-off rows.
    expect(dialogue).not.toContain('\\3a')
    expect(dialogue).not.toContain('\\shad0')
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
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\fs64')
    // hex → ASS: #FF0000 → red → &H000000FF&
    expect(dialogue).toContain('\\c&H000000FF&')
    // #00FF00 → green → &H0000FF00&
    expect(dialogue).toContain('\\3c&H0000FF00&')
    expect(dialogue).toContain('\\bord5')
  })

  // REQ-20260615-050 — fade is per-entry; the writer reads
  // `entry.fadeDurationSec` directly and emits `\fad` only when > 0.
  it('emits \\fad(durationMs,durationMs) when entry.fadeDurationSec > 0', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'hi', { fadeDurationSec: 0.3 })],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\fad(300,300)')
  })

  it('omits \\fad when entry.fadeDurationSec is 0 (REQ-050 OFF)', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'hi', { fadeDurationSec: 0 })],
      VIDEO,
      VESTIGIAL_BURNIN,
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
    )
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues).toHaveLength(1)
    expect(dialogues[0]).toContain('keep')
  })
})

describe('generateAss — free position \\pos (REQ-20260613-016 Phase 6 / 機能B)', () => {
  it('row with both posX and posY emits \\pos(x,y)', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'pinned', { posX: 100, posY: 200 })],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\pos(100,200)')
  })

  it('row with both posX and posY still emits \\an for anchor selection', () => {
    // \pos uses the alignment to decide which corner of the text box
    // sits at the (x,y) coord — so \an MUST still be emitted.  Without
    // it libass would fall through to the Style: default alignment.
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'pinned', {
        posX: 100,
        posY: 200,
        horizontalPosition: 'right',
        verticalPosition: 'top',
      })],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain('\\an9') // right + top
    expect(dialogue).toContain('\\pos(100,200)')
  })

  it('pinned row writes MarginV=0 in the Dialogue column', () => {
    // libass ignores MarginV when \pos is present, but writing 0 keeps
    // the ASS file unambiguous if a human reads it.
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'pinned', {
        posX: 50,
        posY: 60,
        verticalMarginPx: 999, // would normally land here without \pos
      })],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue.split(',').slice(0, 8).join(',')).toMatch(/,0,0,0,/)
    // Defensive: the 999 must NOT have leaked in.
    expect(dialogue).not.toContain(',999,')
  })

  it('row with only posX (no posY) is NOT pinned — no \\pos emitted', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'half', { posX: 100 })],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).not.toContain('\\pos')
  })

  it('row with only posY (no posX) is NOT pinned — no \\pos emitted', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'half', { posY: 200 })],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).not.toContain('\\pos')
  })

  it('mixed pinned + unpinned rows each emit their own form', () => {
    const ass = generateAss(
      [
        makeEntry('free', 0, 1, 'unpinned'),
        makeEntry('pin',  1, 2, 'pinned', { posX: 100, posY: 200 }),
      ],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues[0]).not.toContain('\\pos')
    expect(dialogues[0]).toContain('\\an2') // unpinned still uses alignment
    expect(dialogues[1]).toContain('\\pos(100,200)')
    expect(dialogues[1]).toContain('\\an2') // pinned still has \an for anchor
  })

  it('\\pos coexists with WithBox background', () => {
    const ass = generateAss(
      [makeEntry('e1', 0, 1, 'both', {
        posX: 100,
        posY: 200,
        subtitleBackground: { enabled: true, color: 'black', opacityPercent: 50 },
      })],
      VIDEO,
      VESTIGIAL_BURNIN,
    )
    const dialogue = ass.split('\n').find((l) => l.startsWith('Dialogue:'))!
    expect(dialogue).toContain(',WithBox,')
    expect(dialogue).toContain('\\pos(100,200)')
    // REQ-0096 — bg paint moved from \4c/\4a to \3c/\3a.
    expect(dialogue).toContain('\\3c&H000000&')
    expect(dialogue).toContain('\\3a&H80&')
    expect(dialogue).toContain('\\shad0')
  })
})
