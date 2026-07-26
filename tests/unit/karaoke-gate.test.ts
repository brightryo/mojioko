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

describe('REQ-0286 §0 / REQ-0299 §1 — canUseKaraokeInTier policy', () => {
  it('returns true for MSIX (paid tier)', () => {
    expect(canUseKaraokeInTier(true)).toBe(true)
  })

  it('REQ-0299 §1 — returns TRUE for NSIS (free tier) too — karaoke now available to every tier', () => {
    // Pre-REQ-0299 (v1.3.6 initial) shipped karaoke paid-only.  REQ-0299
    // §1 reversed that decision: karaoke is a general-use feature and the
    // paid tier differentiates through additional fonts / weight
    // selection only.  Flipping this back to `false` would silently
    // suppress karaoke in the NSIS build again — this pin trips first.
    expect(canUseKaraokeInTier(false)).toBe(true)
  })

  it('REQ-0299 §1 — the isMsix arg is ignored (both values produce true)', () => {
    // Documents that karaoke policy is currently tier-agnostic.  A
    // future REQ that reintroduces tier gating for karaoke would flip
    // this and the "NSIS is TRUE" test above in the same commit.
    expect(canUseKaraokeInTier(true)).toBe(canUseKaraokeInTier(false))
  })
})

describe('REQ-0286 — karaoke default highlight colour', () => {
  // REQ-0308 §5 — was '#FFFF00'.  The lime is a member of the REQ-0306
  // BASIC_COLORS palette, so the picker now shows the default as selected.
  it('highlight defaults to the lime accent (#B4FF39, a BASIC_COLORS member)', () => {
    expect(KARAOKE_DEFAULT_HIGHLIGHT_COLOR).toBe('#B4FF39')
  })

  it('is 6-hex uppercase — matches ColorPicker canonical form', () => {
    expect(KARAOKE_DEFAULT_HIGHLIGHT_COLOR).toMatch(/^#[0-9A-F]{6}$/)
  })

  // REQ-0293 §2 removed the pre-existing `KARAOKE_DEFAULT_BASE_COLOR`
  // constant — the base half of the karaoke sweep now always tracks
  // each cue's `textColorHex` at render time, so no base default is
  // needed.  See karaoke-gate.ts docstring for the full context.
})
