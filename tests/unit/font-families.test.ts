import { describe, it, expect } from 'vitest'
import {
  getFontFamilies,
  getFamilyDefaultFontId,
  getFontIdForFamilyAndWeight,
  resolveRenderableFontId,
  DEFAULT_FONT_ID,
  FONT_SET_VERSION,
  FONT_REGISTRY,
  type FontId,
} from '../../src/shared/fonts'

/**
 * REQ-0269 B/D — pin the helper contracts that back the family+weight
 * pickers and the missing-font fallback path.  Without these, silent
 * regressions in FONT_REGISTRY structure would surface as broken
 * previews or `\fn` mismatches in burn-in — both are user-visible and
 * hard to catch by eye.
 */
describe('getFontFamilies', () => {
  const families = getFontFamilies()

  it('collapses per-weight entries into one entry per unique cssFontFamily', () => {
    const registryFamilies = new Set(FONT_REGISTRY.map((f) => f.cssFontFamily))
    expect(families).toHaveLength(registryFamilies.size)
  })

  it('groups all 9 Noto Sans JP weight FontIds under one family', () => {
    const noto = families.find((f) => f.cssFontFamily === 'Noto Sans JP')
    expect(noto).toBeDefined()
    expect(noto!.hasMultipleWeights).toBe(true)
    expect(noto!.hasBundledWeight).toBe(true)
    expect(noto!.weights.map((w) => w.weight)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900])
    expect(noto!.defaultFontId).toBe('noto-sans-jp-semibold')
  })

  it('groups all 9 Poppins weight FontIds under one family', () => {
    const poppins = families.find((f) => f.cssFontFamily === 'Poppins')
    expect(poppins).toBeDefined()
    expect(poppins!.hasMultipleWeights).toBe(true)
    expect(poppins!.hasBundledWeight).toBe(false)
    expect(poppins!.weights.map((w) => w.weight)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900])
    expect(poppins!.defaultFontId).toBe('poppins-bold')
  })

  it('marks single-weight families with hasMultipleWeights=false', () => {
    for (const fam of families) {
      if (['Noto Sans JP', 'Poppins'].includes(fam.cssFontFamily)) continue
      expect(fam.hasMultipleWeights).toBe(false)
      expect(fam.weights).toHaveLength(1)
    }
  })
})

describe('getFamilyDefaultFontId', () => {
  it('returns SemiBold for Noto Sans JP (REQ-0269 B-5)', () => {
    expect(getFamilyDefaultFontId('Noto Sans JP')).toBe('noto-sans-jp-semibold')
  })
  it('returns Bold for Poppins (REQ-0269 B-5)', () => {
    expect(getFamilyDefaultFontId('Poppins')).toBe('poppins-bold')
  })
  it('returns the only registered FontId for single-weight families', () => {
    expect(getFamilyDefaultFontId('Anton')).toBe('anton')
    expect(getFamilyDefaultFontId('Dela Gothic One')).toBe('dela-gothic-one')
    expect(getFamilyDefaultFontId('Montserrat')).toBe('montserrat')
  })
  it('falls back to DEFAULT_FONT_ID for unknown families', () => {
    expect(getFamilyDefaultFontId('This Family Does Not Exist')).toBe(DEFAULT_FONT_ID)
  })
})

describe('getFontIdForFamilyAndWeight', () => {
  it('maps a Noto weight to its specific FontId', () => {
    expect(getFontIdForFamilyAndWeight('Noto Sans JP', 100)).toBe('noto-sans-jp-thin')
    expect(getFontIdForFamilyAndWeight('Noto Sans JP', 400)).toBe('noto-sans-jp-regular')
    expect(getFontIdForFamilyAndWeight('Noto Sans JP', 900)).toBe('noto-sans-jp-black')
  })
  it('maps a Poppins weight to its specific FontId (Regular keeps the legacy `poppins` id)', () => {
    expect(getFontIdForFamilyAndWeight('Poppins', 400)).toBe('poppins')
    expect(getFontIdForFamilyAndWeight('Poppins', 700)).toBe('poppins-bold')
  })
  it('falls back to the family default when the weight is not registered', () => {
    // Poppins has no weight 450 registered — should fall back to Bold (the default).
    expect(getFontIdForFamilyAndWeight('Poppins', 450)).toBe('poppins-bold')
  })
})

describe('resolveRenderableFontId (REQ-0269 D-1 fallback)', () => {
  const bundled = new Set<FontId>([
    'noto-sans-jp-regular',
    'noto-sans-jp-medium',
    'noto-sans-jp-semibold',
  ])
  const isInstalled = (id: FontId) => bundled.has(id)

  it('returns the requested id when it is installed', () => {
    expect(resolveRenderableFontId('noto-sans-jp-semibold', isInstalled)).toBe('noto-sans-jp-semibold')
  })

  it('falls back to the nearest installed same-family weight', () => {
    // Requested 700 (Bold), installed [400, 500, 600] → nearest is 600 (SemiBold).
    expect(resolveRenderableFontId('noto-sans-jp-bold', isInstalled)).toBe('noto-sans-jp-semibold')
    // Requested 100 (Thin), installed [400, 500, 600] → nearest is 400 (Regular).
    expect(resolveRenderableFontId('noto-sans-jp-thin', isInstalled)).toBe('noto-sans-jp-regular')
    // Requested 500 (Medium — installed) → returns itself, not a substitute.
    expect(resolveRenderableFontId('noto-sans-jp-medium', isInstalled)).toBe('noto-sans-jp-medium')
  })

  it('falls back to DEFAULT_FONT_ID when no same-family weight is installed', () => {
    // Requested Poppins Bold; nothing Poppins is installed → Noto SemiBold.
    expect(resolveRenderableFontId('poppins-bold', isInstalled)).toBe(DEFAULT_FONT_ID)
    // Requested Anton; not installed → Noto SemiBold.
    expect(resolveRenderableFontId('anton', isInstalled)).toBe(DEFAULT_FONT_ID)
  })

  it('picks the same family in preference to Noto when at least one family weight is installed', () => {
    const withPoppinsRegular = new Set<FontId>([
      'noto-sans-jp-semibold',
      'poppins',
    ])
    // Requested Poppins Bold; Poppins Regular is installed → prefer Poppins Regular over Noto.
    expect(resolveRenderableFontId('poppins-bold', (id) => withPoppinsRegular.has(id))).toBe('poppins')
  })

  it('does not depend on FONT_REGISTRY mutation — returns pure result', () => {
    const before = FONT_REGISTRY.map((f) => f.id)
    resolveRenderableFontId('poppins-black', isInstalled)
    expect(FONT_REGISTRY.map((f) => f.id)).toEqual(before)
  })
})

describe('FONT_SET_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(FONT_SET_VERSION)).toBe(true)
    expect(FONT_SET_VERSION).toBeGreaterThan(0)
  })
  it('is at least 2 (REQ-0269 bumps from v1 to v2 to gate the new weight assets)', () => {
    expect(FONT_SET_VERSION).toBeGreaterThanOrEqual(2)
  })
})
