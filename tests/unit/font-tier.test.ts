import { describe, expect, it } from 'vitest'
import { canSelectFontInTier, canDownloadFontInTier } from '../../src/renderer/lib/font-tier'
import { DEFAULT_FONT_ID, FONT_REGISTRY } from '../../src/shared/fonts'

/**
 * REQ-088 #4 — tier policy contract.
 *
 * Pure-function checks so the policy stays decoupled from any IPC /
 * Zustand wiring.  A drift between these tests and the UI's actual
 * behaviour is a hint that the policy split — pure helper vs view
 * gating — got tangled (e.g. a hardcoded `isMsix` check inside a
 * component).  Keep all tier decisions running through these helpers.
 */

describe('canSelectFontInTier', () => {
  it('MSIX (paid) allows every registered font', () => {
    for (const meta of FONT_REGISTRY) {
      expect(canSelectFontInTier(true, meta.id)).toBe(true)
    }
  })

  it('NSIS (free) allows only the bundled default', () => {
    for (const meta of FONT_REGISTRY) {
      const expected = meta.id === DEFAULT_FONT_ID
      expect(canSelectFontInTier(false, meta.id)).toBe(expected)
    }
  })

  it('NSIS specifically blocks Dela Gothic One (regression guard)', () => {
    // The bug report (REQ-088) used Dela as the symptom font; pin it
    // explicitly so a future widening of the free tier needs an
    // intentional test edit.
    expect(canSelectFontInTier(false, 'dela-gothic-one')).toBe(false)
  })

  it('NSIS allows the default font even with explicit id', () => {
    expect(canSelectFontInTier(false, DEFAULT_FONT_ID)).toBe(true)
  })
})

describe('canDownloadFontInTier', () => {
  it('MSIX allows downloading every non-default font', () => {
    for (const meta of FONT_REGISTRY) {
      const expected = meta.id !== DEFAULT_FONT_ID
      expect(canDownloadFontInTier(true, meta.id)).toBe(expected)
    }
  })

  it('NSIS forbids downloading any font', () => {
    for (const meta of FONT_REGISTRY) {
      expect(canDownloadFontInTier(false, meta.id)).toBe(false)
    }
  })

  it('the default font is never a download target — both tiers return false', () => {
    // Defensive: the default is bundled with the installer so the
    // concept of "downloading" it doesn't apply.  Behaviour must hold
    // for both tiers so a future caller can ignore the tier flag for
    // bundled fonts.
    expect(canDownloadFontInTier(true, DEFAULT_FONT_ID)).toBe(false)
    expect(canDownloadFontInTier(false, DEFAULT_FONT_ID)).toBe(false)
  })
})
