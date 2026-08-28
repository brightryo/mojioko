import { describe, it, expect } from 'vitest'
import { resolveTierFrom, FORCE_TIER_ENV } from '../../src/main/lib/tier'

/**
 * REQ-0507 §1 / §2-4 — one place decides the tier, and it says WHY.
 *
 * ## Why the override exists
 *
 * `isPackagedAsMsix` is true only for `process.windowsStore === true` or an
 * `execPath` under `\WindowsApps\`. Neither holds for `electron .`, so **dev
 * runs as free tier and there was no way to run as paid**. That blocked two
 * things at once: the owner cannot exercise paid fonts while developing, and a
 * tier gate cannot be tested on BOTH sides — and a gate verified only on the
 * "blocked" side lets the paid path break silently.
 *
 * ## Why it cannot unlock a shipped build
 *
 * The override is honoured only when `isPackaged` is false. A real NSIS or MSIX
 * install ignores the variable, so this is a development affordance rather than
 * a licence bypass. That guard lives inside `resolveTierFrom`, not at the call
 * sites, so a future caller cannot forget it — which is the property this test
 * spends most of its assertions on.
 */
describe('REQ-0507 — tier resolution', () => {
  it('MSIX is paid', () => {
    expect(resolveTierFrom({ isMsix: true, isPackaged: true, forceEnv: undefined }))
      .toEqual({ tier: 'paid', isPaid: true, source: 'msix' })
  })

  it('packaged non-MSIX (NSIS) is free', () => {
    expect(resolveTierFrom({ isMsix: false, isPackaged: true, forceEnv: undefined }))
      .toEqual({ tier: 'free', isPaid: false, source: 'not-packaged' })
  })

  it('dev with no override is free — this is why the override is needed at all', () => {
    expect(resolveTierFrom({ isMsix: false, isPackaged: false, forceEnv: undefined }))
      .toEqual({ tier: 'free', isPaid: false, source: 'not-packaged' })
  })
})

describe('REQ-0507 — the dev override', () => {
  it.each(['paid', 'PAID', ' paid '])('honours %s in an unpackaged run', (v) => {
    expect(resolveTierFrom({ isMsix: false, isPackaged: false, forceEnv: v }))
      .toEqual({ tier: 'paid', isPaid: true, source: 'forced-dev-override' })
  })

  it('can also force FREE on a dev machine that would otherwise read as paid', () => {
    // Needed to test the blocked side on a box where execPath happens to sit
    // under \WindowsApps\.
    expect(resolveTierFrom({ isMsix: true, isPackaged: false, forceEnv: 'free' }))
      .toEqual({ tier: 'free', isPaid: false, source: 'forced-dev-override' })
  })

  it.each([undefined, '', '   ', 'yes', 'true', '1', 'premium'])('ignores the unrecognised value %s', (v) => {
    // An unknown value must fall through to real detection, not silently mean
    // "paid" — a typo should not unlock anything.
    expect(resolveTierFrom({ isMsix: false, isPackaged: false, forceEnv: v }).source).not.toBe('forced-dev-override')
  })

  /**
   * ★ The security-relevant assertion. Everything else here is convenience;
   * this is the property that makes shipping the override acceptable.
   */
  it.each(['paid', 'PAID'])('is IGNORED in a packaged build (%s cannot unlock a shipped app)', (v) => {
    expect(resolveTierFrom({ isMsix: false, isPackaged: true, forceEnv: v }))
      .toEqual({ tier: 'free', isPaid: false, source: 'not-packaged' })
  })

  it('cannot downgrade a packaged MSIX build either', () => {
    expect(resolveTierFrom({ isMsix: true, isPackaged: true, forceEnv: 'free' }).tier).toBe('paid')
  })

  it('exports the env var name so callers and docs cannot drift', () => {
    expect(FORCE_TIER_ENV).toBe('MOJIOKO_FORCE_TIER')
  })
})
