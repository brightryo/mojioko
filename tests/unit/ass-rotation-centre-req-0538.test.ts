/**
 * REQ-0538 — a rotated cue turns about ONE point.
 *
 * `\frz` turns each event about its OWN `\pos`. The background is one drawing
 * for the whole cue and each text line is a separate event, so if their `\pos`
 * values disagree the lines spin in place while the box turns as a unit, and
 * they drift apart by `pitch * sin(theta)`. That is what put the end of a line
 * outside its background at 15 degrees.
 *
 * The pixels are gated by `npm run verify:bg-box-parity` (coverage judgement,
 * with a negative control). What this file pins is the arithmetic underneath,
 * so a regression is a red unit test long before anyone renders a frame — and
 * in particular that **rotation 0 is untouched**, which is the condition the
 * REQ set for not disturbing REQ-0537's confirmed-correct output.
 */
import { describe, it, expect } from 'vitest'
import { generateAss } from '../../src/main/services/ass-generator'
import { cueBlockOrigin, rotatePointClockwise } from '../../src/shared/line-spacing'
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

/** Every glyph half an em wide — the writer needs metrics to draw its own box. */
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

const render = (e: SubtitleEntry) =>
  generateAss([e], VIDEO, burnin, undefined, 'MOJIOKO Noto Sans JP SemiBold', true, 'switch', true, 60,
    () => FAKE_METRICS)

const dialogues = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
const posOf = (line: string) => {
  const m = /\\pos\(([-\d.]+),([-\d.]+)\)/.exec(line)
  if (!m) throw new Error(`no \\pos in: ${line.slice(0, 120)}`)
  return { x: Number(m[1]), y: Number(m[2]) }
}

describe('REQ-0538 — rotation centre', () => {
  it('rotatePointClockwise is the identity at 0 degrees', () => {
    const p = rotatePointClockwise({ x: 100, y: 40 }, { x: 960, y: 540 }, 0)
    expect(p).toEqual({ x: 100, y: 40 })
  })

  it('rotatePointClockwise turns CLOCKWISE in screen coordinates (y down)', () => {
    // A point directly above the origin swings to the RIGHT under a clockwise turn.
    const p = rotatePointClockwise({ x: 0, y: -100 }, { x: 0, y: 0 }, 90)
    expect(p.x).toBeCloseTo(100, 6)
    expect(p.y).toBeCloseTo(0, 6)
  })

  it('cueBlockOrigin is the point the cue alignment already defines', () => {
    // `posX`/`posY` are OPTIONAL, and "pinned" means both are present. Passing
    // null here instead of leaving them out would read as pinned-at-null — the
    // same trap `cueLineAnchors` has always had, so it is spelled out.
    const common = {
      lineHeightsPx: [68, 68], playResX: 1920, playResY: 1080,
      verticalMarginPx: 40, marginLrPx: 40, horizontalPosition: 'center' as const,
    }
    expect(cueBlockOrigin({ ...common, verticalPosition: 'bottom' })).toEqual({ x: 960, y: 1040 })
    expect(cueBlockOrigin({ ...common, verticalPosition: 'top' })).toEqual({ x: 960, y: 40 })
    expect(cueBlockOrigin({ ...common, verticalPosition: 'center' })).toEqual({ x: 960, y: 540 })
    expect(cueBlockOrigin({ ...common, horizontalPosition: 'left', verticalPosition: 'top' }).x).toBe(40)
    expect(cueBlockOrigin({ ...common, horizontalPosition: 'right', verticalPosition: 'top' }).x).toBe(1880)
    expect(cueBlockOrigin({ ...common, verticalPosition: 'bottom', posX: 111, posY: 222 }))
      .toEqual({ x: 111, y: 222 })
  })

  it('the origin does not depend on how many lines the cue has', () => {
    // It is the cue's alignment point, not a function of the block's height —
    // that is what lets the background and the text share it.
    const common = {
      playResX: 1920, playResY: 1080, verticalMarginPx: 40, marginLrPx: 40,
      horizontalPosition: 'center' as const, verticalPosition: 'bottom' as const,
    }
    expect(cueBlockOrigin({ ...common, lineHeightsPx: [68] }))
      .toEqual(cueBlockOrigin({ ...common, lineHeightsPx: [68, 68, 68] }))
  })

  it('the background sits on the SAME point the text lines turn about', () => {
    const lines = dialogues(render(cue({ rotation: 15 })))
    expect(lines[0]).toContain('\\p1')
    const origin = posOf(lines[0])
    const a = posOf(lines[1])
    const b = posOf(lines[2])

    // Both anchors are the same distance from the origin, on opposite sides:
    // that is what "one rigid block turned about one centre" means.
    const da = Math.hypot(a.x - origin.x, a.y - origin.y)
    const db = Math.hypot(b.x - origin.x, b.y - origin.y)
    expect(da).toBeCloseTo(db, 3)
    expect(a.x + b.x).toBeCloseTo(2 * origin.x, 3)
    expect(a.y + b.y).toBeCloseTo(2 * origin.y, 3)

    // And the block really is tilted — the inter-line vector leans by the
    // rotation angle. Before the fix it stayed vertical while the box turned.
    const tilt = (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI
    expect(-tilt).toBeCloseTo(15, 1)
    expect(Math.abs(b.x - a.x)).toBeGreaterThan(1)
  })

  it('every event carries the same \\frz, so the block turns as one', () => {
    const frz = dialogues(render(cue({ rotation: 15 }))).map((l) => /\\frz([\d.]+)/.exec(l)?.[1])
    expect(frz).toHaveLength(3)
    expect(new Set(frz).size).toBe(1)
    expect(frz[0]).toBe('345') // \frz is counter-clockwise: 360 - 15
  })

  it('★ rotation 0 is byte-identical to before the fix (nothing moved)', () => {
    const lines = dialogues(render(cue({ rotation: 0 })))
    const origin = posOf(lines[0])
    const a = posOf(lines[1])
    const b = posOf(lines[2])
    // Unrotated: the lines stack straight down and share the origin's x.
    expect(a.x).toBeCloseTo(origin.x, 6)
    expect(b.x).toBeCloseTo(origin.x, 6)
    expect(b.y - a.y).toBeGreaterThan(0)
    // The origin is the block's own alignment point, not line 0's anchor.
    expect(origin.y).toBeCloseTo((a.y + b.y) / 2, 6)
  })
})
