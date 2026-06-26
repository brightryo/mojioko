import { describe, it, expect } from 'vitest'
import { pickInitialOpenSection } from '../../src/renderer/routes/step1-initial-open'

/**
 * REQ-20260615-072 — STEP1 mutually-exclusive accordion initial-open
 * decision.
 *
 * The rule is a one-liner today, but kept as a named helper so:
 *   1. The intent ("no model = open Whisper, else open input video") is
 *      auditable in one place rather than buried in step1.tsx state init.
 *   2. A regression that flips the default (e.g. a future refactor that
 *      hardcodes 'inputVideo' again) is caught here instead of waiting
 *      for the new-user UX bug to resurface in a release smoke.
 */

describe('REQ-072 — pickInitialOpenSection', () => {
  it('opens the Whisper accordion when no active model is installed', () => {
    expect(pickInitialOpenSection(null)).toBe('whisper')
  })

  it('opens the input-video accordion when large-v3-turbo is active', () => {
    expect(pickInitialOpenSection('large-v3-turbo')).toBe('inputVideo')
  })

  it('opens the input-video accordion when large-v3 is active', () => {
    expect(pickInitialOpenSection('large-v3')).toBe('inputVideo')
  })
})
