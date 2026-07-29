import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FONT_ID,
  FONT_REGISTRY,
  getFontFamilies,
  selectableFamilies,
  selectableWeightsForFamily,
  type FontId,
} from '../../src/shared/fonts'
import { canSelectFontInTier } from '../../src/renderer/lib/font-tier'

/**
 * REQ-0282 — pins the free-tier weight/family gate for the
 * `FamilyWeightSelector` (settings > fonts > default picker,
 * timeline inspector, bulk-edit bar — all three consume the same
 * component, which delegates to `selectableFamilies` +
 * `selectableWeightsForFamily`).
 *
 * The invariant under scrutiny (REQ-0275 C-3):
 *   "無料版はウェイト機能なし。Noto Regular/Medium は登録するが
 *    無料版からは選択不可。"
 *
 * The risk RES-0281 flagged: the weight dropdown might filter
 * only on `installed.has(fontId)`, and because Noto Regular /
 * Medium / SemiBold are ALL bundled (on-disk = true), the free
 * tier would see three weights and be able to pick any of them —
 * violating C-3 and EULA §3.9 (tier feature gating bypass).
 *
 * Test strategy:
 *   1. Simulate the "everything on disk" case (bundled Noto weights
 *      exist + hypothetically every downloadable weight has landed
 *      too, so the tier gate is the ONLY thing that could hold the
 *      line).
 *   2. For NSIS, verify the family list = [Noto Sans JP] and the
 *      weight list under Noto = [SemiBold only].
 *   3. For MSIX, verify every family and every weight passes
 *      through (regression pin against a future refactor that
 *      accidentally over-filters).
 *   4. Cross-check that the inline policy in
 *      `selectableWeightsForFamily` produces the SAME outcome as
 *      the `canSelectFontInTier` renderer helper for every registered
 *      FontId — so if a future REQ changes either policy in
 *      isolation, this test breaks.
 */

const families = getFontFamilies()
const notoFamily = families.find((f) => f.cssFontFamily === 'MOJIOKO Noto Sans JP')!
const poppinsFamily = families.find((f) => f.cssFontFamily === 'MOJIOKO Poppins')!
const dgFamily = families.find((f) => f.cssFontFamily === 'MOJIOKO Dela Gothic One')!

/** Simulate the maximum-installed disk state: every registered weight
 *  is on disk (bundled naturally, downloaded weights hypothetically).
 *  This is the worst-case for the tier gate — if it's broken,
 *  everything leaks through. */
const everythingOnDisk = (_id: FontId): boolean => {
  void _id
  return true
}

/** Simulate the fresh-install case: only bundled Noto weights on
 *  disk, every downloadable weight missing. */
const bundledIds = new Set<FontId>(FONT_REGISTRY.filter((m) => m.bundled).map((m) => m.id))
const onlyBundledOnDisk = (id: FontId): boolean => bundledIds.has(id)

describe('REQ-0282 — free-tier weight gate (NSIS, isMsix=false)', () => {
  it('Noto Sans JP family, all weights on disk → EVERY weight is offered', () => {
    // REQ-0353 — the free tier now gets the whole bundled family.  Before it
    // got `DEFAULT_FONT_ID` alone, so this case asserted `[SemiBold]` and the
    // user could not even pick the Regular and Medium files already on disk.
    const weights = selectableWeightsForFamily(notoFamily, everythingOnDisk, false)
    expect(weights.map((w) => w.fontId)).toEqual(notoFamily.weights.map((w) => w.fontId))
    expect(weights.length).toBe(notoFamily.weights.length)
  })

  it('Noto Sans JP family, only bundled on disk → still every weight, because all nine ARE bundled', () => {
    // REQ-0353 bundled the six weights that used to be download-only, so for
    // this family the "bundled" and "everything" fixtures now agree.  That
    // agreement is the point worth pinning: it is what makes the free tier's
    // weight choice work OFFLINE, with no download step and no paid-tier
    // download gate involved.
    //
    // Before REQ-0353 this asserted `[SemiBold]` and its comment explained
    // that the tier gate, not the disk check, was what excluded Regular and
    // Medium.  Both halves of that changed: the gate now admits them, and the
    // disk check now finds all nine.
    const weights = selectableWeightsForFamily(notoFamily, onlyBundledOnDisk, false)
    expect(weights.map((w) => w.fontId)).toEqual(notoFamily.weights.map((w) => w.fontId))
    expect(weights.length, 'all nine Noto weights ship with every edition').toBe(9)
  })

  it('non-Noto family (Poppins), all weights on disk → weight list is empty', () => {
    // Poppins has no bundled weights, so every weight is tier-locked
    // in NSIS regardless of disk state.
    const weights = selectableWeightsForFamily(poppinsFamily, everythingOnDisk, false)
    expect(weights).toEqual([])
  })

  it('single-weight non-Noto family (Dela Gothic One), on disk → still filtered out', () => {
    const weights = selectableWeightsForFamily(dgFamily, everythingOnDisk, false)
    expect(weights).toEqual([])
  })

  it('family dropdown collapses to [Noto Sans JP] only', () => {
    // The `selectableFamilies` helper aggregates the per-family check.
    // NSIS + everything-on-disk still shows only Noto because every
    // other family has zero selectable weights under the tier gate.
    const selectable = selectableFamilies(families, everythingOnDisk, false)
    expect(selectable.map((f) => f.cssFontFamily)).toEqual(['MOJIOKO Noto Sans JP'])
  })

  it('family dropdown is [Noto Sans JP] even on fresh install (only bundled)', () => {
    const selectable = selectableFamilies(families, onlyBundledOnDisk, false)
    expect(selectable.map((f) => f.cssFontFamily)).toEqual(['MOJIOKO Noto Sans JP'])
  })
})

