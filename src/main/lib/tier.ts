/**
 * REQ-0507 — the one place the main process decides which tier it is running as.
 *
 * ## Why this exists
 *
 * Tier was previously read ad hoc: `isPackagedAsMsix(getCurrentProcessContext())`
 * inlined at each site that cared. That was survivable while only karaoke and
 * emphasis consulted it, but REQ-0507 makes the render path enforce font tier,
 * and a rule enforced from several inlined reads is a rule that eventually
 * disagrees with itself.
 *
 * ## The dev problem this also solves
 *
 * `isPackagedAsMsix` is true only when `process.windowsStore === true` or
 * `execPath` sits under `\WindowsApps\`. Neither holds for `electron .`, so
 * **dev runs as FREE tier**, and there was no way to run as paid. That made two
 * things impossible:
 *
 *   1. The owner cannot exercise paid fonts while developing.
 *   2. A tier gate cannot be tested on BOTH sides. Testing only the "free tier
 *      is blocked" half would let the paid path break silently — the exact
 *      one-sided gate this project keeps rejecting.
 *
 * `MOJIOKO_FORCE_TIER=paid|free` fixes both. It is honoured **only when the app
 * is not packaged**, so it can never unlock a shipped build: a real NSIS or MSIX
 * install ignores the variable entirely. It is a development and test affordance,
 * not a licence bypass.
 */
import { app } from 'electron'
import { isPackagedAsMsix, getCurrentProcessContext } from './msix'

export type Tier = 'free' | 'paid'

/** The env var that overrides tier in unpackaged (dev/test) runs only. */
export const FORCE_TIER_ENV = 'MOJIOKO_FORCE_TIER'

export interface TierResolution {
  tier: Tier
  /** True when the paid feature set is available. */
  isPaid: boolean
  /** How the answer was reached — surfaced by `status` so it is never a guess. */
  source: 'msix' | 'not-packaged' | 'forced-dev-override'
}

/**
 * Decide the tier, with the reason.
 *
 * Pure over its inputs so tests can drive every branch without touching
 * `process` or `electron`.
 */
export function resolveTierFrom(opts: {
  isMsix: boolean
  isPackaged: boolean
  forceEnv: string | undefined
}): TierResolution {
  // The override is deliberately checked FIRST, but only for unpackaged runs.
  // Putting the `isPackaged` guard here (rather than at the call site) means a
  // future caller cannot forget it.
  if (!opts.isPackaged) {
    const forced = (opts.forceEnv ?? '').trim().toLowerCase()
    if (forced === 'paid' || forced === 'free') {
      return { tier: forced, isPaid: forced === 'paid', source: 'forced-dev-override' }
    }
  }
  if (opts.isMsix) return { tier: 'paid', isPaid: true, source: 'msix' }
  return { tier: 'free', isPaid: false, source: 'not-packaged' }
}

/** The live tier for this process. */
export function resolveTier(): TierResolution {
  return resolveTierFrom({
    isMsix: isPackagedAsMsix(getCurrentProcessContext()),
    isPackaged: app.isPackaged,
    forceEnv: process.env[FORCE_TIER_ENV],
  })
}

/** Convenience: is the paid feature set available in this process? */
export function isPaidTier(): boolean {
  return resolveTier().isPaid
}
