import { describe, it, expect } from 'vitest'
import { resolveInitialLanguage } from '../../src/shared/language-detect'

/**
 * REQ-0101 — first-launch language auto-detection.
 *
 * The pure resolver decides between MOJIOKO's two supported UI
 * languages ('ja' | 'en') given the OS's ordered preference list.
 * These tests pin every branch of that decision so refactors of
 * either the main-side wrapper (`os-language.ts`) or the pure
 * function itself cannot silently regress.
 */

describe('resolveInitialLanguage — REQ-0101', () => {
  it("['ja'] → 'ja' (canonical JA-only environment)", () => {
    expect(resolveInitialLanguage(['ja'])).toBe('ja')
  })

  it("['ja-JP','en-US'] → 'ja' (JA first, EN second)", () => {
    expect(resolveInitialLanguage(['ja-JP', 'en-US'])).toBe('ja')
  })

  it("['en-US'] → 'en' (canonical EN-only environment)", () => {
    expect(resolveInitialLanguage(['en-US'])).toBe('en')
  })

  it("['fr-FR'] → 'en' (unsupported → fallback to en)", () => {
    expect(resolveInitialLanguage(['fr-FR'])).toBe('en')
  })

  it("['zh-CN'] → 'en' (unsupported → fallback to en)", () => {
    expect(resolveInitialLanguage(['zh-CN'])).toBe('en')
  })

  it("[] → 'en' (empty list → fallback to en)", () => {
    expect(resolveInitialLanguage([])).toBe('en')
  })

  // Ordering: unsupported entries are skipped so a later supported
  // entry can still win.  This matches Windows's semantics where the
  // list expresses "try these in order" and the app should honour the
  // first entry it actually understands.
  it("['fr-FR','ja-JP'] → 'ja' (skip unsupported fr, land on ja)", () => {
    expect(resolveInitialLanguage(['fr-FR', 'ja-JP'])).toBe('ja')
  })

  it("['en-US','ja-JP'] → 'en' (EN first wins over later JA)", () => {
    expect(resolveInitialLanguage(['en-US', 'ja-JP'])).toBe('en')
  })

  // Case-insensitivity — `getPreferredSystemLanguages()` can return
  // odd capitalisations depending on the OS release; the resolver
  // must treat them consistently.
  it("['JA-JP'] → 'ja' (uppercase tag)", () => {
    expect(resolveInitialLanguage(['JA-JP'])).toBe('ja')
  })

  it("['En-us'] → 'en' (mixed case tag)", () => {
    expect(resolveInitialLanguage(['En-us'])).toBe('en')
  })

  // Defensive: language sub-tag prefix must NOT match unrelated
  // languages that happen to start with the same letters — 'jav'
  // (Javanese) starts with 'ja' but is a distinct language.  Guarded
  // by the exact-match / `${lang}-` suffix rule.
  it("['jav'] → 'en' (Javanese is NOT Japanese)", () => {
    expect(resolveInitialLanguage(['jav'])).toBe('en')
  })

  it("['eng'] → 'en' handling: does NOT match (3-letter ISO 639-2 is out of scope)", () => {
    // 'eng' is ISO 639-2/3 alpha-3 for English.  Windows / Electron
    // return 2-letter BCP-47 tags, so we intentionally do not accept
    // the 3-letter form — dropping through to the 'en' fallback via
    // the empty-list default is the correct behaviour for this input.
    expect(resolveInitialLanguage(['eng'])).toBe('en')
  })

  // Guard against garbage inputs — Electron's typings say string[]
  // but a defensive check protects us from a future API change or
  // a stale mocked test double.
  it('skips non-string entries defensively', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(resolveInitialLanguage([null as any, undefined as any, 'ja'])).toBe('ja')
  })
})
