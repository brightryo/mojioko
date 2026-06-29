import { DEFAULT_FONT_ID, type FontId } from '../../shared/fonts'

/**
 * REQ-088 #4 — tier policy: which fonts can a given build select?
 *
 * - MSIX (paid / store build): every registered font.
 * - NSIS (free / GitHub build): only the bundled default
 *   (`DEFAULT_FONT_ID`).  Even if a downloaded font is present on disk
 *   from an older state, the picker must not let the user activate it.
 *
 * Pure function with no Electron / DOM / Zustand dependencies so the
 * test in `font-tier.test.ts` can pin the policy without any IPC
 * stub.  Both the FontPicker (settings + subtitle-style dialog) and
 * the RowFontSelector (timeline inspector + bulk-edit) call this with
 * the runtime `isMsix` flag from `useAppEnvStore`.
 */
export function canSelectFontInTier(isMsix: boolean, fontId: FontId): boolean {
  if (isMsix) return true
  return fontId === DEFAULT_FONT_ID
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
