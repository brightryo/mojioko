import { describe, it, expect } from 'vitest'
import {
  deriveFamilyStatus,
  getFontFamilies,
  FONT_REGISTRY,
  FONT_SET_VERSION,
  type FontFamily,
  type FontId,
} from '../../src/shared/fonts'

/**
 * REQ-0281 §3 / §4-2 — pins the family-level binary status model.
 *
 * Semantics:
 *   1. Bundled families (Noto Sans JP) → ALWAYS `'bundled'`, regardless
 *      of on-disk state of individual weights or the recorded set
 *      version.  Bundled Noto weights ship in the installer payload
 *      and cannot be uninstalled, so from the picker's perspective the
 *      family is always available.
 *   2. Non-bundled families → `'installed'` only when EVERY weight is
 *      present on disk AND the recorded set version matches
 *      `FONT_SET_VERSION`.  Any missing weight OR a stale version
 *      collapses the family to `'not-installed'`.
 *   3. No intermediate state — matches the REQ's "0 or 1" model.  This
 *      is enforced by test cases below covering partial-download,
 *      version-mismatch, and free-tier scenarios.
 *
 * The RES-0276 existing-user protection lives in the same setIsCurrent
 * gate the recorded-set-version test suite already pins.  This file
 * complements those tests by exercising the family-aggregation layer
 * on top of that gate.
 */

// Convenience for tests: build a fake "installed" set from FontIds.
function installedChecker(installedIds: readonly FontId[]) {
  const set = new Set<FontId>(installedIds)
  return (id: FontId) => set.has(id)
}

// Pull real registry families for the tests so a future weight
// addition automatically flows in (rather than a hand-maintained
// constant that would drift).
const families = getFontFamilies()
const notoFamily = families.find((f) => f.cssFontFamily === 'MOJIOKO Noto Sans JP')!
const poppinsFamily = families.find((f) => f.cssFontFamily === 'MOJIOKO Poppins')!
const dgFamily = families.find((f) => f.cssFontFamily === 'MOJIOKO Dela Gothic One')!

// Every non-bundled weight in the registry — the maximum-fill on-disk
// state.  Recomputed from the registry so REQ-added weights land in
// the test automatically.
const ALL_DOWNLOADABLE = FONT_REGISTRY.filter((m) => !m.bundled).map((m) => m.id)

describe('deriveFamilyStatus — bundled family (Noto Sans JP)', () => {
  it('bundled family is ALWAYS "bundled" regardless of setIsCurrent', () => {
    expect(deriveFamilyStatus(notoFamily, () => false, false)).toBe('bundled')
    expect(deriveFamilyStatus(notoFamily, () => true,  false)).toBe('bundled')
    expect(deriveFamilyStatus(notoFamily, () => false, true )).toBe('bundled')
    expect(deriveFamilyStatus(notoFamily, () => true,  true )).toBe('bundled')
  })

  it('confirms the Noto family really is treated as bundled (at least one weight is bundled)', () => {
    // If this ever breaks it means the registry stopped shipping bundled
    // Noto weights — which would be a separate breaking change that
    // needs its own REQ, not a silent regression here.
    expect(notoFamily.hasBundledWeight).toBe(true)
  })
})

describe('deriveFamilyStatus — non-bundled family, binary rules', () => {
  it('every weight installed + setIsCurrent → "installed"', () => {
    const isInstalled = installedChecker(poppinsFamily.weights.map((w) => w.fontId))
    expect(deriveFamilyStatus(poppinsFamily, isInstalled, true)).toBe('installed')
  })

  it('every weight installed BUT setIsCurrent=false → "not-installed" (REQ-0276 gate wins)', () => {
    // v1.3.5-upgrader scenario: files are on disk but the stamp is
    // stale (or absent).  The whole family reports not-installed so
    // the batch DL prompts a fresh fetch.
    const isInstalled = installedChecker(poppinsFamily.weights.map((w) => w.fontId))
    expect(deriveFamilyStatus(poppinsFamily, isInstalled, false)).toBe('not-installed')
  })

  it('one weight missing + setIsCurrent → "not-installed" (partial install)', () => {
    // Simulate a partial batch DL: N-1 weights are on disk, the last
    // one never landed.  The family reports not-installed because the
    // REQ-0281 binary model has no "partial" third state.  Cancel-all-
    // delete elsewhere in the flow is meant to prevent this state
    // from persisting, but the derivation must be defensive.
    const partial = poppinsFamily.weights.slice(0, -1).map((w) => w.fontId)
    const isInstalled = installedChecker(partial)
    expect(deriveFamilyStatus(poppinsFamily, isInstalled, true)).toBe('not-installed')
  })

  it('no weight installed + setIsCurrent → "not-installed"', () => {
    expect(deriveFamilyStatus(poppinsFamily, () => false, true)).toBe('not-installed')
  })

  it('no weight installed + setIsCurrent=false → "not-installed"', () => {
    expect(deriveFamilyStatus(poppinsFamily, () => false, false)).toBe('not-installed')
  })

  it('single-weight family (Dela Gothic One) works the same way', () => {
    const isInstalled = installedChecker([dgFamily.weights[0].fontId])
    expect(deriveFamilyStatus(dgFamily, isInstalled, true)).toBe('installed')
    expect(deriveFamilyStatus(dgFamily, isInstalled, false)).toBe('not-installed')
    expect(deriveFamilyStatus(dgFamily, () => false, true)).toBe('not-installed')
  })
})

