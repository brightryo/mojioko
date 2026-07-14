import { describe, it, expect } from 'vitest'
import { shouldShowStoreReviewRow } from '../../src/renderer/lib/store-review-visibility'

/**
 * REQ-0208 / REQ-0211 — the Store review CTA row visibility contract.
 *
 * The predicate is small (one input collapsing to a boolean), but the
 * failure modes are ugly:
 *
 *   - "shown in the NSIS build" → the button opens a Store URL only a
 *     Store customer can use.  Confuses free users
 *   - "flashes for one frame on paint" → isMsix null during the boot IPC.
 *     Users report "did I see the button? did I not?"
 *
 * REQ-0211 dropped the "hide after one click" rule; the row now stays
 * up in MSIX regardless of click history, and `burnin-drawer.tsx` swaps
 * the CTA wording based on `hasClickedStoreReview`.  This unit test
 * only covers the tier-gate half of the contract; the wording swap is
 * exercised at the component level.
 *
 * The truth table below pins the answer for every input combination so
 * a future refactor cannot accidentally regress any of them.
 */

describe('shouldShowStoreReviewRow (REQ-0211 truth table)', () => {
  it('hides when isMsix is null (IPC still resolving)', () => {
    // The default state at app boot.  Row must NOT render before the
    // tier signal settles, or paid-tier UI briefly appears for free
    // users (and vice versa).
    expect(shouldShowStoreReviewRow({ isMsix: null })).toBe(false)
  })

  it('hides in the NSIS build (free tier)', () => {
    // Free users cannot review on the Store.  Regardless of any client-
    // side state, the row must not surface in NSIS.
    expect(shouldShowStoreReviewRow({ isMsix: false })).toBe(false)
  })

  it('shows in the MSIX build (paid tier)', () => {
    // REQ-0211: the only positive case.  The wording swap for the
    // "already reviewed" state is handled by the component, not by
    // this predicate — visibility no longer depends on the click
    // history.
    expect(shouldShowStoreReviewRow({ isMsix: true })).toBe(true)
  })

  it('full truth table pin (defensive completeness)', () => {
    // All three rows spelled out end-to-end, so a diff that touches
    // the predicate is visually obvious in review even without
    // expanding every it() above.  REQ-0211 collapsed the 6-row REQ-
    // 0208 table to 3 rows by dropping `hasClickedStoreReview` from
    // the input.
    const cases: Array<{
      isMsix: boolean | null
      expected: boolean
    }> = [
      { isMsix: null,  expected: false },
      { isMsix: false, expected: false },
      { isMsix: true,  expected: true  },
    ]
    for (const c of cases) {
      expect(shouldShowStoreReviewRow({ isMsix: c.isMsix })).toBe(c.expected)
    }
  })
})