describe('REQ-0282 — paid-tier weight gate (MSIX, isMsix=true)', () => {
  it('Noto Sans JP family, all weights on disk → all 9 weights pass through', () => {
    // Regression pin: MSIX must not accidentally over-filter after
    // this REQ.  Every Noto weight in the registry should still
    // reach the dropdown when installed.
    const weights = selectableWeightsForFamily(notoFamily, everythingOnDisk, true)
    const registryNotoIds = FONT_REGISTRY
      .filter((m) => m.cssFontFamily === 'MOJIOKO Noto Sans JP')
      .map((m) => m.id)
    expect(weights.map((w) => w.fontId).sort()).toEqual(registryNotoIds.sort())
  })

  it('Noto family, only bundled on disk → only bundled weights pass', () => {
    // Downloadable Noto weights (Thin/Light/Bold/...) that are NOT on
    // disk should still be filtered out even in MSIX — the tier gate
    // opens the door, but the disk check keeps missing files out.
    const weights = selectableWeightsForFamily(notoFamily, onlyBundledOnDisk, true)
    const bundledNotoIds = FONT_REGISTRY
      .filter((m) => m.cssFontFamily === 'MOJIOKO Noto Sans JP' && m.bundled)
      .map((m) => m.id)
    expect(weights.map((w) => w.fontId).sort()).toEqual(bundledNotoIds.sort())
  })

  it('Poppins family, all weights on disk → every registered weight passes', () => {
    const weights = selectableWeightsForFamily(poppinsFamily, everythingOnDisk, true)
    const registryPoppinsIds = FONT_REGISTRY
      .filter((m) => m.cssFontFamily === 'MOJIOKO Poppins')
      .map((m) => m.id)
    expect(weights.map((w) => w.fontId).sort()).toEqual(registryPoppinsIds.sort())
  })

  it('family dropdown shows every family (13) when everything is on disk', () => {
    const selectable = selectableFamilies(families, everythingOnDisk, true)
    expect(selectable.length).toBe(families.length)  // 13 (12 additional + Noto)
  })

  it('family dropdown on fresh install → only Noto (only bundled family has any installed weight)', () => {
    // Even in MSIX, a fresh install with nothing downloaded surfaces
    // only Noto in the family dropdown — every other family has zero
    // installed weights, so `selectableWeightsForFamily` returns [].
    const selectable = selectableFamilies(families, onlyBundledOnDisk, true)
    expect(selectable.map((f) => f.cssFontFamily)).toEqual(['MOJIOKO Noto Sans JP'])
  })
})

describe('REQ-0282 — cross-check with canSelectFontInTier (single source of truth)', () => {
  it('inline policy in selectableWeightsForFamily matches canSelectFontInTier for every registry FontId (NSIS)', () => {
    // If a future REQ ever changes canSelectFontInTier's policy but
    // forgets to update the inline policy in selectableWeightsForFamily
    // (or vice versa), this test breaks and forces the fix.
    for (const meta of FONT_REGISTRY) {
      const runtimePolicy = canSelectFontInTier(false, meta.id)
      // The selector policy is implicit: "is this weight in the
      // selectableWeightsForFamily output?"  We reconstruct that by
      // asking the family that owns this weight.
      const family = families.find((f) => f.weights.some((w) => w.fontId === meta.id))!
      const selectable = selectableWeightsForFamily(family, everythingOnDisk, false)
      const selectorAllows = selectable.some((w) => w.fontId === meta.id)
      expect(selectorAllows).toBe(runtimePolicy)
    }
  })

  it('inline policy matches canSelectFontInTier for every registry FontId (MSIX)', () => {
    for (const meta of FONT_REGISTRY) {
      const runtimePolicy = canSelectFontInTier(true, meta.id)
      const family = families.find((f) => f.weights.some((w) => w.fontId === meta.id))!
      const selectable = selectableWeightsForFamily(family, everythingOnDisk, true)
      const selectorAllows = selectable.some((w) => w.fontId === meta.id)
      expect(selectorAllows).toBe(runtimePolicy)
    }
  })
})

describe('REQ-0282 — Noto bundled reality (documentation pin)', () => {
  it('confirms Noto Regular / Medium / SemiBold are all `bundled: true` in the registry', () => {
    // The whole reason this REQ exists — the free-tier gate must NOT
    // rely on "installed = false" to keep Regular/Medium out, because
    // they're bundled (installed = true) by construction.  If this
    // test ever breaks, the registry unbundled a Noto weight and the
    // tier-gate story needs re-review.
    const notoRegular = FONT_REGISTRY.find((m) => m.id === 'noto-sans-jp-regular')!
    const notoMedium = FONT_REGISTRY.find((m) => m.id === 'noto-sans-jp-medium')!
    const notoSemiBold = FONT_REGISTRY.find((m) => m.id === 'noto-sans-jp-semibold')!
    expect(notoRegular.bundled).toBe(true)
    expect(notoMedium.bundled).toBe(true)
    expect(notoSemiBold.bundled).toBe(true)
    expect(notoSemiBold.id).toBe(DEFAULT_FONT_ID)
  })
})
