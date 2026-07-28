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

  it('REQ-0338 §2 — orders families by NAME, case-insensitively', () => {
    // The pickers moved off `getSortedFontRegistry` in REQ-0275 / REQ-0281 and
    // nothing carried the sort across, so `FONT_REGISTRY`'s hand-authored
    // order (bundled Noto, then the Japanese display faces, then the Latin
    // ones) leaked into the UI and read as a language grouping.  Nothing
    // pinned the order, which is why it drifted silently — this is that pin.
    const names = families.map((f) => f.cssFontFamily.replace(/^MOJIOKO /, ''))
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })))
    // Concretely, and in particular NOT with the default pinned to the top.
    expect(names[0]).toBe('Anton')
    expect(names).toContain('Noto Sans JP')
    expect(names.indexOf('Noto Sans JP')).toBeGreaterThan(0)
  })

  it('collapses per-weight entries into one entry per unique cssFontFamily', () => {
    const registryFamilies = new Set(FONT_REGISTRY.map((f) => f.cssFontFamily))
    expect(families).toHaveLength(registryFamilies.size)
  })

  it('groups all 9 Noto Sans JP weight FontIds under one family', () => {
    const noto = families.find((f) => f.cssFontFamily === 'MOJIOKO Noto Sans JP')
    expect(noto).toBeDefined()
    expect(noto!.hasMultipleWeights).toBe(true)
    expect(noto!.hasBundledWeight).toBe(true)
    expect(noto!.weights.map((w) => w.weight)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900])
    expect(noto!.defaultFontId).toBe('noto-sans-jp-semibold')
  })

  it('groups all 9 Poppins weight FontIds under one family', () => {
    const poppins = families.find((f) => f.cssFontFamily === 'MOJIOKO Poppins')
    expect(poppins).toBeDefined()
    expect(poppins!.hasMultipleWeights).toBe(true)
    expect(poppins!.hasBundledWeight).toBe(false)
    expect(poppins!.weights.map((w) => w.weight)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900])
    expect(poppins!.defaultFontId).toBe('poppins-bold')
  })

  it('marks single-weight families with hasMultipleWeights=false', () => {
    for (const fam of families) {
      if (['MOJIOKO Noto Sans JP', 'MOJIOKO Poppins'].includes(fam.cssFontFamily)) continue
      expect(fam.hasMultipleWeights).toBe(false)
      expect(fam.weights).toHaveLength(1)
    }
  })
})

describe('getFamilyDefaultFontId', () => {
  it('returns SemiBold for MOJIOKO Noto Sans JP (REQ-0269 B-5)', () => {
    expect(getFamilyDefaultFontId('MOJIOKO Noto Sans JP')).toBe('noto-sans-jp-semibold')
  })
  it('returns Bold for MOJIOKO Poppins (REQ-0269 B-5)', () => {
    expect(getFamilyDefaultFontId('MOJIOKO Poppins')).toBe('poppins-bold')
  })
  it('returns the only registered FontId for single-weight families', () => {
    expect(getFamilyDefaultFontId('MOJIOKO Anton')).toBe('anton')
    expect(getFamilyDefaultFontId('MOJIOKO Dela Gothic One')).toBe('dela-gothic-one')
    expect(getFamilyDefaultFontId('MOJIOKO Montserrat')).toBe('montserrat')
  })
  it('falls back to DEFAULT_FONT_ID for unknown families', () => {
    expect(getFamilyDefaultFontId('This Family Does Not Exist')).toBe(DEFAULT_FONT_ID)
  })
})

