import {
  DEFAULT_FONT_ID,
  isBundledFamilyFontId,
  isFontId,
  resolveRenderableFontId,
  type FontFamily,
  type FontId,
} from './fonts'

/**
 * Font tier policy — "may this build use this font, and if not, what does it
 * render instead?"
 *
 * ## Why this file lives in `shared/` (REQ-0508)
 *
 * It used to be `src/renderer/lib/font-tier.ts`, and that location WAS the bug.
 * `canSelectFontInTier` had zero call sites under `src/main/`, so every headless
 * path — CLI `burn`, CLI `export_frame`, and therefore every MCP tool — rendered
 * whatever `fontId` it was handed. REQ-0507 §1 confirmed the leak with pixels,
 * not with reading: a free-tier `mojioko export_frame` drew Anton (glyph box
 * 333x75) and Dela Gothic One (716x77) where Noto SemiBold measures 539x78.
 *
 * A policy that only the renderer can reach is a policy the renderer's callers
 * can skip. Moving it here is what lets `ffmpeg-burnin.ts` / `frame-exporter.ts`
 * / `ass-generator.ts` apply the SAME function the picker and preview apply, so
 * GUI and headless cannot disagree about what a free build renders.
 */

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
 *
 * REQ-0508 — the parameter is the PAID-TIER flag.  In the renderer it arrives
 * as `useAppEnvStore().isMsix`; in the main process it arrives as
 * `resolveTier().isPaid`, which is the same answer plus the unpackaged-only
 * `MOJIOKO_FORCE_TIER` override (see `src/main/lib/tier.ts`).
 */
export function canSelectFontInTier(isPaid: boolean, fontId: FontId): boolean {
  if (isPaid) return true
  return isBundledFamilyFontId(fontId)
}

/**
 * REQ-088 #4 — companion check for "may the user download / install
 * this font?"  Always false for the default font (it's bundled, so the
 * concept doesn't apply) and always false in NSIS (free tier).  The
 * font picker uses this to swap the Download icon for a Lock icon.
 *
 * REQ-0508 — this remains a UI-side affordance ONLY, by owner decision: the
 * twelve additional families are published on GitHub, so anyone can drop the
 * TTFs into `%APPDATA%/MOJIOKO/fonts` by hand and closing the in-app download
 * button buys nothing. What matters is that USING them is gated, which is what
 * `resolveFontIdForTier` below does at render time.
 */
export function canDownloadFontInTier(isPaid: boolean, fontId: FontId): boolean {
  if (fontId === DEFAULT_FONT_ID) return false
  return isPaid
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
export function isFamilyTierLocked(isPaid: boolean, family: FontFamily): boolean {
  if (family.hasBundledWeight) return false
  return (
    !family.weights.some((w) => canSelectFontInTier(isPaid, w.fontId)) &&
    !family.weights.some((w) => canDownloadFontInTier(isPaid, w.fontId))
  )
}

/**
 * REQ-0508 §1-1 — **the one function that decides what a build actually
 * renders.** Given a tier and a requested font, return the font that may be
 * drawn: the request itself in the paid tier, or its free-tier substitute.
 *
 * ## Why it delegates instead of implementing its own ladder
 *
 * `resolveRenderableFontId` is the substitution ladder the GUI preview and the
 * GUI burn path have always used. Writing a second ladder here would give the
 * headless path its own opinion about what "Anton in a free build" looks like,
 * and REQ-0508 §1-5 rejects exactly that: a GUI and a CLI that substitute
 * differently is a NEW inconsistency, traded for the one being fixed.
 *
 * `isInstalled: () => true` is deliberate. This function answers the TIER
 * question only. Whether the TTF is on disk is a separate axis that the main
 * process already handles its own way (`stageFontsDir` throws when a staged
 * font is missing), and folding it in here would change failure behaviour for
 * the paid tier, which REQ-0508 puts out of scope.
 *
 * ## Where the substitute lands (§1-2)
 *
 * The bundled family, at the MATCHING WEIGHT: `anton` (400) → Noto Regular,
 * `poppins-bold` (700) → Noto Bold. Every one of the twelve paid families sits
 * on the 100–900 grid that Noto Sans JP covers in full, so today the weight
 * always maps exactly. Off-grid weights fall to the nearest one, and a build
 * where no Noto weight resolves at all falls to `DEFAULT_FONT_ID` — see the
 * ladder in `resolveRenderableFontId`.
 *
 * Idempotent: the output is always selectable, so applying it twice is the same
 * as applying it once. That is what lets it sit at several points on one path
 * (the caller resolving the Style default AND `generateAss` re-checking each
 * cue) without the second application changing the first one's answer.
 */
export function resolveFontIdForTier(isPaid: boolean, fontId: FontId): FontId {
  return resolveRenderableFontId(fontId, () => true, (id) => canSelectFontInTier(isPaid, id))
}

/** One requested→rendered pair, with how many visible cues it affects. */
export interface FontTierSubstitution {
  /** The font the project asked for. */
  from: FontId
  /** The font that will actually be drawn. */
  to: FontId
  /**
   * Number of NON-DELETED cues rendered with `to` instead of `from`.
   * `0` means only the project default font was substituted — no cue carries
   * an explicit override of it (see `defaultSubstituted`).
   */
  cueCount: number
}

export interface FontTierPolicyResult<E> {
  /** The project default font after substitution. */
  defaultFontId: FontId
  /**
   * `entries` with every tier-locked per-cue `fontId` rewritten. Untouched cues
   * keep their ORIGINAL object identity, so the paid tier — and any free build
   * that only uses Noto — flows through unchanged.
   */
  entries: E[]
  /** Empty when nothing was substituted. Ordered by first appearance. */
  substitutions: FontTierSubstitution[]
  /** True when the project's default font itself was tier-locked. */
  defaultSubstituted: boolean
}

/**
 * REQ-0508 §1 — apply {@link resolveFontIdForTier} to a whole burn: the project
 * default font plus every per-cue override, reporting what changed so the
 * caller can warn about it.
 *
 * Reporting is not optional. Substituting silently would recreate, in the one
 * place this REQ exists to fix, the "reports success for something that did not
 * happen" shape that REQ-0499 through REQ-0506 spent six requests removing.
 */
export function applyFontTierPolicy<E extends { fontId?: FontId; isDeleted?: boolean }>(
  isPaid: boolean,
  defaultFontId: FontId,
  entries: readonly E[],
): FontTierPolicyResult<E> {
  const resolvedDefault = resolveFontIdForTier(isPaid, defaultFontId)
  const defaultSubstituted = resolvedDefault !== defaultFontId

  // Count only cues that will be drawn: a warning saying "3 cues" when two of
  // them are deleted describes an output the user cannot see.
  const counts = new Map<string, FontTierSubstitution>()
  const note = (from: FontId, to: FontId, visible: boolean): void => {
    const key = `${from}>${to}`
    const hit = counts.get(key) ?? { from, to, cueCount: 0 }
    if (visible) hit.cueCount += 1
    counts.set(key, hit)
  }
  if (defaultSubstituted) note(defaultFontId, resolvedDefault, false)

  const mapped = entries.map((e) => {
    if (!isFontId(e.fontId)) return e
    const to = resolveFontIdForTier(isPaid, e.fontId)
    if (to === e.fontId) return e
    note(e.fontId, to, e.isDeleted !== true)
    return { ...e, fontId: to }
  })

  return {
    defaultFontId: resolvedDefault,
    entries: mapped,
    substitutions: [...counts.values()],
    defaultSubstituted,
  }
}
