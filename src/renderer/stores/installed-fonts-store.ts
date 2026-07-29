import { create } from 'zustand'
import { listFonts } from '@/services/font'
import type { FontId } from '../../shared/fonts'

/**
 * REQ-0339 §2 — the set of installed (bundled or downloaded) font IDs, held
 * ONCE for the whole app instead of once per component instance.
 *
 * ## Why this store exists
 *
 * `useInstalledFontIds` used to be `useState(new Set()) + useEffect(listFonts)`
 * INSIDE each consumer.  Every mount therefore started from an EMPTY set and
 * only reached the truth an IPC round-trip later.  `SubtitleOverlay` feeds that
 * set to `resolveRenderableFontId`, which treats "not installed" as "substitute
 * the family's nearest installed weight, else `DEFAULT_FONT_ID`" — so on its
 * very first commit EVERY cue rendered in Noto Sans JP SemiBold, whatever font
 * it actually asked for.
 *
 * `video-preview-panel` keys its overlays by `entry.id`, so a cue mounts fresh
 * each time it becomes visible.  The result was a one-frame flash of the wrong
 * font on every subtitle, every time it appeared.  Measured in a real Electron
 * window against the real component (first commit forced with `flushSync`, so
 * the numbers ARE the painted frame): the rendered text box was
 *
 *   Poppins (any weight)   2.26–2.53×   the settled width
 *   Bebas Neue             2.47×
 *   Montserrat             1.80×
 *   Anton                  1.48×
 *   any Noto Sans JP weight 1.00×  (same family ⇒ nothing to see)
 *
 * — which is exactly the "≈2.3× too wide for one frame" the owner reported.
 *
 * ## Why a store and not "wait before painting"
 *
 * The two honest cures are "don't paint until it resolves" and "make the
 * resolved value available synchronously".  The first is wrong here: the value
 * is app-global and is already fetched at startup (`App.tsx` lists fonts to
 * pre-load them), so blocking a cue's paint would be inventing a wait for data
 * the app has had since launch.  Holding it in one store makes the resolved set
 * readable synchronously by anything that mounts later — which is every cue.
 *
 * The residual is honest and bounded: between app launch and the FIRST
 * `listFonts` resolving, the set really is unknown.  That window is once per
 * process and long before any cue is on screen, rather than once per cue.
 *
 * Writes: `refreshInstalledFonts()` only.  `fontInventoryVersion`
 * (`ui-store`) still drives WHEN a refresh happens — see
 * `@/lib/use-installed-fonts`.
 */
interface InstalledFontsStore {
  ids: ReadonlySet<FontId>
  /** Bumped on every successful refresh; distinguishes "empty" from "unknown". */
  loadedCount: number
}

export const useInstalledFontsStore = create<InstalledFontsStore>(() => ({
  ids: new Set<FontId>(),
  loadedCount: 0,
}))

/** Version already fetched, so N consumers mounting at once cause ONE IPC. */
let fetchedVersion = -1
let inFlight: Promise<void> | null = null

/**
 * Re-read the inventory for `version`.  Idempotent per version: repeated calls
 * with a version that has already been fetched (or is in flight) are no-ops, so
 * every consumer can call it from its own effect without fanning out IPC.
 */
export function refreshInstalledFonts(version: number): Promise<void> {
  if (version === fetchedVersion) return inFlight ?? Promise.resolve()
  fetchedVersion = version
  inFlight = listFonts()
    .then((r) => {
      if (!r.ok) return
      const next = new Set<FontId>()
      for (const f of r.data.fonts) {
        if (f.status === 'bundled' || f.status === 'installed') next.add(f.id)
      }
      useInstalledFontsStore.setState((s) => ({
        ids: next,
        loadedCount: s.loadedCount + 1,
      }))
    })
    .catch(() => { /* keep the previous snapshot; a later bump retries */ })
    .finally(() => { inFlight = null })
  return inFlight
}

/** Imperative read for non-React code paths. */
export function getInstalledFontIds(): ReadonlySet<FontId> {
  return useInstalledFontsStore.getState().ids
}
