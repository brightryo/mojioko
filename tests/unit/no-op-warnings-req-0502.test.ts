import { describe, it, expect } from 'vitest'
import { detectNoOpCombinations, detectIgnoredFlags } from '../../src/main/cli/no-op-warnings'
import { parseTimes, frameOutputPath, EXPORT_FRAME_MAX_TIMES } from '../../src/main/cli/frame-times'
import { CliError } from '../../src/main/cli/output'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0502 — two additions, both about not misleading the caller.
 *
 * §2: a flag can be read, applied to the cue, and still render nothing. From
 * the caller's side that is indistinguishable from success — the same blindness
 * REQ-0499→0501 kept removing, arrived at through a combination rather than a
 * missing wire.
 *
 * The half that matters most here is the NEGATIVE half: a warning that fires on
 * ordinary input is noise, and noise is unread. Every case below is asserted in
 * both directions.
 */

function cue(over: Partial<SubtitleEntry> = {}): SubtitleEntry {
  const base = {
    startSec: 0, endSec: 1, text: 'hello', fadeDurationSec: 0,
    fontSizePx: 100, textColorHex: '#FFFFFF', outlineColorHex: '#000000',
    outlineThicknessPx: 4, horizontalPosition: 'center' as const,
    verticalPosition: 'bottom' as const, verticalMarginPx: 40,
    subtitleBackground: { enabled: false, color: 'black' as const, opacityPercent: 50 },
  }
  return { id: 'a', isDeleted: false, isEdited: false, ...base, ...over, original: { ...base } } as SubtitleEntry
}

const codes = (entries: SubtitleEntry[]): string[] => detectNoOpCombinations(entries).map((w) => w.code)
const bg = (enabled: boolean) => ({ enabled, color: 'black' as const, opacityPercent: 50 })

describe('REQ-0502 §2-1 — background box with a zero outline', () => {
  // Verified in real pixels (RES-0502 §2.1): white pixels 7,544 with outline 0
  // vs 38,608 with outline 1 on the same frame — the box genuinely is not drawn.
  it('warns when the box is on and the outline is 0', () => {
    expect(codes([cue({ subtitleBackground: bg(true), outlineThicknessPx: 0 })])).toContain('BACKGROUND_BOX_NOT_DRAWN')
  })

  it('does NOT warn when the outline is 1 (the box draws)', () => {
    expect(codes([cue({ subtitleBackground: bg(true), outlineThicknessPx: 1 })])).toEqual([])
  })

  it('does NOT warn for a zero outline when the box is off', () => {
    expect(codes([cue({ subtitleBackground: bg(false), outlineThicknessPx: 0 })])).toEqual([])
  })

  it('counts only the affected cues', () => {
    const w = detectNoOpCombinations([
      cue({ subtitleBackground: bg(true), outlineThicknessPx: 0 }),
      cue({ id: 'b', subtitleBackground: bg(true), outlineThicknessPx: 0 }),
      cue({ id: 'c', subtitleBackground: bg(true), outlineThicknessPx: 2 }),
    ])
    expect((w[0].detail as { cueCount: number }).cueCount).toBe(2)
  })

  it('ignores deleted and empty cues (they are never drawn)', () => {
    expect(codes([
      cue({ isDeleted: true, subtitleBackground: bg(true), outlineThicknessPx: 0 }),
      cue({ id: 'b', text: '   ', subtitleBackground: bg(true), outlineThicknessPx: 0 }),
    ])).toEqual([])
  })
})

describe('REQ-0502 §2-2 — emphasis enabled with nothing to emphasise', () => {
  it('warns when emphasis is on but no spans exist', () => {
    expect(codes([cue({ keywordEmphasisEnabled: true })])).toContain('EMPHASIS_NO_SPANS')
  })

  it('does NOT warn when spans are present', () => {
    // Anchored span over "hel" — `resolveEmphasis` returns a non-empty range,
    // which is the same condition the ASS writer uses to decide it draws.
    expect(codes([cue({
      keywordEmphasisEnabled: true,
      emphasisSpans: [{ start: 0, end: 3, text: 'hel' }],
    })])).toEqual([])
  })

  it('does NOT warn when emphasis is off, even with spans present', () => {
    expect(codes([cue({
      keywordEmphasisEnabled: false,
      emphasisSpans: [{ start: 0, end: 3, text: 'hel' }],
    })])).toEqual([])
  })
})

