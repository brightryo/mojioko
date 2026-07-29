/**
 * REQ-0325 §3-1 — harness stub for `@/lib/use-installed-fonts`.
 *
 * The real hook is `useState(new Set()) + useEffect(listFonts)`.  Fixtures are
 * server-rendered (`renderToStaticMarkup`), so the effect NEVER runs and the
 * hook always returns an EMPTY set.  `SubtitleOverlay` feeds that set to
 * `resolveRenderableFontId`, which therefore fell back to `DEFAULT_FONT_ID`
 * for every fixture — which is precisely why the gate only ever exercised
 * Noto SemiBold no matter what `fontId` a fixture asked for.
 *
 * This stub reports "every registered font is on disk", i.e. a paid-tier user
 * who has completed the font-set download.  That is a real production state,
 * not a fabricated one; the harness then registers exactly those faces via
 * `@font-face` (mirroring `font-registry.ts::ensureFontLoaded`) and skips any
 * case whose TTF is genuinely absent from this machine.
 */
import { FONT_REGISTRY, type FontId } from '../../../src/shared/fonts'

const ALL_INSTALLED: ReadonlySet<FontId> = new Set(FONT_REGISTRY.map((f) => f.id))

export function useInstalledFontIds(): ReadonlySet<FontId> {
  return ALL_INSTALLED
}
