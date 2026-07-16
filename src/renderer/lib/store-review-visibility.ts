/**
 * REQ-0208 / REQ-0211 — pure predicate for the Store review CTA row in
 * the export-complete dialog.
 *
 * Extracted from `burnin-drawer.tsx` so the visibility contract is:
 *   1. only surfaced in the MSIX (paid) build — the review target is the
 *      Microsoft Store listing, and NSIS users cannot post there
 *   2. hidden while the tier signal is still resolving (`isMsix === null`)
 *      so we do NOT flash the row for one frame on paint before the IPC
 *      returns
 *
 * REQ-0211 (2026-07-14) — removed the "hide after one click" rule from
 * REQ-0208.  The row now stays visible in MSIX indefinitely; the CTA
 * wording swaps between "please review" and "thanks — review again"
 * based on `hasClickedStoreReview` in the settings store.  The wording
 * swap lives in `burnin-drawer.tsx`; this predicate is now purely a
 * tier gate.  `hasClickedStoreReview` is deliberately no longer an
 * input here — visibility does not depend on it.
 *
 * Kept as a plain function (not a hook / not a memo) so the unit test in
 * `tests/unit/store-review-visibility.test.ts` can exhaust the truth
 * table without spinning up React.
 */

export interface StoreReviewVisibilityInput {
  /**
   * Result of the boot-time `isMsix()` IPC (via `useAppEnvStore`).  `null`
   * means the IPC has not returned yet — we treat that as "hide" so the
   * row cannot pop in-and-then-out during the first paint.
   */
  isMsix: boolean | null
}

export function shouldShowStoreReviewRow(input: StoreReviewVisibilityInput): boolean {
  return input.isMsix === true
}