describe('REQ-0502 §2-4 — no warnings on ordinary input', () => {
  // The whole value of these warnings is that they are rare. A detector that
  // fires on a default cue would be ignored within a day.
  it('a default cue produces no warnings at all', () => {
    expect(detectNoOpCombinations([cue()])).toEqual([])
  })

  it('an empty project produces no warnings', () => {
    expect(detectNoOpCombinations([])).toEqual([])
  })

  it('a heavily styled but coherent cue produces no warnings', () => {
    // NOTE: no shadow here — a shadow WITH the background box on is not
    // "coherent", it is the self-cancellation `SHADOW_SUPPRESSED_BY_BACKGROUND`
    // reports. This fixture originally carried one and the detector correctly
    // refused to stay silent.
    expect(codes([cue({
      subtitleBackground: bg(true), outlineThicknessPx: 3,
      keywordEmphasisEnabled: true, emphasisSpans: [{ start: 0, end: 2, text: 'he' }],
      rotation: 15, casing: 'uppercase',
      lineSpacingPercent: -20, textAlpha: 80, outlineAlpha: 90,
      karaokeEnabled: true,
    })])).toEqual([])
  })

  it('a heavily styled cue WITHOUT a background box is also silent', () => {
    expect(codes([cue({
      shadowDepth: 20, rotation: 15, casing: 'uppercase', outlineThicknessPx: 6,
      lineSpacingPercent: -20, textAlpha: 80, outlineAlpha: 90, karaokeEnabled: true,
    })])).toEqual([])
  })
})

describe('REQ-0502 §2-3 — shadow and background self-cancellations', () => {
  it('warns that the box suppresses the shadow, and not otherwise', () => {
    expect(codes([cue({ subtitleBackground: bg(true), shadowDepth: 20 })])).toContain('SHADOW_SUPPRESSED_BY_BACKGROUND')
    expect(codes([cue({ subtitleBackground: bg(false), shadowDepth: 20 })])).toEqual([])
    expect(codes([cue({ subtitleBackground: bg(true), shadowDepth: 0 })])).toEqual([])
  })

  it('warns that a zero-opacity box also removes the outline', () => {
    const zero = { enabled: true, color: 'black' as const, opacityPercent: 0 }
    expect(codes([cue({ subtitleBackground: zero })])).toContain('BACKGROUND_BOX_INVISIBLE')
    expect(codes([cue({ subtitleBackground: { ...zero, opacityPercent: 1 } })])).toEqual([])
  })
})

/**
 * REQ-0502 §2-3 — the flag-keyed pass.
 *
 * These cannot be detected from the resolved cue: a cue carrying an outline
 * colour looks the same whether a flag, a preset or the project file put it
 * there. `--margin-v` is the clearest case — every centred cue carries a margin
 * value, so an entry-level check would fire on essentially every centred burn,
 * which is precisely the "always fires ⇒ never read" outcome §2-4 forbids.
 */
