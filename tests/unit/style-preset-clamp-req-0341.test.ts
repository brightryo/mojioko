import { describe, it, expect } from 'vitest'
import { resolveStylePresetPatch } from '../../src/renderer/lib/style-preset-apply'
import {
  PRESET_CLAMP_RULES,
  PRESET_STORED_KEYS,
  type StylePreset,
} from '../../src/shared/style-preset'
import {
  FONT_SIZE_MIN_PX,
  FONT_SIZE_MAX_PX,
  OUTLINE_THICKNESS_MAX_PX,
  MARGIN_V_MIN_PX,
  MARGIN_V_MAX_PX,
} from '../../src/shared/constants'

/**
 * REQ-0341 §3-1 — a preset's values are clamped when APPLIED, not when read.
 *
 * `settings-store`'s hydrate validates only the preset envelope on purpose:
 * a preset written by a newer build may carry keys this build does not know,
 * and dropping them would corrupt the file on the next save (REQ-0335 §3-6).
 * The cost is that a hand-edited `settings.json` can put any number in a
 * preset and have it land on a cue verbatim — `fontSizePx` reaches the ASS
 * writer as `\fs<n>` with no clamp anywhere in between.
 *
 * Clamping on the way OUT keeps both properties, which is what these pin.
 */
function preset(style: Record<string, unknown>): StylePreset {
  return {
    id: 'p1',
    name: 'test',
    version: 1,
    createdAtMs: 0,
    style: style as StylePreset['style'],
  }
}
const GEOMETRY = { videoWidthPx: 1920, videoHeightPx: 1080 }

describe('REQ-0341 §3-1 — preset values are clamped at apply time', () => {
  it('★ an absurd fontSizePx from a hand-edited settings.json cannot reach a cue', () => {
    const patch = resolveStylePresetPatch(preset({ fontSizePx: 5000 }), GEOMETRY)
    expect(patch.fontSizePx).toBe(FONT_SIZE_MAX_PX)
  })

  it('clamps every field that has no clamp downstream', () => {
    const patch = resolveStylePresetPatch(
      preset({
        fontSizePx: -1,
        outlineThicknessPx: 999,
        verticalMarginPx: -50,
      }),
      GEOMETRY,
    )
    expect(patch.fontSizePx).toBe(FONT_SIZE_MIN_PX)
    expect(patch.outlineThicknessPx).toBe(OUTLINE_THICKNESS_MAX_PX)
    expect(patch.verticalMarginPx).toBe(MARGIN_V_MIN_PX)

    const high = resolveStylePresetPatch(preset({ verticalMarginPx: 1e9 }), GEOMETRY)
    expect(high.verticalMarginPx).toBe(MARGIN_V_MAX_PX)
  })

  it('leaves in-range values exactly alone', () => {
    const style = { fontSizePx: 120, outlineThicknessPx: 4, verticalMarginPx: 40 }
    const patch = resolveStylePresetPatch(preset(style), GEOMETRY)
    expect(patch.fontSizePx).toBe(120)
    expect(patch.outlineThicknessPx).toBe(4)
    expect(patch.verticalMarginPx).toBe(40)
  })

  it('does NOT re-clamp fields that are already clamped downstream', () => {
    // A second clamp is how this codebase grows two copies of one rule that
    // then drift.  `resolveAnimation` calls itself "THE clamp, and the only
    // one" (REQ-0337 §2-5) for exactly that reason: a competing clamp here
    // would let the preview and the ASS writer disagree.  So an out-of-range
    // animation value must survive this function untouched and be clamped by
    // the resolver that both consumers already share.
    const patch = resolveStylePresetPatch(
      preset({ animationBlurPx: 999, animationDurationSec: 99, shadowDepth: 999 }),
      GEOMETRY,
    )
    expect(patch.animationBlurPx).toBe(999)
    expect(patch.animationDurationSec).toBe(99)
    expect(patch.shadowDepth).toBe(999)
  })

  it('a non-numeric value is left for the type system, not silently coerced', () => {
    const patch = resolveStylePresetPatch(
      preset({ fontSizePx: 'huge' as unknown as number }),
      GEOMETRY,
    )
    expect(patch.fontSizePx).toBe('huge')
  })

  it('★ every stored key is classified, and only the unprotected ones are clamped here', () => {
    // The table is the point: a new preset field cannot be added without
    // deciding which side it falls on.  `tsc` enforces completeness; this
    // enforces that the classification still matches reality.
    const rules = PRESET_CLAMP_RULES as Record<string, string>
    for (const k of PRESET_STORED_KEYS) {
      expect(rules[k], `stored key "${k}" has no clamp rule`).toBeDefined()
    }
    expect(Object.keys(rules).sort()).toEqual([...PRESET_STORED_KEYS].sort())
    const here = Object.keys(rules).filter((k) => rules[k] === 'clamp-here').sort()
    expect(here).toEqual(['fontSizePx', 'outlineThicknessPx', 'verticalMarginPx'])
  })
})
