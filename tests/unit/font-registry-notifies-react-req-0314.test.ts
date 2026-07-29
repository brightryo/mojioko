/**
 * REQ-0314 §1-1 — registering a CSS font must signal the React layer.
 *
 * `subtitle-overlay`'s canvas outline ring (REQ-0313) is measured from the LIVE
 * DOM, so it is only correct as long as every reflow is accompanied by a React
 * render.  The CSS font registration in `font-registry.ts` and the opentype
 * parse in `font-metrics.ts` are two INDEPENDENT loads started together, and
 * only the latter used to bump the store.  When the CSS side won that race the
 * text reflowed into the real font with no render, and the ring kept tracing
 * the fallback glyphs — measured drift 5.53px horizontal / 10.00px vertical.
 *
 * Downstream detection was measured and rejected:
 *   - `document.fonts` `loadingdone` never fires here, because `face.load()` is
 *     awaited BEFORE `document.fonts.add()`, so the set never enters a loading
 *     state (0 events observed).
 *   - `ResizeObserver` on the text wrapper never fires, because the wrapper is
 *     `display: inline`, which ResizeObserver does not observe (0 callbacks).
 *
 * Hence this test pins the signal at its source.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEFAULT_FONT_ID, getFontMeta } from '../../src/shared/fonts'

// The suite runs in the node environment (jsdom is not a dependency).  The
// bundled-font path only touches `document` through `'fonts' in document`, so a
// bare object is enough and keeps the test honest about which branch it covers.
;(globalThis as unknown as { document: object }).document = {}

describe('REQ-0314 §1-1 — font registration bumps the React font-cache version', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('the default font is a bundled one, so this exercises the fonts.css path', () => {
    expect(getFontMeta(DEFAULT_FONT_ID).bundled).toBe(true)
  })

  it('bumps the version once the family is usable', async () => {
    const store = await import('../../src/renderer/stores/font-cache-version-store')
    const registry = await import('../../src/renderer/lib/font-registry')

    const before = store.useFontCacheVersionStore.getState().version
    await registry.ensureFontLoaded(DEFAULT_FONT_ID)
    const after = store.useFontCacheVersionStore.getState().version

    expect(after).toBeGreaterThan(before)
  })

  it('does not bump again for an already-registered font (cached promise)', async () => {
    const store = await import('../../src/renderer/stores/font-cache-version-store')
    const registry = await import('../../src/renderer/lib/font-registry')

    await registry.ensureFontLoaded(DEFAULT_FONT_ID)
    const afterFirst = store.useFontCacheVersionStore.getState().version
    await registry.ensureFontLoaded(DEFAULT_FONT_ID)
    // The registry caches the in-flight/settled promise, so a repeat call is a
    // no-op — the overlay must not be re-rendered for nothing.
    expect(store.useFontCacheVersionStore.getState().version).toBe(afterFirst)
  })

  it('a bump is observable by a subscriber — this is what re-renders the overlay', async () => {
    const store = await import('../../src/renderer/stores/font-cache-version-store')
    const registry = await import('../../src/renderer/lib/font-registry')

    const seen: number[] = []
    const unsub = store.useFontCacheVersionStore.subscribe((s) => seen.push(s.version))
    await registry.ensureFontLoaded(DEFAULT_FONT_ID)
    unsub()

    expect(seen.length).toBeGreaterThan(0)
  })
})
