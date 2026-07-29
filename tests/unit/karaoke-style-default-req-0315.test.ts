import { describe, it, expect } from 'vitest'
import {
  KARAOKE_STYLE_DEFAULT,
  coerceKaraokeStyle,
} from '../../src/shared/karaoke-style'

/**
 * REQ-0315 §2 — sweep is adopted and becomes the default.
 *
 * The subtle part is the NON-migration guarantee.  `coerceKaraokeStyle` used to
 * read `v === 'sweep' ? 'sweep' : DEFAULT`, which was harmless while the
 * default was `'switch'`.  With the default now `'sweep'`, that same expression
 * would rewrite a stored `'switch'` into `'sweep'` on load — silently migrating
 * exactly the users REQ-0315 §2 says must keep their choice.  Both values are
 * therefore matched explicitly, and this test is what stops the short form
 * being "simplified" back in.
 */
describe('REQ-0315 §2 — karaoke style default', () => {
  it('defaults to sweep', () => {
    expect(KARAOKE_STYLE_DEFAULT).toBe('sweep')
  })

  it('a fresh install (no stored value) gets sweep', () => {
    expect(coerceKaraokeStyle(undefined)).toBe('sweep')
    expect(coerceKaraokeStyle(null)).toBe('sweep')
  })

  it('DOES NOT migrate a user who explicitly stored "switch"', () => {
    expect(coerceKaraokeStyle('switch')).toBe('switch')
  })

  it('keeps an explicitly stored "sweep"', () => {
    expect(coerceKaraokeStyle('sweep')).toBe('sweep')
  })

  it('falls back to the default only for genuinely unknown values', () => {
    for (const junk of ['', 'SWEEP', 'fade', 0, 1, {}, []]) {
      expect(coerceKaraokeStyle(junk)).toBe(KARAOKE_STYLE_DEFAULT)
    }
  })

  it('is idempotent — coercing twice cannot drift', () => {
    for (const v of ['switch', 'sweep', undefined, 'junk']) {
      const once = coerceKaraokeStyle(v)
      expect(coerceKaraokeStyle(once)).toBe(once)
    }
  })
})
