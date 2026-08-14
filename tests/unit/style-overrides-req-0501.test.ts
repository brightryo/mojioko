import { describe, it, expect } from 'vitest'
import {
  applyStyleOverrides,
  isEmptyStyleOverrides,
  parseStyleOverrides,
  type StyleOverrides,
} from '../../src/main/cli/style-overrides'
import { CliError } from '../../src/main/cli/output'
import type { SubtitleEntry } from '../../src/shared/types'

/**
 * REQ-0501 §1 — the remaining GUI-settable style axes, headlessly.
 *
 * Ranges here are the GUI controls' own min/max (audited against the inspector,
 * bulk-edit and defaults panels). The point of pinning them is that "what the
 * CLI accepts" and "what the app can store" must not drift apart: a CLI that
 * accepts `--rotation 400` would write a value no GUI slider can produce.
 *
 * Real-pixel proof that each flag reaches the render lives in
 * `verify:cli-smoke`; these are the cheap parse/apply invariants.
 */

const FONT = 'noto-sans-jp-semibold' as const

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

const apply = (opts: Record<string, string>, e = cue()): SubtitleEntry =>
  applyStyleOverrides([e], parseStyleOverrides(opts, FONT))[0]

describe('REQ-0501 §1 — remaining style flags land on the cue', () => {
  it('emphasis: toggle, colour and scale', () => {
    const out = apply({ emphasis: 'on', 'emphasis-color': '#FF00FF', 'emphasis-scale': '175' })
    expect(out.keywordEmphasisEnabled).toBe(true)
    expect(out.emphasisColorHex).toBe('#FF00FF')
    expect(out.emphasisScalePercent).toBe(175)
    expect(apply({ emphasis: 'off' }).keywordEmphasisEnabled).toBe(false)
  })

  it('shadow depth (0 = off, which is how the GUI encodes the toggle)', () => {
    expect(apply({ shadow: '40' }).shadowDepth).toBe(40)
    expect(apply({ shadow: '0' }, cue({ shadowDepth: 30 })).shadowDepth).toBe(0)
  })

  it('rotation, casing, line spacing, alphas', () => {
    expect(apply({ rotation: '359' }).rotation).toBe(359)
    expect(apply({ uppercase: 'on' }).casing).toBe('uppercase')
    expect(apply({ uppercase: 'off' }, cue({ casing: 'uppercase' })).casing).toBe('none')
    expect(apply({ 'line-spacing': '-50' }).lineSpacingPercent).toBe(-50)
    expect(apply({ 'text-alpha': '0' }).textAlpha).toBe(0)
    expect(apply({ 'outline-alpha': '0' }).outlineAlpha).toBe(0)
  })

  it('background box merges onto the cue instead of replacing it', () => {
    // `subtitleBackground` is a required concrete object, so a partial override
    // must keep the sub-fields the caller did not mention.
    const start = cue({ subtitleBackground: { enabled: false, color: 'white', opacityPercent: 80 } })
    const out = apply({ background: 'on' }, start)
    expect(out.subtitleBackground).toEqual({ enabled: true, color: 'white', opacityPercent: 80 })
  })

  it('background colour and opacity', () => {
    const out = apply({ background: 'on', 'background-color': 'white', 'background-opacity': '0' })
    expect(out.subtitleBackground).toEqual({ enabled: true, color: 'white', opacityPercent: 0 })
  })

  it('applies to EVERY non-deleted cue, and skips deleted ones', () => {
    const out = applyStyleOverrides(
      [cue(), cue({ id: 'b' }), cue({ id: 'c', isDeleted: true })],
      parseStyleOverrides({ rotation: '90' }, FONT),
    )
    expect(out.map((e) => e.rotation)).toEqual([90, 90, undefined])
  })
})