describe('getFontIdForFamilyAndWeight', () => {
  it('maps a Noto weight to its specific FontId', () => {
    expect(getFontIdForFamilyAndWeight('MOJIOKO Noto Sans JP', 100)).toBe('noto-sans-jp-thin')
    expect(getFontIdForFamilyAndWeight('MOJIOKO Noto Sans JP', 400)).toBe('noto-sans-jp-regular')
    expect(getFontIdForFamilyAndWeight('MOJIOKO Noto Sans JP', 900)).toBe('noto-sans-jp-black')
  })
  it('maps a Poppins weight to its specific FontId (Regular keeps the legacy `poppins` id)', () => {
    expect(getFontIdForFamilyAndWeight('MOJIOKO Poppins', 400)).toBe('poppins')
    expect(getFontIdForFamilyAndWeight('MOJIOKO Poppins', 700)).toBe('poppins-bold')
  })
  it('falls back to the family default when the weight is not registered', () => {
    // MOJIOKO Poppins has no weight 450 registered — should fall back to Bold (the default).
    expect(getFontIdForFamilyAndWeight('MOJIOKO Poppins', 450)).toBe('poppins-bold')
  })
})

describe('resolveRenderableFontId (REQ-0269 D-1 fallback)', () => {
  const bundled = new Set<FontId>([
    'noto-sans-jp-regular',
    'noto-sans-jp-medium',
    'noto-sans-jp-semibold',
  ])
  const isInstalled = (id: FontId) => bundled.has(id)
  // REQ-0273 §8 — `isSelectable` is required.  These fallback tests only
  // exercise the install-side ladder, so `() => true` is passed
  // explicitly to make the "tier is not being tested here" intent
  // visible.
  const allSelectable = () => true

  it('returns the requested id when it is installed', () => {
    expect(resolveRenderableFontId('noto-sans-jp-semibold', isInstalled, allSelectable)).toBe('noto-sans-jp-semibold')
  })

  it('falls back to the nearest installed same-family weight', () => {
    // Requested 700 (Bold), installed [400, 500, 600] → nearest is 600 (SemiBold).
    expect(resolveRenderableFontId('noto-sans-jp-bold', isInstalled, allSelectable)).toBe('noto-sans-jp-semibold')
    // Requested 100 (Thin), installed [400, 500, 600] → nearest is 400 (Regular).
    expect(resolveRenderableFontId('noto-sans-jp-thin', isInstalled, allSelectable)).toBe('noto-sans-jp-regular')
    // Requested 500 (Medium — installed) → returns itself, not a substitute.
    expect(resolveRenderableFontId('noto-sans-jp-medium', isInstalled, allSelectable)).toBe('noto-sans-jp-medium')
  })

  it('falls back to DEFAULT_FONT_ID when no same-family weight is installed', () => {
    // Requested Poppins Bold; nothing Poppins is installed → Noto SemiBold.
    expect(resolveRenderableFontId('poppins-bold', isInstalled, allSelectable)).toBe(DEFAULT_FONT_ID)
    // Requested Anton; not installed → Noto SemiBold.
    expect(resolveRenderableFontId('anton', isInstalled, allSelectable)).toBe(DEFAULT_FONT_ID)
  })

  it('picks the same family in preference to Noto when at least one family weight is installed', () => {
    const withPoppinsRegular = new Set<FontId>([
      'noto-sans-jp-semibold',
      'poppins',
    ])
    // Requested Poppins Bold; Poppins Regular is installed → prefer Poppins Regular over Noto.
    expect(resolveRenderableFontId('poppins-bold', (id) => withPoppinsRegular.has(id), allSelectable)).toBe('poppins')
  })

  it('does not depend on FONT_REGISTRY mutation — returns pure result', () => {
    const before = FONT_REGISTRY.map((f) => f.id)
    resolveRenderableFontId('poppins-black', isInstalled, allSelectable)
    expect(FONT_REGISTRY.map((f) => f.id)).toEqual(before)
  })
})

