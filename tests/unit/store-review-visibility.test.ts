import { describe, it, expect } from 'vitest'
import { shouldShowStoreReviewRow } from '../../src/renderer/lib/store-review-visibility'

/**
 * REQ-0208 — the Store review CTA row visibility contract.
 *
 * The predicate is small (three inputs collapsing to a boolean), but the
 * failure modes are ugly:
 *
 *   - "shown in the NSIS build" → the button opens a Store URL only a
 *     Store customer can use.  Confuses free users
 *   - "shown after the user has clicked once" → the app keeps nagging.
 *     Actively negative signal for review-score conversion
 *   - "flashes for one frame on paint" → isMsix null during the boot IPC.
 *     Users report "did I see the button?  did I not?"
 *
 * The truth table below pins the answer for every input combination so a
 * future refactor cannot accidentally regress any of them.
 */

describe('shouldShowStoreReviewRow', () => {
  it('hides when isMsix is null (IPC still resolving)', () => {
    // The default state at app boot.  Row must NOT render before the
    // tier signal settles, or paid-tier UI briefly appears for free
    // users (and vice versa).
    expect(shouldShowStoreReviewRow({ isMsix: null, hasClickedStoreReview: false })).toBe(false)
    expect(shouldShowStoreReviewRow({ isMsix: null, hasClickedStoreReview: true })).toBe(false)
  })

  it('hides in the NSIS build (free tier) regardless of click history', () => {
    // Free users cannot review on the Store.  The row must not surface
    // even in the (hypothetical) case where a user opened a project
    // originally created under the MSIX build with the click flag
    // already set.
    expect(shouldShowStoreReviewRow({ isMsix: false, hasClickedStoreReview: false })).toBe(false)
    expect(shouldShowStoreReviewRow({ isMsix: false, hasClickedStoreReview: true })).toBe(false)
  })

  it('shows in the MSIX build when the user has never clicked', () => {
    // The single positive case.  All other cells of the truth table
    // resolve to false.
    expect(shouldShowStoreReviewRow({ isMsix: true, hasClickedStoreReview: false })).toBe(true)
  })

  it('hides in the MSIX build after the user has clicked once', () => {
    // The one-shot contract.  Once true, always true — the settings
    // store has no path back to false, and this test guarantees the
    // dialog respects that.
    expect(shouldShowStoreReviewRow({ isMsix: true, hasClickedStoreReview: true })).toBe(false)
  })

  it('full truth table pin (defensive completeness)', () => {
    // Same six rows spelled out end-to-end, so a diff that touches the
    // predicate is visually obvious in review even without expanding
    // every it() above.
    const cases: Array<{
      isMsix: boolean | null
      hasClickedStoreReview: boolean
      expected: boolean
    }> = [
      { isMsix: null,  hasClickedStoreReview: false, expected: false },
      { isMsix: null,  hasClickedStoreReview: true,  expected: false },
      { isMsix: false, hasClickedStoreReview: false, expected: false },
      { isMsix: false, hasClickedStoreReview: true,  expected: false },
      { isMsix: true,  hasClickedStoreReview: false, expected: true  },
      { isMsix: true,  hasClickedStoreReview: true,  expected: false },
    ]
    for (const c of cases) {
      expect(shouldShowStoreReviewRow({
        isMsix: c.isMsix,
        hasClickedStoreReview: c.hasClickedStoreReview,
      })).toBe(c.expected)
    }
  })
})
