import { getSortedFontRegistry, type FontMeta, type FontInfo, type FontsState } from '../../shared/fonts'
import { canDownloadFontInTier } from './font-tier'

/**
 * REQ-0161 — pure selector for the "batch download" target list.  Extracted
 * so `tests/unit/batch-font-download.test.ts` can exercise the eligibility
 * rules directly, without dragging the FontPicker's React tree into the
 * suite.
 *
 * Eligibility rules (all must hold):
 *   1. Not the bundled default (bundled fonts are always installed and
 *      cannot be downloaded).
 *   2. Current install status is `'not-installed'` (fonts already on
 *      disk are skipped so a re-run after a partial download picks up
 *      only the truly missing ones).
 *   3. The current tier is allowed to download this font — i.e. we're
 *      in the paid (MSIX) build.  In the free (NSIS) build this
 *      predicate returns false for every non-default font, so the
 *      selector returns an empty list and the UI hides the batch
 *      button entirely.
 *
 * Order follows `getSortedFontRegistry()` (alphabetical) so the batch
 * downloader visits fonts in the same order the picker lists them.
 * This matters for the visible progress marker: the currently-in-flight
 * font's row shows a progress bar, and users expect that marker to
 * move down the list rather than jump.
 */
export function selectBatchDownloadTargets(
  state: FontsState | null,
  isMsix: boolean,
): FontMeta[] {
  const targets: FontMeta[] = []
  for (const meta of getSortedFontRegistry()) {
    if (meta.bundled) continue
    if (!canDownloadFontInTier(isMsix, meta.id)) continue
    const info: FontInfo | undefined = state?.fonts.find((f) => f.id === meta.id)
    const status = info?.status ?? 'not-installed'
    if (status !== 'not-installed') continue
    targets.push(meta)
  }
  return targets
}
