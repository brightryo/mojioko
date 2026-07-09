import { describe, it, expect } from 'vitest'
import {
  FONT_REGISTRY,
  DEFAULT_FONT_ID,
  getSortedFontRegistry,
  type FontMeta,
} from '../../src/shared/fonts'

/**
 * REQ-0153 §2 — the sort helper is what unifies the display order
 * across every font picker in the app.  These tests pin the invariants
 * so a future registry addition or renaming does not silently break
 * the alphabetical contract or omit the shared badge metadata.
 */
describe('getSortedFontRegistry', () => {
  it('returns every registered font exactly once', () => {
    const sorted = getSortedFontRegistry()
    expect(sorted).toHaveLength(FONT_REGISTRY.length)
    const ids = new Set(sorted.map((f) => f.id))
    expect(ids.size).toBe(FONT_REGISTRY.length)
    for (const meta of FONT_REGISTRY) {
      expect(ids.has(meta.id)).toBe(true)
    }
  })

  it('sorts by displayName ascending, case-insensitive', () => {
    const sorted = getSortedFontRegistry()
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].displayName.toLowerCase()
      const curr = sorted[i].displayName.toLowerCase()
      expect(prev <= curr).toBe(true)
    }
  })

  it('places Anton (the alphabetically-first REQ-0153 entry) first', () => {
    const sorted = getSortedFontRegistry()
    expect(sorted[0].id).toBe('anton')
  })

  it('places the 4 REQ-0153 fonts in alphabetical order relative to each other', () => {
    const sorted = getSortedFontRegistry()
    const en = sorted
      .filter((f) => f.languages.length === 1 && f.languages[0] === 'en')
      .map((f) => f.id)
    expect(en).toEqual(['anton', 'bebas-neue', 'montserrat', 'poppins'])
  })

  it('does not mutate FONT_REGISTRY', () => {
    const before = FONT_REGISTRY.map((f) => f.id)
    getSortedFontRegistry()
    const after = FONT_REGISTRY.map((f) => f.id)
    expect(after).toEqual(before)
  })

  it('keeps the default font (noto-sans-jp-semibold) findable and unchanged as DEFAULT_FONT_ID', () => {
    const found = FONT_REGISTRY.find((f) => f.id === DEFAULT_FONT_ID)
    expect(found).toBeDefined()
    expect(found!.bundled).toBe(true)
    expect(found!.languages).toContain('ja')
  })
})

describe('FONT_REGISTRY.languages metadata (REQ-0154)', () => {
  it('every font declares at least one language', () => {
    for (const f of FONT_REGISTRY as readonly FontMeta[]) {
      expect(f.languages.length).toBeGreaterThan(0)
    }
  })

  it('every declared language is `ja` or `en`', () => {
    for (const f of FONT_REGISTRY as readonly FontMeta[]) {
      for (const lang of f.languages) {
        expect(lang === 'ja' || lang === 'en').toBe(true)
      }
    }
  })

  it('no font declares the same language twice', () => {
    for (const f of FONT_REGISTRY as readonly FontMeta[]) {
      const set = new Set(f.languages)
      expect(set.size).toBe(f.languages.length)
    }
  })

  it('when both are present, `en` appears BEFORE `ja` (REQ-0155 badge order contract)', () => {
    // REQ-0155 §1 — flipped from REQ-0154's original `ja-first` order.
    // With EN as the shared Latin baseline across all 13 fonts, putting
    // it at index 0 aligns the "EN" chip in the same column across every
    // row in the picker so the extra "JA" chip on Japanese faces reads
    // as an additive capability.
    for (const f of FONT_REGISTRY as readonly FontMeta[]) {
      const ja = f.languages.indexOf('ja')
      const en = f.languages.indexOf('en')
      if (ja !== -1 && en !== -1) {
        expect(en).toBeLessThan(ja)
      }
    }
  })

  it('all 9 pre-REQ-0153 Japanese faces declare `en` then `ja`', () => {
    // REQ-0155 §1 — was `['ja', 'en']` in REQ-0154.
    const jaFontIds = [
      'noto-sans-jp-semibold',
      'dela-gothic-one',
      'reggae-one',
      'yusei-magic',
      'mochiy-pop-one',
      'hachi-maru-pop',
      'potta-one',
      'dotgothic16',
      'rampart-one',
    ] as const
    for (const id of jaFontIds) {
      const meta = FONT_REGISTRY.find((f) => f.id === id)
      expect(meta).toBeDefined()
      expect(meta!.languages).toEqual(['en', 'ja'])
    }
  })

  it('all 4 REQ-0153 Latin faces declare `en` only', () => {
    const enFontIds = ['anton', 'bebas-neue', 'montserrat', 'poppins'] as const
    for (const id of enFontIds) {
      const meta = FONT_REGISTRY.find((f) => f.id === id)
      expect(meta).toBeDefined()
      expect(meta!.languages).toEqual(['en'])
    }
  })

  it('no font is `ja`-only (owner hypothesis: JA faces always cover basic Latin)', () => {
    for (const f of FONT_REGISTRY as readonly FontMeta[]) {
      const isJaOnly = f.languages.length === 1 && f.languages[0] === 'ja'
      expect(isJaOnly).toBe(false)
    }
  })
})