describe('deriveFamilyStatus — full-registry aggregate scenarios', () => {
  it('fresh install: nothing on disk, no stamp → every non-bundled family is not-installed', () => {
    const noInstalls = installedChecker([])
    for (const f of families) {
      const expected = f.hasBundledWeight ? 'bundled' : 'not-installed'
      expect(deriveFamilyStatus(f, noInstalls, false)).toBe(expected)
    }
  })

  it('post-batch-DL: every weight on disk + stamp=current → every non-bundled family is installed, Noto stays bundled', () => {
    const allInstalled = installedChecker(ALL_DOWNLOADABLE)
    for (const f of families) {
      const expected = f.hasBundledWeight ? 'bundled' : 'installed'
      expect(deriveFamilyStatus(f, allInstalled, true)).toBe(expected)
    }
  })

  it('v1.3.5 → v1.3.6 upgrade: files on disk but stamp is absent → every non-bundled family flips to not-installed', () => {
    // The exact scenario RES-0276 was designed to catch.  The
    // fontSetInstalledVersion is undefined (setIsCurrent=false) so
    // even though the fonts-v1 bytes are still on disk, the family
    // aggregation must report not-installed and prompt a batch DL.
    const allInstalled = installedChecker(ALL_DOWNLOADABLE)
    for (const f of families) {
      if (f.hasBundledWeight) continue
      expect(deriveFamilyStatus(f, allInstalled, false)).toBe('not-installed')
    }
  })

  it('outdated stamp (recorded < FONT_SET_VERSION): setIsCurrent is false → not-installed', () => {
    // The caller computes `setIsCurrent = recordedSetVersion ===
    // FONT_SET_VERSION`, so any non-matching value (undefined, 1, 2, or
    // even a hypothetical future value) drives this to false.  We
    // don't retest the equality here; we just prove deriveFamilyStatus
    // routes correctly on the boolean it receives.
    const allInstalled = installedChecker(ALL_DOWNLOADABLE)
    for (const older of [FONT_SET_VERSION - 2, FONT_SET_VERSION - 1]) {
      if (older < 0) continue
      const setIsCurrent = older === FONT_SET_VERSION
      expect(setIsCurrent).toBe(false)
      for (const f of families) {
        if (f.hasBundledWeight) continue
        expect(deriveFamilyStatus(f, allInstalled, setIsCurrent)).toBe('not-installed')
      }
    }
  })
})

describe('family list has exactly 13 rows (12 additional + Noto) — REQ-0281 §3', () => {
  it('confirms the family count matches the marketing claim of 12 additional fonts', () => {
    // Owner-approved (REQ-0281 §3): Noto is shown as one family row too,
    // so the total is 12 (additional families) + 1 (Noto).  If the
    // registry adds or removes a family, THIS test bumps and the
    // marketing count needs the same bump.
    expect(families.length).toBe(13)
    // Confirm Noto is exactly one of them
    const bundledFamilies = families.filter((f) => f.hasBundledWeight)
    expect(bundledFamilies.length).toBe(1)
    expect(bundledFamilies[0].cssFontFamily).toBe('MOJIOKO Noto Sans JP')
    // The other 12 are the downloadable families
    const additional = families.filter((f) => !f.hasBundledWeight)
    expect(additional.length).toBe(12)
  })
})

// Type export so the module isn't a "no-value-import" TS diagnostic in
// strict builds when FontFamily is only referenced in comments above.
const _typeSanityCheck: FontFamily | undefined = undefined
void _typeSanityCheck