describe('REQ-0501 §1 — out-of-range values are rejected, not clamped', () => {
  // Silently clamping is the same class of lie as silently ignoring: the caller
  // is told the request succeeded while a different value was applied.
  it.each([
    ['emphasis-scale', '49'], ['emphasis-scale', '201'],
    ['shadow', '-1'], ['shadow', '51'],
    ['rotation', '-1'], ['rotation', '360'],
    ['line-spacing', '-51'], ['line-spacing', '101'],
    ['text-alpha', '-1'], ['text-alpha', '101'],
    ['outline-alpha', '101'],
    ['background-opacity', '101'],
  ])('--%s %s → USAGE', (key, value) => {
    expect(() => parseStyleOverrides({ [key]: value }, FONT)).toThrow(CliError)
  })

  it.each([
    ['emphasis', 'yes'],
    ['uppercase', 'true'],
    ['background', '1'],
    ['background-color', '#000000'],
    ['emphasis-color', 'magenta'],
    ['rotation', '20.5'],
    ['shadow', 'big'],
  ])('malformed --%s %s → USAGE', (key, value) => {
    expect(() => parseStyleOverrides({ [key]: value }, FONT)).toThrow(CliError)
  })

  it.each([
    ['emphasis-scale', '50'], ['emphasis-scale', '200'],
    ['shadow', '0'], ['shadow', '50'],
    ['rotation', '0'], ['rotation', '359'],
    ['line-spacing', '-50'], ['line-spacing', '100'],
    ['text-alpha', '0'], ['text-alpha', '100'],
    ['background-opacity', '0'], ['background-opacity', '100'],
  ])('boundary --%s %s is ACCEPTED', (key, value) => {
    expect(() => parseStyleOverrides({ [key]: value }, FONT)).not.toThrow()
  })
})

describe('REQ-0501 §1 — omitted flags write nothing (fallbacks intact)', () => {
  it('an empty option set produces an empty override', () => {
    const ov = parseStyleOverrides({}, FONT)
    expect(isEmptyStyleOverrides(ov)).toBe(true)
    const before = cue({ rotation: 45, casing: 'uppercase' })
    expect(applyStyleOverrides([before], ov)[0]).toBe(before)
  })

  it('setting one axis leaves the others untouched', () => {
    const before = cue({ rotation: 45, shadowDepth: 12, textAlpha: 30 })
    const out = apply({ rotation: '90' }, before)
    expect(out.rotation).toBe(90)
    expect(out.shadowDepth).toBe(12)
    expect(out.textAlpha).toBe(30)
  })

  /**
   * ★ Negative control for the keyed probe in `isEmptyStyleOverrides`.
   *
   * If a new field is not counted there, an invocation that sets ONLY that field
   * takes the "no overrides" early return and the flag becomes a silent no-op
   * that still reports success — the exact REQ-0460/0461 failure. The probe is
   * `Required<{[K in keyof StyleOverrides]: true}>`, so a missing key is a tsc
   * error; this asserts the runtime half.
   */
  it.each([
    ['keywordEmphasisEnabled', { keywordEmphasisEnabled: false }],
    ['emphasisColorHex', { emphasisColorHex: '#FF00FF' }],
    ['emphasisScalePercent', { emphasisScalePercent: 175 }],
    ['shadowDepth', { shadowDepth: 0 }],
    ['rotation', { rotation: 0 }],
    ['casing', { casing: 'none' as const }],
    ['lineSpacingPercent', { lineSpacingPercent: 0 }],
    ['textAlpha', { textAlpha: 0 }],
    ['outlineAlpha', { outlineAlpha: 0 }],
    ['backgroundEnabled', { backgroundEnabled: false }],
    ['backgroundColor', { backgroundColor: 'white' as const }],
    ['backgroundOpacityPercent', { backgroundOpacityPercent: 0 }],
  ] satisfies [string, StyleOverrides][])('%s alone is not "empty" (negative control)', (_name, ov) => {
    // Every value above is falsy-ish on purpose: `0` / `false` / `'none'` are
    // exactly the values a naive truthiness check would drop.
    expect(isEmptyStyleOverrides(ov)).toBe(false)
    const before = cue()
    expect(applyStyleOverrides([before], ov)[0]).not.toBe(before)
  })
})
