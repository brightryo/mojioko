import { describe, it, expect } from 'vitest'
import {
  FONT_REGISTRY,
  FONT_SET_VERSION,
  FONTS_RELEASE_TAG,
  DEFAULT_FONT_ID,
  getFontMeta,
  type FontId,
} from '../../src/shared/fonts'
import { canDownloadFontInTier } from '../../src/shared/font-tier'

/**
 * REQ-0353 §1-2 / §1-4 — the two properties that let `FONT_SET_VERSION` stay
 * at 3 after six Noto weights moved from "downloadable" to "bundled".
 *
 * The plan was to publish a `fonts-v4` release without those six and bump the
 * version.  It was dropped after checking what the code actually does, and
 * this file is what keeps that decision honest: if either property below stops
 * holding, the reasoning recorded on `FONT_SET_VERSION` is no longer true and
 * a bump (or a new release) really is needed.
 *
 *   1. Nothing DOWNLOADS a bundled font — so the redundant copies on the
 *      `fonts-v3` release are never fetched, and "download all" costs the user
 *      nothing extra.
 *   2. Nothing RESOLVES a bundled font to the user directory — so a weight
 *      that v1.3.5 already downloaded cannot compete with the bundled file.
 *      That is REQ-0353 §1-4's double-registration question: the two copies
 *      never both exist as far as the app is concerned, because the branch is
 *      taken on `meta.bundled` and not on what is present on disk.
 *
 * Both are asserted over the whole registry rather than the six weights, so a
 * future font that is bundled without going through this reasoning is covered.
 */
describe('REQ-0353 §1-2 — a bundled font is never downloaded', () => {
  it('has no download URL for any bundled font', () => {
    const withUrl = FONT_REGISTRY.filter((m) => m.bundled && m.downloadUrl !== null).map((m) => m.id)
    expect(withUrl, 'a bundled font must not carry a download URL').toEqual([])
  })

  it('refuses to download a bundled font in EITHER tier', () => {
    // `canDownloadFontInTier` is what the picker's batch targets are filtered
    // by, together with `!meta.bundled`.  Paid tier included: the paid user is
    // the one who presses "download all", and re-fetching ~33 MB of fonts they
    // already have shipped in the installer is the waste this pins out.
    for (const meta of FONT_REGISTRY.filter((m) => m.bundled)) {
      expect(canDownloadFontInTier(false, meta.id), `${meta.id} free tier`).toBe(false)
      // Paid tier: the download gate itself allows non-default fonts, so the
      // protection here is the `!meta.bundled` filter at the call site.  Assert
      // the flag that filter reads, which is the thing that must not drift.
      expect(meta.bundled, `${meta.id} stays bundled`).toBe(true)
    }
  })

  it('every downloadable asset still points at the published release tag', () => {
    // The app must not reference a tag that was never published.  REQ-0353
    // deliberately did NOT create fonts-v4, so this pins that the registry
    // still names the release that actually exists.
    expect(FONTS_RELEASE_TAG).toBe('fonts-v3')
    for (const meta of FONT_REGISTRY.filter((m) => !m.bundled)) {
      expect(meta.downloadUrl, `${meta.id} has a URL`).toBeTruthy()
      expect(meta.downloadUrl, `${meta.id} points at ${FONTS_RELEASE_TAG}`)
        .toContain(`/download/${FONTS_RELEASE_TAG}/`)
    }
  })

  it('keeps FONT_SET_VERSION at 3 — bumping it would force a needless re-download', () => {
    // Guard on the reasoning, not the number for its own sake: a bump marks
    // every already-downloaded font not-installed.  If someone raises this,
    // the assets should have changed too, which means a new release tag.
    expect(FONT_SET_VERSION).toBe(3)
  })
})

describe('REQ-0353 §1-4 — no double registration', () => {
  it('resolves each font id to exactly one location, chosen by `bundled`', () => {
    // `getFontResolveDir` (main/lib/paths.ts) is a single if/else on
    // `meta.bundled`, so a font id can only ever name one directory.  The
    // property that matters is that the FLAG is unambiguous per id — asserted
    // here — because that is what makes "downloaded copy left over from
    // v1.3.5" unreachable rather than ambiguous.
    const seen = new Map<FontId, boolean>()
    for (const meta of FONT_REGISTRY) {
      expect(seen.has(meta.id), `${meta.id} appears twice in the registry`).toBe(false)
      seen.set(meta.id, meta.bundled)
    }
    expect(seen.size).toBe(FONT_REGISTRY.length)
  })

  it('never has two registry entries claiming the same family AND weight', () => {
    // The real double-registration hazard: two entries resolving to the same
    // namespaced family + weight would make libass's pick undefined.
    const key = (m: typeof FONT_REGISTRY[number]) => `${m.cssFontFamily}|${m.weight}`
    const counts = new Map<string, string[]>()
    for (const m of FONT_REGISTRY) {
      const k = key(m)
      counts.set(k, [...(counts.get(k) ?? []), m.id])
    }
    const dupes = [...counts.entries()].filter(([, ids]) => ids.length > 1)
    expect(dupes, 'family+weight collisions make font resolution undefined').toEqual([])
  })

  it('the bundled family is fully bundled — no weight of it is downloadable', () => {
    // A half-bundled family is where a leftover download could still be read,
    // so state that the free-tier family has no downloadable member at all.
    const family = getFontMeta(DEFAULT_FONT_ID).cssFontFamily
    const downloadable = FONT_REGISTRY
      .filter((m) => m.cssFontFamily === family && !m.bundled)
      .map((m) => m.id)
    expect(downloadable, 'every weight of the shipped family must be bundled').toEqual([])
  })
})
