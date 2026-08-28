import { describe, it, expect } from 'vitest'
import { canSelectFontInTier, canDownloadFontInTier } from '../../src/shared/font-tier'
import {
  FONT_REGISTRY,
  DEFAULT_FONT_ID,
  getFontFamilies,
  getFontMeta,
  isBundledFamilyFontId,
  selectableFamilies,
  selectableWeightsForFamily,
  type FontId,
} from '../../src/shared/fonts'

/**
 * REQ-0353 — where the free edition ends and the paid edition begins.
 *
 * The owner widened the free tier from ONE weight (`DEFAULT_FONT_ID`) to the
 * whole bundled Noto Sans JP family, and the six previously download-only
 * weights are now shipped in the installer.  After that change the paid
 * edition has exactly one differentiator left: **the twelve additional
 * families**.
 *
 * So that boundary is the thing this file guards, from both sides:
 *
 *   1. the free edition can select every Noto Sans JP weight — otherwise the
 *      change did not actually land; and
 *   2. the free edition can select NOTHING else — this is the paid product,
 *      and a leak here gives it away.
 *
 * (2) matters more than (1) and is asserted over the registry rather than a
 * list, so a family added later is locked by default instead of being
 * accidentally free.
 */
const BUNDLED_FAMILY = getFontMeta(DEFAULT_FONT_ID).cssFontFamily
const NOTO_WEIGHTS = FONT_REGISTRY.filter((m) => m.cssFontFamily === BUNDLED_FAMILY)
const OTHER_FAMILIES = FONT_REGISTRY.filter((m) => m.cssFontFamily !== BUNDLED_FAMILY)
const everythingOnDisk = (): boolean => true

describe('REQ-0353 — the free edition gets the whole bundled family', () => {
  it('ships all nine Noto Sans JP weights in the installer', () => {
    // The gate would be meaningless if the files were not there: the user
    // could pick Black and get nothing.  `bundled` is what puts a file in
    // `extraResources`, so it is the honest thing to assert.
    expect(NOTO_WEIGHTS).toHaveLength(9)
    const notBundled = NOTO_WEIGHTS.filter((m) => !m.bundled).map((m) => m.id)
    expect(notBundled, 'every Noto weight must ship, not be downloaded').toEqual([])
  })

  it('offers every Noto weight in the free tier, including Bold and Black', () => {
    for (const meta of NOTO_WEIGHTS) {
      expect(canSelectFontInTier(false, meta.id), `${meta.id} selectable in free tier`).toBe(true)
    }
    // Named explicitly: these two are the reason the REQ exists — the owner
    // wanted heavy subtitles, and they were the weights the free tier lacked.
    expect(canSelectFontInTier(false, 'noto-sans-jp-bold' as FontId)).toBe(true)
    expect(canSelectFontInTier(false, 'noto-sans-jp-black' as FontId)).toBe(true)
  })

  it('shows all nine in the weight dropdown, offline', () => {
    const noto = getFontFamilies().find((f) => f.cssFontFamily === BUNDLED_FAMILY)
    expect(noto, 'the bundled family is in the family list').toBeDefined()
    const weights = selectableWeightsForFamily(noto!, everythingOnDisk, false)
    expect(weights).toHaveLength(9)
  })
})

describe('REQ-0353 — the twelve additional families stay paid-only', () => {
  it('locks every non-bundled family in the free tier', () => {
    const leaked = OTHER_FAMILIES
      .filter((m) => canSelectFontInTier(false, m.id))
      .map((m) => m.id)
    expect(leaked, 'these paid fonts became selectable in the free edition').toEqual([])
  })

  it('offers exactly one family in the free-tier family list', () => {
    const families = selectableFamilies(getFontFamilies(), everythingOnDisk, false)
    expect(families.map((f) => f.cssFontFamily)).toEqual([BUNDLED_FAMILY])
  })

  it('locks the two rare-kanji families by name (they are the ones users ask for)', () => {
    for (const id of ['hachi-maru-pop', 'potta-one'] as FontId[]) {
      expect(canSelectFontInTier(false, id), `${id} must stay paid-only`).toBe(false)
    }
  })

  it('counts twelve locked families, matching what the store page promises', () => {
    const lockedFamilies = new Set(OTHER_FAMILIES.map((m) => m.cssFontFamily))
    expect(lockedFamilies.size, 'the paid edition advertises 12 additional fonts').toBe(12)
  })

  it('still refuses to DOWNLOAD anything in the free tier', () => {
    // Widening selection must not widen downloading: the free edition now has
    // no reason to fetch anything, since its whole family ships with it.
    for (const meta of FONT_REGISTRY) {
      expect(canDownloadFontInTier(false, meta.id), `${meta.id}`).toBe(false)
    }
  })

  /**
   * REQ-0511 L2 — a real control now.
   *
   * It used to define `brokenGate = () => true` and assert that it leaks, which
   * is true of any function returning `true` and touched no product code. The
   * version below runs the SAME boundary check twice — once with the real
   * predicate, once with the broken one — so it states the thing that matters:
   * this check distinguishes them. Swap the real gate for the broken one and
   * the first expectation fails.
   */
  it('NEGATIVE CONTROL — the boundary check separates the real gate from a broken one', () => {
    const leakedUnder = (gate: (isMsix: boolean, id: FontId) => boolean): FontId[] =>
      OTHER_FAMILIES.filter((m) => gate(false, m.id)).map((m) => m.id)

    expect(leakedUnder(canSelectFontInTier), 'the real gate must leak nothing in the free tier').toEqual([])
    expect(
      leakedUnder(() => true).length,
      'a gate that forgets the family check must leak — otherwise the assertion above is vacuous',
    ).toBe(OTHER_FAMILIES.length)
  })

  it('NEGATIVE CONTROL — the predicate itself rejects a non-bundled family', () => {
    expect(isBundledFamilyFontId(DEFAULT_FONT_ID)).toBe(true)
    expect(isBundledFamilyFontId('anton' as FontId)).toBe(false)
  })
})
