import { describe, it, expect } from 'vitest'
import {
  getFontMeta,
  getFontFamilies,
  type FontId,
} from '../../src/shared/fonts'

/**
 * REQ-0299 §2 — FamilyWeightSelector must ALWAYS render the weight
 * row (even for single-weight families like Anton / Bebas Neue), so
 * the inspector / bulk-edit column doesn't shrink when a
 * single-weight family is picked.  Pre-REQ-0299 the weight row was
 * conditionally rendered on `currentFamily.hasMultipleWeights`, so
 * picking Anton visibly collapsed the picker.
 *
 * The component itself is React + Popover heavy and awkward to
 * render in vitest without a DOM harness.  These tests pin the pure
 * data-model contract the component depends on:
 *   1. Every registered font family exposes its `hasMultipleWeights`
 *      flag (the switch that used to conditionally render the row).
 *   2. Single-weight families (Anton, Bebas Neue, Poppins-single-
 *      weight forms) DO exist in the registry — so the "always
 *      render, disable if single-weight" branch has real coverage
 *      in production.
 *   3. Multi-weight families (Noto Sans JP, Poppins-multi) also
 *      exist — the enabled/disabled branch flips as families
 *      change.
 *
 * If a future refactor makes every family multi-weight (or
 * eliminates the flag), the "always render" branch becomes dead
 * code and this test can be simplified.  Until then it's a
 * regression tripwire.
 */

describe('REQ-0299 §2 — FamilyWeightSelector weight row is always renderable', () => {
  const families = getFontFamilies()

  it('registry declares at least one SINGLE-weight family (Anton / Bebas / etc.)', () => {
    const singles = families.filter((f) => !f.hasMultipleWeights)
    // We want at least one single-weight family in the registry so
    // the "single-weight, always render as disabled" branch of the
    // FamilyWeightSelector has real coverage in production.
    expect(singles.length).toBeGreaterThan(0)
    // Sanity: Anton has always been single-weight in mojioko's font set.
    expect(singles.map((f) => f.cssFontFamily)).toContain('MOJIOKO Anton')
  })

  it('registry declares at least one MULTI-weight family (Noto / Poppins)', () => {
    const multi = families.filter((f) => f.hasMultipleWeights)
    expect(multi.length).toBeGreaterThan(0)
    expect(multi.map((f) => f.cssFontFamily)).toContain('MOJIOKO Noto Sans JP')
  })

  it('single-weight family has a resolvable current weight (Regular fallback)', () => {
    // When the FamilyWeightSelector disables the weight trigger for
    // a single-weight family, it shows the sole weight's display
    // name (typically "Regular").  This test pins that the pure
    // `getFontMeta` chain can produce that display name for at
    // least one single-weight family, so the disabled trigger has
    // real text to render.
    const anton = families.find((f) => f.cssFontFamily === 'MOJIOKO Anton')
    expect(anton).toBeDefined()
    // Anton's defaultFontId is a valid FontId; getFontMeta returns
    // a meta whose displayName includes the family name.
    const meta = getFontMeta(anton!.defaultFontId as FontId)
    expect(meta.displayName).toContain('Anton')
  })

  it('multi-weight family exposes weights via the family record (weight dropdown has choices)', () => {
    // The weight dropdown enumerates weights via
    // `selectableWeightsForFamily(family, ...)`.  This test verifies
    // that the family's data structure supports the enumeration —
    // if a refactor were to remove `weights[]` from families with
    // `hasMultipleWeights=true`, the dropdown would silently
    // enumerate an empty list.
    const noto = families.find((f) => f.cssFontFamily === 'MOJIOKO Noto Sans JP')
    expect(noto).toBeDefined()
    expect(noto!.hasMultipleWeights).toBe(true)
    expect(noto!.weights.length).toBeGreaterThan(1)
  })
})