describe('REQ-0502 §2-3 — flags the render ignores', () => {
  const flagCodes = (opts: Record<string, string | boolean>, entries: SubtitleEntry[]): string[] =>
    detectIgnoredFlags(opts, entries).map((w) => w.code)

  it('outline colour/alpha are reported as overridden by the box', () => {
    const boxed = [cue({ subtitleBackground: bg(true) })]
    expect(flagCodes({ 'outline-color': '#00FF00' }, boxed)).toEqual(['OUTLINE_OVERRIDDEN_BY_BACKGROUND'])
    // ...but only when the flag was actually passed, and only with the box on.
    expect(flagCodes({}, boxed)).toEqual([])
    expect(flagCodes({ 'outline-color': '#00FF00' }, [cue()])).toEqual([])
  })

  it('emphasis colour/scale without the emphasis toggle', () => {
    expect(flagCodes({ 'emphasis-scale': '150' }, [cue()])).toEqual(['EMPHASIS_FLAGS_WITHOUT_EMPHASIS'])
    expect(flagCodes({ 'emphasis-scale': '150' }, [cue({ keywordEmphasisEnabled: true })])).toEqual([])
  })

  it('karaoke colour/style without karaoke', () => {
    expect(flagCodes({ 'karaoke-color': '#FF00FF' }, [cue()])).toEqual(['KARAOKE_FLAGS_WITHOUT_KARAOKE'])
    expect(flagCodes({ 'karaoke-color': '#FF00FF' }, [cue({ karaokeEnabled: true })])).toEqual([])
  })

  it('background colour/opacity without the box', () => {
    expect(flagCodes({ 'background-color': 'white' }, [cue()])).toEqual(['BACKGROUND_FLAGS_WITHOUT_BACKGROUND'])
    expect(flagCodes({ 'background-color': 'white' }, [cue({ subtitleBackground: bg(true) })])).toEqual([])
  })

  it('--margin-v on centred and on pinned cues', () => {
    expect(flagCodes({ 'margin-v': '100' }, [cue({ verticalPosition: 'center' })])).toEqual(['MARGIN_V_IGNORED'])
    expect(flagCodes({ 'margin-v': '100' }, [cue({ posX: 10, posY: 20 })])).toEqual(['MARGIN_V_IGNORED'])
    // The ordinary case — bottom-anchored, unpinned — must stay silent.
    expect(flagCodes({ 'margin-v': '100' }, [cue({ verticalPosition: 'bottom' })])).toEqual([])
  })

  it('only fires when EVERY visible cue ignores the flag', () => {
    // A mixed project still has cues the flag reaches, so the flag is not
    // "ignored" — warning there would be wrong, not merely noisy.
    expect(flagCodes({ 'margin-v': '100' }, [
      cue({ verticalPosition: 'center' }),
      cue({ id: 'b', verticalPosition: 'bottom' }),
    ])).toEqual([])
  })

  it('passing no flags is always silent, whatever the cues look like', () => {
    expect(detectIgnoredFlags({}, [cue({ subtitleBackground: bg(true), verticalPosition: 'center', posX: 1, posY: 2 })])).toEqual([])
  })
})

describe('REQ-0502 §1 — multi-time parsing and naming', () => {
  it('a single time still parses to one entry (backward compatible)', () => {
    expect(parseTimes('1.5')).toEqual([1.5])
  })

  it('parses a comma-separated list, preserving order and duplicates', () => {
    // Neither sorted nor de-duplicated: reordering would make the result differ
    // from the request, and the index in the filename keeps duplicates distinct.
    expect(parseTimes('3.5, 1.0 ,3.5')).toEqual([3.5, 1.0, 3.5])
  })

  it.each([undefined, '', '   ', ','])('rejects a missing time (%s)', (raw) => {
    expect(() => parseTimes(raw)).toThrow(CliError)
  })

  it.each(['abc', '-1', '1.0,abc', '1.0,-2'])('rejects a malformed or negative time (%s)', (raw) => {
    expect(() => parseTimes(raw)).toThrow(CliError)
  })

  it(`rejects more than ${EXPORT_FRAME_MAX_TIMES} times, naming the cap`, () => {
    const many = Array.from({ length: EXPORT_FRAME_MAX_TIMES + 1 }, (_, i) => i).join(',')
    expect(() => parseTimes(many)).toThrow(/最大 20 件/)
    // The boundary itself is accepted.
    expect(parseTimes(Array.from({ length: EXPORT_FRAME_MAX_TIMES }, (_, i) => i).join(','))).toHaveLength(EXPORT_FRAME_MAX_TIMES)
  })

  it('derives sortable, time-labelled filenames', () => {
    // Index first so a directory listing sorts in request order; the timestamp
    // is in the name so an agent can tell frames apart without the result JSON.
    expect(frameOutputPath('C:/out/frame.png', 0, 1)).toBe('C:/out/frame-01-1.000s.png')
    expect(frameOutputPath('C:/out/frame.png', 9, 12.25)).toBe('C:/out/frame-10-12.250s.png')
    expect(frameOutputPath('C:/out/frame.jpg', 1, 3.5)).toBe('C:/out/frame-02-3.500s.jpg')
  })

  it('handles an extensionless output path', () => {
    expect(frameOutputPath('C:/out/frame', 0, 1)).toBe('C:/out/frame-01-1.000s')
  })

  it('distinct times produce distinct paths (frames cannot overwrite each other)', () => {
    const paths = [0.5, 1.5, 2.5, 3.5].map((t, i) => frameOutputPath('o.png', i, t))
    expect(new Set(paths).size).toBe(4)
  })
})