describe('resolveRenderableFontId — tier gating (REQ-0270 §2)', () => {
  // Simulate the free-tier reality: every Noto Sans JP weight TTF is
  // physically shipped (Regular / Medium / SemiBold are bundled), but
  // only DEFAULT_FONT_ID is selectable in the free tier.  This mirrors
  // canSelectFontInTier(false, id) === (id === DEFAULT_FONT_ID).
  const freeTierInstalled = new Set<FontId>([
    'noto-sans-jp-regular',
    'noto-sans-jp-medium',
    'noto-sans-jp-semibold',
  ])
  const isInstalledFree = (id: FontId) => freeTierInstalled.has(id)
  const isSelectableFree = (id: FontId) => id === DEFAULT_FONT_ID

  it('free tier — requesting DEFAULT_FONT_ID returns DEFAULT_FONT_ID', () => {
    expect(
      resolveRenderableFontId(DEFAULT_FONT_ID, isInstalledFree, isSelectableFree)
    ).toBe(DEFAULT_FONT_ID)
  })

  it('free tier — requesting a bundled-but-tier-locked weight falls back to DEFAULT_FONT_ID (not to Noto Regular / Medium)', () => {
    // Regular is bundled AND same family AND closer to requested Bold(700) than SemiBold(600).
    // Pre-REQ-0270 would have returned 'noto-sans-jp-medium' (500 is the closest installed).
    // With tier gating, only DEFAULT_FONT_ID (SemiBold) is selectable → it wins the fallback.
    expect(
      resolveRenderableFontId('noto-sans-jp-bold', isInstalledFree, isSelectableFree)
    ).toBe(DEFAULT_FONT_ID)
    // Requesting Regular itself also lands on the default — Regular is installed
    // but not selectable in the free tier.
    expect(
      resolveRenderableFontId('noto-sans-jp-regular', isInstalledFree, isSelectableFree)
    ).toBe(DEFAULT_FONT_ID)
    // Every one of the 9 Noto weights should end up at DEFAULT_FONT_ID in the free tier.
    const allNotoWeights: FontId[] = [
      'noto-sans-jp-thin', 'noto-sans-jp-extralight', 'noto-sans-jp-light',
      'noto-sans-jp-regular', 'noto-sans-jp-medium', 'noto-sans-jp-semibold',
      'noto-sans-jp-bold', 'noto-sans-jp-extrabold', 'noto-sans-jp-black',
    ]
    for (const id of allNotoWeights) {
      expect(
        resolveRenderableFontId(id, isInstalledFree, isSelectableFree)
      ).toBe(DEFAULT_FONT_ID)
    }
  })

  it('free tier — Poppins / Anton / Bebas Neue all fall back to DEFAULT_FONT_ID', () => {
    for (const id of ['poppins', 'poppins-bold', 'anton', 'bebas-neue', 'montserrat'] as FontId[]) {
      expect(
        resolveRenderableFontId(id, isInstalledFree, isSelectableFree)
      ).toBe(DEFAULT_FONT_ID)
    }
  })

  it('paid tier — behaviour matches the pre-tier "isInstalled only" ladder', () => {
    // Selectability is `true` for everything in the paid tier, so the
    // fallback should be identical to the two-argument form.
    const isInstalledPaid = (id: FontId) => freeTierInstalled.has(id) // narrow install set for testing
    const isSelectablePaid = () => true
    // Requested Bold(700), only 400/500/600 installed → nearest is SemiBold(600).
    expect(
      resolveRenderableFontId('noto-sans-jp-bold', isInstalledPaid, isSelectablePaid)
    ).toBe('noto-sans-jp-semibold')
    // Requested Regular(400) — installed AND selectable → returns itself, NOT DEFAULT.
    expect(
      resolveRenderableFontId('noto-sans-jp-regular', isInstalledPaid, isSelectablePaid)
    ).toBe('noto-sans-jp-regular')
  })

  // REQ-0273 §8 removed the two-arg call site (default `() => true`
  // was fail-open).  The former "default preserves pre-REQ-0270"
  // test is dropped because the default no longer exists; the paid-
  // tier equivalent is covered by the "paid tier" test above.
})

describe('FONT_SET_VERSION', () => {
  it('is a positive integer', () => {
    expect(Number.isInteger(FONT_SET_VERSION)).toBe(true)
    expect(FONT_SET_VERSION).toBeGreaterThan(0)
  })
  it('is at least 3 (REQ-0275 bumped to v3 for MOJIOKO-namespaced family names)', () => {
    expect(FONT_SET_VERSION).toBeGreaterThanOrEqual(3)
  })
})
