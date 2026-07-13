/**
 * REQ-0208 — pure predicate for the Store review CTA row in the export-
 * complete dialog.
 *
 * Extracted from `burnin-drawer.tsx` so the visibility contract is:
 *   1. only surfaced in the MSIX (paid) build — the review target is the
 *      Microsoft Store listing, and NSIS users cannot post there
 *   2. one-shot — hidden after the button has been clicked at least once,
 *      even across restarts (persistence lives in the settings store)
 *   3. hidden while the tier signal is still resolving (`isMsix === null`)
 *      so we do NOT flash the row for one frame on paint before the IPC
 *      returns
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
  /**
   * Persisted flag from the settings store.  Flips false → true the first
   * time the user clicks the CTA (in-app, in this dialog).  Never flips
   * back — see `settings-store.markStoreReviewClicked`.
   */
  hasClickedStoreReview: boolean
}

export function shouldShowStoreReviewRow(input: StoreReviewVisibilityInput): boolean {
  if (input.isMsix !== true) return false
  if (input.hasClickedStoreReview) return false
  return true
}
