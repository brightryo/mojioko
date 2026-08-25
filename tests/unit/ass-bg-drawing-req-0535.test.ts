/**
 * REQ-0535 — the ASS writer's two background paths, both pinned.
 *
 * ## Why this file has to exist
 *
 * `ass-generator-baseline-ac1fd67.test.ts` already renders a background-enabled
 * cue, and it stayed byte-identical through this REQ.  That is NOT evidence the
 * new path is unchanged — it is evidence the baseline never reaches it.  Under
 * vitest there is no Electron, so `getLineBreakMetrics` cannot resolve a font
 * path, returns `{ font: null }`, and `generateAss` deliberately keeps libass's
 * old `BorderStyle=3` box.  The baseline pins the FALLBACK.
 *
 * So the new path needs metrics injected, which is exactly what the
 * `metricsFor` parameter is for.  Both branches are asserted here so neither can
 * change unnoticed.
 */
import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import type { LineBreakMetrics } from '../../src/shared/line-break-core'
import type { BurninPosition, SubtitleEntry, VideoInfo } from '../../src/shared/types'

const VIDEO = {
  path: 'x.mp4', hasVideoStream: true, widthPx: 1920, heightPx: 1080,
  durationSec: 6, fps: 30, container: 'mp4', videoCodec: 'h264',
  audioTracks: [], fileSizeBytes: 1,
} as unknown as VideoInfo

const burnin: BurninPosition = {
  horizontalPosition: 'center', verticalPosition: 'center', verticalMarginPx: 40,
}

/** Every glyph half an em wide, no kerning — enough to exercise the width path. */
const FAKE_METRICS: LineBreakMetrics = {
  font: {
    unitsPerEm: 1000,
    charToGlyph: () => ({ advanceWidth: 500 }),
    getKerningValue: () => 0,
  } as unknown as LineBreakMetrics['font'],
  libassScale: 1,
  cmap: null,
  tofu: null,
}
const NO_METRICS: LineBreakMetrics = { font: null, libassScale: 1, cmap: null, tofu: null }

function cue(over: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    id: 'c1', startSec: 0, endSec: 2, text: 'AAAA\\NAAAA',
    fontSizePx: 60,
    textColorHex: '#ffffff', textAlpha: 100,
    outlineColorHex: '#ff0000', outlineThicknessPx: 8, outlineAlpha: 100,
    fadeDurationSec: 0,
    fontId: 'noto-sans-jp-semibold',
    horizontalPosition: 'center' as const,
    verticalPosition: 'center' as const,
    verticalMarginPx: 40,
    subtitleBackground: { enabled: true, color: 'black' as const, opacityPercent: 60 },
    lineSpacingPercent: 0,
    words: [], karaokeEnabled: false,
    karaokeHighlightColor: '#ffffff', karaokeStyle: 'switch' as const,
    isDeleted: false, isEdited: false,
    ...over,
  }
  return { ...base, original: { ...base } } as unknown as SubtitleEntry
}

const render = (e: SubtitleEntry, m: LineBreakMetrics) =>
  generateAss([e], VIDEO, burnin, undefined, 'MOJIOKO Noto Sans JP SemiBold', true, 'switch', true, 60, () => m)

const dialogues = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'))