/**
 * REQ-0516 §3 — a scale animation on a multi-line cue.
 *
 * The all-`\pos` runtime emits a multi-line cue as one event per line, so
 * libass scales each line about its own anchor and the distance BETWEEN the
 * lines never changes.  The preview scales the whole block.  Owner decision
 * (REQ-0516 §3-1): warn, do not fix — animating the per-line `\pos` values is
 * not expressible in `\t`.
 *
 * The firing condition is deliberately narrow (§3-3): a warning that fires on
 * ordinary input is noise, so BOTH halves of each axis are asserted.
 */
describe('REQ-0516 §3 — scale animation on a multi-line cue', () => {
  // The libass hard-break sentinel, built without an escape so no tooling
  // between here and the file can eat the backslash (one did, and the whole
  // block silently tested single-line cues instead).
  const BR = String.fromCharCode(92) + 'N'
  const anim = (type: NonNullable<SubtitleEntry['animationType']>) => ({
    animationType: type,
    animationInEnabled: true,
    animationOutEnabled: true,
    animationDurationSec: 0.4,
    animationStartScalePercent: 30,
  })
  const has = (entries: SubtitleEntry[]) => codes(entries).includes('SCALE_ANIM_LINE_PITCH_FIXED')

  it('★ fires on multi-line + scale', () => {
    expect(has([cue({ text: `テスト${BR}です`, ...anim('scale') })])).toBe(true)
  })

  it('★ fires on multi-line + pop — it carries the same scale channel', () => {
    expect(has([cue({ text: `テスト${BR}です`, ...anim('pop') })])).toBe(true)
  })

  it('★ fires at line spacing 0 — the per-line split is the placement, not the spacing', () => {
    expect(has([cue({ text: `テスト${BR}です`, ...anim('scale'), lineSpacingPercent: 0 })])).toBe(true)
  })

  it('★ does NOT fire on a single-line cue with the same animation', () => {
    expect(has([cue({ text: 'テストです', ...anim('scale') })])).toBe(false)
    expect(has([cue({ text: 'テストです', ...anim('pop') })])).toBe(false)
  })

  it('★ does NOT fire on a multi-line cue with no animation', () => {
    expect(has([cue({ text: `テスト${BR}です` })])).toBe(false)
    expect(has([cue({ text: `テスト${BR}です`, ...anim('none') })])).toBe(false)
  })

  it('★ does NOT fire for animations with no scale channel', () => {
    for (const t of ['fade', 'blur'] as const) {
      expect(has([cue({ text: `テスト${BR}です`, ...anim(t) })]), t).toBe(false)
    }
  })

  it('does NOT fire when the animation is inert (duration 0, or both ends off)', () => {
    expect(has([cue({ text: `テスト${BR}です`, ...anim('scale'), animationDurationSec: 0 })])).toBe(false)
    expect(has([cue({
      text: `テスト${BR}です`,
      ...anim('scale'),
      animationInEnabled: false,
      animationOutEnabled: false,
    })])).toBe(false)
  })

  it('ignores deleted and blank cues, like every other check here', () => {
    expect(has([cue({ text: `テスト${BR}です`, ...anim('scale'), isDeleted: true })])).toBe(false)
    expect(has([cue({ text: `  ${BR}  `, ...anim('scale') })])).toBe(false)
  })

  it('counts the affected cues and says both what breaks and that the preview differs', () => {
    const w = detectNoOpCombinations([
      cue({ id: 'a', text: `テスト${BR}です`, ...anim('scale') }),
      cue({ id: 'b', text: `もう${BR}一つ`, ...anim('pop') }),
      cue({ id: 'c', text: 'single', ...anim('scale') }),
    ]).find((x) => x.code === 'SCALE_ANIM_LINE_PITCH_FIXED')
    expect(w).toBeDefined()
    expect((w!.detail as { cueCount: number }).cueCount).toBe(2)
    // §3-4 — the caller must learn WHAT does not happen and that the preview
    // disagrees, or "プレビューでは縮んだのに出力では縮まない" stays a mystery.
    expect(w!.message).toContain('行と行の間隔')
    expect(w!.message).toContain('プレビュー')
    expect((w!.detail as { remedy: string }).remedy).toBeTruthy()
  })
})
