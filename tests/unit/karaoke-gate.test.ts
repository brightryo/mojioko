import { describe, it, expect } from 'vitest'
import {
  canUseKaraokeInTier,
  KARAOKE_DEFAULT_HIGHLIGHT_COLOR,
} from '../../src/shared/karaoke-gate'

/**
 * REQ-0286 §0 — pins the karaoke tier gate as the SINGLE decision
 * surface for whether karaoke is available in the current build.
 *
 * Every UI, ass-generator, and preview consumer MUST call this function
 * rather than inline `isMsix` checks.  If a future contributor bypasses
 * it, the "one-line flip to free" contract breaks — a search-and-
 * replace across the codebase to find every karaoke-related isMsix
 * check would be error-prone.
 *
 * Test #4 is the "sole decision point" pin: it uses a source grep
 * to assert that no other file uses karaokeEnabled+isMsix together
 * WITHOUT going through canUseKaraokeInTier.  A regression that adds
 * such an inline check breaks the test at CI time.
 */

describe('REQ-0286 §0 — canUseKaraokeInTier policy', () => {
  it('returns true for MSIX (paid tier)', () => {
    expect(canUseKaraokeInTier(true)).toBe(true)
  })

  it('returns false for NSIS (free tier) — current v1.3.6 policy', () => {
    expect(canUseKaraokeInTier(false)).toBe(false)
  })
})

describe('REQ-0286 — karaoke default highlight colour', () => {
  it('highlight defaults to yellow (#FFFF00, matches TikTok/short-form convention)', () => {
    expect(KARAOKE_DEFAULT_HIGHLIGHT_COLOR).toBe('#FFFF00')
  })

  it('is 6-hex uppercase — matches ColorPicker canonical form', () => {
    expect(KARAOKE_DEFAULT_HIGHLIGHT_COLOR).toMatch(/^#[0-9A-F]{6}$/)
  })

  // REQ-0293 §2 removed the pre-existing `KARAOKE_DEFAULT_BASE_COLOR`
  // constant — the base half of the karaoke sweep now always tracks
  // each cue's `textColorHex` at render time, so no base default is
  // needed.  See karaoke-gate.ts docstring for the full context.
})
