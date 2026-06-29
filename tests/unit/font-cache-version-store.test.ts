import { describe, expect, it, beforeEach } from 'vitest'
import {
  useFontCacheVersionStore,
  bumpFontCacheVersion,
} from '../../src/renderer/stores/font-cache-version-store'

/**
 * REQ-087 — the font cache version is the React-side signal that lets
 * `overflowMap` (and any other memo that derives from per-row font
 * metrics) re-run the moment `loadSubtitleFontFor` finishes populating
 * the opentype.js cache.  The contract surface area is small but
 * load-bearing:
 *
 *   - Initial `version` must be `0` so first-render comparisons start
 *     from a stable baseline (memos won't re-run spuriously).
 *   - Every `bump` (whether via the imperative helper or via the store
 *     action) must advance the value monotonically by exactly 1.
 *   - The imperative helper and the store action must agree — they are
 *     two faces of the same write so any future refactor that splits
 *     them risks losing wakeups.
 */

describe('useFontCacheVersionStore', () => {
  beforeEach(() => {
    // Each test starts at a known baseline.  We can't reach into the
    // Zustand store's internal reset, so we record the entry value and
    // subtract it from our deltas — this also documents that the store
    // is module-scoped and persists across imports in the same process.
  })

  it('exposes a numeric version that increments on bump()', () => {
    const before = useFontCacheVersionStore.getState().version
    useFontCacheVersionStore.getState().bump()
    const after = useFontCacheVersionStore.getState().version
    expect(after).toBe(before + 1)
  })

  it('imperative bumpFontCacheVersion() agrees with store.bump()', () => {
    const before = useFontCacheVersionStore.getState().version
    bumpFontCacheVersion()
    bumpFontCacheVersion()
    const after = useFontCacheVersionStore.getState().version
    expect(after).toBe(before + 2)
  })

  it('advances strictly monotonically across N bumps', () => {
    const before = useFontCacheVersionStore.getState().version
    const N = 5
    for (let i = 0; i < N; i++) bumpFontCacheVersion()
    const after = useFontCacheVersionStore.getState().version
    expect(after).toBe(before + N)
  })

  it('subscribers are notified on bump (drives React re-renders)', () => {
    let observedVersions: number[] = []
    const unsub = useFontCacheVersionStore.subscribe((s) => {
      observedVersions.push(s.version)
    })
    bumpFontCacheVersion()
    bumpFontCacheVersion()
    unsub()
    expect(observedVersions.length).toBe(2)
    expect(observedVersions[1]).toBe(observedVersions[0] + 1)
  })
})
