import { create } from 'zustand'

/**
 * REQ-087 — version counter for the opentype.js font cache in
 * `font-metrics.ts`.  Incremented every time `loadSubtitleFontFor`
 * successfully writes a new entry into `fontCache`.
 *
 * Why a Zustand store rather than a plain module variable:
 *
 *   `computeOverflowSync` is called from a React `useMemo` in
 *   `step2.tsx:overflowMap`.  Without something React can subscribe to,
 *   a cache miss falls back to the character-class width estimate AND
 *   nothing triggers a re-compute when the per-row font's load
 *   eventually completes — so the spurious overflow badge persists for
 *   the lifetime of the component even though the data is now stale.
 *
 *   By bumping `version` on every cache write and adding it to the
 *   memo's dependency list, the very next render after a load completes
 *   re-runs the per-entry overflow check, this time hitting the real-
 *   glyph path and (correctly) clearing the badge / fixing the auto-
 *   broken positions.
 *
 * Why this store has a single primitive (not the cache itself):
 *
 *   The cache is in module scope inside `font-metrics.ts` and stays
 *   there — moving it into a Zustand store would invert the dependency
 *   between the pure measurement helpers (no React) and the renderer's
 *   reactive layer.  A version counter is the smallest signal the
 *   reactive layer needs to know "something changed; re-read the cache."
 *
 * Reads:  `useFontCacheVersionStore((s) => s.version)` in components or
 *         `useFontCacheVersionStore.getState().version` in imperative code.
 *
 * Writes: only `font-metrics.ts` calls `bumpFontCacheVersion()` after a
 *         successful `fontCache.set`.  No other module should write.
 */
interface FontCacheVersionStore {
  version: number
  bump: () => void
}

export const useFontCacheVersionStore = create<FontCacheVersionStore>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))

/**
 * Imperative helper for `font-metrics.ts`.  Wraps the store getter so
 * the call site can avoid pulling the Zustand object directly.
 */
export function bumpFontCacheVersion(): void {
  useFontCacheVersionStore.getState().bump()
}
