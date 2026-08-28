import { describe, it, expect } from 'vitest'
import { pickInitialOpenSection } from '../../src/renderer/routes/step1-initial-open'

/**
 * REQ-20260615-072 — STEP1 mutually-exclusive accordion initial-open
 * decision.
 *
 * The rule is a one-liner today, but kept as a named helper so:
 *   1. The intent ("no model = open Whisper, else all collapsed") is
 *      auditable in one place rather than buried in step1.tsx state init.
 *   2. A regression that flips the default is caught here instead of
 *      waiting for the new-user UX bug to resurface in a release smoke.
 *
 * REQ-0422 — the input-video card was removed from STEP1 (file selection
 * moved into the setup drawer), so the happy path (a model is installed)
 * now returns `null` = all accordions collapsed instead of `'inputVideo'`.
 */

describe('REQ-072 / REQ-0422 — pickInitialOpenSection', () => {
  it('opens the Whisper accordion when no active model is installed', () => {
    expect(pickInitialOpenSection(null)).toBe('whisper')
  })

  it('leaves all accordions collapsed when large-v3-turbo is active', () => {
    expect(pickInitialOpenSection('large-v3-turbo')).toBeNull()
  })

  it('leaves all accordions collapsed when large-v3 is active', () => {
    expect(pickInitialOpenSection('large-v3')).toBeNull()
  })
})
