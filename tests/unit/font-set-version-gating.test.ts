import { describe, it, expect } from 'vitest'
import { deriveFontStatus, FONT_SET_VERSION } from '../../src/shared/fonts'

/**
 * REQ-0275 §3 / REQ-0276 §2 — the recorded-set-version gating is the
 * safeguard that forces v1.3.5 users to re-download the font set after
 * upgrading to v1.3.6.  Without it, the stale upstream-named `fonts-v1`
 * files on their disk would be picked up as `installed` but libass
 * would fail to match `MOJIOKO Noto Sans JP <Weight>` against the
 * files' internal `Noto Sans JP` name table → weight-collapse via
 * system-font fallback (the RES-0274 blocker recurring by a different
 * route).
 *
 * These tests pin the four decision matrix corners of `deriveFontStatus`
 * so any accidental relaxation of the gate surfaces immediately in CI.
 */
describe('deriveFontStatus — recorded-set-version gating', () => {
  it('bundled fonts are ALWAYS reported bundled, regardless of setIsCurrent', () => {
    // Free-tier users only see bundled Noto weights; they must never be
    // affected by the recorded-set-version stamp (they ship in the
    // installer and stay in sync with FONT_SET_VERSION by definition).
    expect(deriveFontStatus(true, true,  true )).toBe('bundled')
    expect(deriveFontStatus(true, true,  false)).toBe('bundled')
    expect(deriveFontStatus(true, false, true )).toBe('bundled')
    expect(deriveFontStatus(true, false, false)).toBe('bundled')
  })

  it('installed non-bundled font counts as installed only when setIsCurrent is true', () => {
    expect(deriveFontStatus(false, true, true )).toBe('installed')
    // The critical case — files exist BUT the recorded set version is
    // stale.  Must report not-installed so the picker prompts a
    // re-download.  This is where the RES-0274 recurrence would slip
    // through if the gate is broken.
    expect(deriveFontStatus(false, true, false)).toBe('not-installed')
  })

  it('non-installed non-bundled font is always not-installed', () => {
    expect(deriveFontStatus(false, false, true )).toBe('not-installed')
    expect(deriveFontStatus(false, false, false)).toBe('not-installed')
  })
})

describe('recordedSetVersion → setIsCurrent mapping (integration-level intent)', () => {
  // These aren't testing `deriveFontStatus` directly — they document
  // and pin the caller-side rule (`setIsCurrent = recordedSetVersion
  // === FONT_SET_VERSION`) that buildFontsState in font-downloader.ts
  // uses to feed the helper above.  Written as data-driven checks so a
  // future FONT_SET_VERSION bump automatically re-verifies the
  // migration path.

  const currentVersion = FONT_SET_VERSION

  // Mirrors the buildFontsState logic.
  const isSetCurrent = (recorded: number | undefined) => recorded === currentVersion

  it('undefined (pre-REQ-0275 install / v1.3.5 upgrade) → NOT current', () => {
    expect(isSetCurrent(undefined)).toBe(false)
    // → deriveFontStatus(false, true, false) === 'not-installed'
    // Existing fonts-v1 files would be flagged as stale, forcing a
    // re-download.  This is REQ-0275 §3-1's "既存ユーザー保護" case.
    expect(deriveFontStatus(false, true, isSetCurrent(undefined))).toBe('not-installed')
  })

  it('older recorded value (e.g. 1 or 2) → NOT current', () => {
    for (const older of [0, 1, 2]) {
      if (older >= currentVersion) continue  // skip if FONT_SET_VERSION was bumped past 2 in the future
      expect(isSetCurrent(older)).toBe(false)
      expect(deriveFontStatus(false, true, isSetCurrent(older))).toBe('not-installed')
    }
  })

  it('exact match with FONT_SET_VERSION → current', () => {
    expect(isSetCurrent(currentVersion)).toBe(true)
    expect(deriveFontStatus(false, true, isSetCurrent(currentVersion))).toBe('installed')
  })

  it('future value (hypothetical, e.g. current+1) → NOT current (defensive)', () => {
    // A recorded value greater than FONT_SET_VERSION is nonsensical in
    // practice (settings.json can only be written by a MOJIOKO version
    // whose FONT_SET_VERSION was ≤ that value at the time), but a
    // deliberate downgrade / hand-edit is possible.  The stricter
    // "===" gate treats future values as not-current too, which is the
    // safer default (a re-download prompt is better than pretending a
    // future-format set is compatible).
    expect(isSetCurrent(currentVersion + 1)).toBe(false)
    expect(deriveFontStatus(false, true, isSetCurrent(currentVersion + 1))).toBe('not-installed')
  })
})

describe('bundled Noto weights survive every recordedSetVersion scenario (free-tier protection)', () => {
  // The three bundled Noto weights (Regular / Medium / SemiBold) must
  // remain fully usable for free-tier users no matter what.  Their
  // `bundled: true` bypasses the gate entirely — this test pins that
  // invariant across the full recordedSetVersion domain so a future
  // "let's tighten this to force everyone to re-download" refactor
  // can't silently regress the free-tier UX.
  const scenarios: Array<number | undefined> = [undefined, 0, 1, 2, FONT_SET_VERSION, FONT_SET_VERSION + 1]
  const isSetCurrent = (v: number | undefined) => v === FONT_SET_VERSION

  for (const recorded of scenarios) {
    it(`recordedSetVersion=${recorded === undefined ? 'undefined' : recorded}: bundled=true, installed=true → bundled`, () => {
      expect(deriveFontStatus(true, true, isSetCurrent(recorded))).toBe('bundled')
    })
    it(`recordedSetVersion=${recorded === undefined ? 'undefined' : recorded}: bundled=true, installed=false → bundled (defensive)`, () => {
      // Even if the bundled TTF file were somehow missing on disk
      // (corrupt installer, user deleted it), the status stays
      // 'bundled' because `checkFontInstalled(bundled).bundled` is
      // sourced from the registry, not the disk check.  Callers
      // treat 'bundled' as "always available"; downstream code
      // (font-metrics, ass-generator) will fail loudly if the file
      // is actually missing.
      expect(deriveFontStatus(true, false, isSetCurrent(recorded))).toBe('bundled')
    })
  }
})