describe('REQ-0535 — background drawn by the writer (metrics available)', () => {
  it('emits ONE drawing event for the cue, before its text events', () => {
    const lines = dialogues(render(cue(), FAKE_METRICS))
    expect(lines).toHaveLength(3) // 1 background + 2 display lines
    expect(lines[0]).toContain('\\p1')
    expect(lines[1]).not.toContain('\\p1')
    expect(lines[2]).not.toContain('\\p1')
  })

  it('the drawing carries the background colour and alpha as FILL, not as outline', () => {
    const bg = dialogues(render(cue(), FAKE_METRICS))[0]
    expect(bg).toContain('\\1c&H000000&')
    expect(bg).toContain('\\1a&H66&') // 60 % opaque
    expect(bg).not.toContain('\\3a')
  })

  it('white background resolves to the white fill', () => {
    const e = cue({ subtitleBackground: { enabled: true, color: 'white', opacityPercent: 60 } } as Partial<SubtitleEntry>)
    expect(dialogues(render(e, FAKE_METRICS))[0]).toContain('\\1c&H00FFFFFF&')
  })

  it('★ the text no longer paints a box: no \\3a, and \\bord0', () => {
    const [, text] = dialogues(render(cue(), FAKE_METRICS))
    expect(text).toContain('\\bord0')
    expect(text).not.toContain('\\3a&H66&')
    expect(text).not.toContain('WithBox')
  })

  it('the drawing has one contour per display line', () => {
    const bg = dialogues(render(cue(), FAKE_METRICS))[0]
    expect(bg.match(/m /g)).toHaveLength(2)
    const three = dialogues(render(cue({ text: 'AA\\NAA\\NAA' }), FAKE_METRICS))[0]
    expect(three.match(/m /g)).toHaveLength(3)
  })

  it('★ consecutive contours share an edge exactly — no overlap, no gap', () => {
    const bg = dialogues(render(cue(), FAKE_METRICS))[0]
    // Slice PAST the `\p1}` marker — its own "1" would otherwise be read as
    // the first coordinate and shift every index by one.
    const body = bg.slice(bg.indexOf('\\p1}') + '\\p1}'.length)
    const n = body.match(/-?\d+/g)!.map(Number)
    // contour: m x0 y0 l x1 y0 l x1 y1 l x0 y1  => 8 numbers each
    expect(n[5]).toBe(n[9]) // first contour's y1 === second contour's y0
  })

  it('a single-line cue still gets its background', () => {
    const bg = dialogues(render(cue({ text: 'AAAA' }), FAKE_METRICS))[0]
    expect(bg).toContain('\\p1')
    expect(bg.match(/m /g)).toHaveLength(1)
  })

  it('★ outline 0 still draws NO background — unchanged from libass', () => {
    // Under `BorderStyle=3` the box IS the outline grown by `\bord`, so at 0 it
    // vanishes (REQ-0340), and the CLI warns `BACKGROUND_BOX_NOT_DRAWN` about
    // it.  Drawing our own rectangle here would make a background appear where
    // one never has — a visible change this REQ was not asked to make.
    const lines = dialogues(render(cue({ outlineThicknessPx: 0 } as Partial<SubtitleEntry>), FAKE_METRICS))
    expect(lines.join('\n')).not.toContain('\\p1')
    expect(lines[0]).toContain('WithBox')
  })

  it('a cue with the background OFF emits no drawing at all', () => {
    const e = cue({ subtitleBackground: { enabled: false, color: 'black', opacityPercent: 60 } } as Partial<SubtitleEntry>)
    const lines = dialogues(render(e, FAKE_METRICS))
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).not.toContain('\\p1')
  })
})

describe('REQ-0535 — fallback when the font cannot be measured', () => {
  it('keeps libass\'s own box rather than guessing a width', () => {
    const lines = dialogues(render(cue(), NO_METRICS))
    expect(lines).toHaveLength(2)
    expect(lines.join('\n')).not.toContain('\\p1')
    // The pre-REQ-0535 rendering, unchanged: WithBox style + \3c/\3a box tags.
    expect(lines[0]).toContain('WithBox')
    expect(lines[0]).toContain('\\3c&H000000&')
    expect(lines[0]).toContain('\\3a&H66&')
    expect(lines[0]).toContain('\\bord8')
  })

  it('this is the branch the byte-baseline test pins (no Electron under vitest)', () => {
    // Same call WITHOUT the metrics argument — the production default — must
    // land on the fallback here, which is why the baseline stayed identical.
    const withDefault = generateAss(
      [cue()], VIDEO, burnin, undefined, 'MOJIOKO Noto Sans JP SemiBold', true, 'switch',
    )
    expect(withDefault).not.toContain('\\p1')
    expect(withDefault).toContain('WithBox')
  })
})
