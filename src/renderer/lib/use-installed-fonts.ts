import { useEffect } from 'react'
import { useUiStore } from '@/stores/ui-store'
import { useInstalledFontsStore, refreshInstalledFonts } from '@/stores/installed-fonts-store'
import type { FontId } from '../../shared/fonts'

/**
 * Returns the set of currently-installed (bundled or downloaded) font IDs.
 * Refetches whenever `useUiStore.fontInventoryVersion` bumps so a popover
 * list opened in one component picks up changes made elsewhere (e.g. the
 * user removes a font from Settings while STEP 2 stays mounted).
 *
 * REQ-022 step 1 / REQ-025 (iv).
 *
 * REQ-0339 §2 — the set itself now lives in `installed-fonts-store`, not in
 * this hook's own `useState`.  Per-component state meant every mount began
 * from an EMPTY set, and `resolveRenderableFontId` reads "empty" as "nothing
 * is installed" and falls back to `DEFAULT_FONT_ID` — so each cue painted its
 * first frame in the wrong font (measured at up to 2.53× the settled text
 * width).  Reading a shared store makes the already-resolved value available
 * SYNCHRONOUSLY to anything that mounts after the first fetch, which is every
 * subtitle overlay.  See the store's header for the measurements.
 *
 * The effect still exists, but it now only says "make sure THIS inventory
 * version has been fetched"; the store dedupes, so N consumers cost one IPC.
 */
export function useInstalledFontIds(): ReadonlySet<FontId> {
  // Subscribe to the version so the effect re-runs on every bump.
  // Reads at the slice level so unrelated UI store changes don't trigger
  // a re-render here.
  const version = useUiStore((s) => s.fontInventoryVersion)
  const ids = useInstalledFontsStore((s) => s.ids)
  useEffect(() => {
    void refreshInstalledFonts(version)
  }, [version])
  return ids
}
