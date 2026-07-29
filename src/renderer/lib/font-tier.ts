import { DEFAULT_FONT_ID, isBundledFamilyFontId, type FontFamily, type FontId } from '../../shared/fonts'

/**
 * REQ-088 #4 — tier policy: which fonts can a given build select?
 *
 * - MSIX (paid / store build): every registered font.
 * - NSIS (free / GitHub build): the bundled FAMILY — all nine Noto Sans JP
 *   weights (REQ-0353).  Even if a downloaded font from one of the twelve
 *   additional families is present on disk from an older state, the picker
 *   must not let the user activate it.
 *
 * REQ-0353 widened the free tier from `DEFAULT_FONT_ID` (SemiBold alone) to
 * the whole family, and bundled the six weights that were previously
 * download-only so the choice is real offline.  The paid edition is now
 * differentiated by the additional families only.
 *
 * Pure function with no Electron / DOM / Zustand dependencies so the
 * test in `font-tier.test.ts` can pin the policy without any IPC
 * stub.  Both the FontPicker (settings + subtitle-style dialog) and
 * the RowFontSelector (timeline inspector + bulk-edit) call this with
 * the runtime `isMsix` flag from `useAppEnvStore`.
 */
export function canSelectFontInTier(isMsix: boolean, fontId: FontId): boolean {
  if (isMsix) return true
  return isBundledFamilyFontId(fontId)
}

/**
 * REQ-088 #4 — companion check for "may the user download / install
 * this font?"  Always false for the default font (it's bundled, so the
 * concept doesn't apply) and always false in NSIS (free tier).  The
 * font picker uses this to swap the Download icon for a Lock icon.
 */
export function canDownloadFontInTier(isMsix: boolean, fontId: FontId): boolean {
  if (fontId === DEFAULT_FONT_ID) return false
  return isMsix
}

/**
 * REQ-0356 — is this whole FAMILY locked behind the paid tier?
 *
 * "Locked" means the user cannot reach it at all in this build: no weight is
 * selectable, none can even be downloaded, and nothing of it ships bundled.
 * That is different from "not installed yet", which is a paid-tier state the
 * user can resolve by downloading — a not-installed family must NOT read as
 * locked, or the paid edition would grow padlocks it has never had.
 *
 * ## Why this lives here rather than at a call site
 *
 * It was inline in `FontPicker` and nowhere else, so Settings ▸ Fonts showed
 * padlocks while the two EDITING surfaces — the inspector and the bulk-edit
 * bar, i.e. where fonts are actually chosen — showed a list with the paid
 * families silently filtered out. In the free edition that list had exactly
 * one row, which reads as "this app has one font" rather than "eleven more are
 * available". The upsell had been there: `RowFontSelector` carried it and
 * shipped in v1.3.5. REQ-0275 (`b3c8093`) replaced that component with
 * `FamilyWeightSelector`, which never had the lock UI, and REQ-0341 §4 then
 * deleted the orphan — so the only copy of the behaviour went with it.
 *
 * One exported predicate, three call sites. A second inline copy is what
 * allowed the surfaces to disagree in the first place.
 */
export function isFamilyTierLocked(isMsix: boolean, family: FontFamily): boolean {
  if (family.hasBundledWeight) return false
  return (
    !family.weights.some((w) => canSelectFontInTier(isMsix, w.fontId)) &&
    !family.weights.some((w) => canDownloadFontInTier(isMsix, w.fontId))
  )
}
