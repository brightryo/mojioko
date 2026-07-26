/**
 * REQ-0286 §0 — single tier-gate switch for karaoke (Phase B word-level
 * highlight).  Every UI surface, ass-generator emit path, and preview
 * renderer consults this ONE function to decide whether karaoke is
 * available in the current build.
 *
 * ## Current policy: available to every tier (REQ-0299 §1)
 *
 * v1.3.6 originally shipped karaoke as paid-only (the argument was
 * that word_timestamps=True adds ~10-25 % transcribe overhead so
 * "who pays the cost gets the value" felt fair).  REQ-0299 §1
 * reverses that decision: owner made karaoke a general-use feature.
 * The paid-tier differentiation now lives entirely in the additional-
 * fonts + weight-selection package (`canSelectFontInTier`).
 *
 * The `isMsix` parameter is retained in the signature so consumers
 * that already pass it don't need to be edited — the value is
 * ignored for karaoke gating.  If a FUTURE REQ ever needs
 * per-tier karaoke behaviour again, uncomment the `return isMsix`
 * line below.
 *
 * ## Why this remains a helper (single decision surface)
 *
 * Callers (inspector / bulk-edit / DefaultStyleControls / ass-
 * generator / subtitle-overlay) all read through this function so
 * any future policy flip takes effect everywhere at once with no
 * per-site edit.  `karaoke-gate.test.ts` pins the current policy
 * and pins that this is the SOLE decision surface — if a future
 * contributor bypasses it with an inline `isMsix` check somewhere,
 * that test breaks.
 */
export function canUseKaraokeInTier(_isMsix: boolean): boolean {
  // REQ-0299 §1 — karaoke available to every tier.
  return true
}

/**
 * REQ-0286 / REQ-0290 / REQ-0293 — highlight colour default.
 *
 * ## Highlight (spoken/past words → ASS PrimaryColour, `\c`)
 *
 * `KARAOKE_DEFAULT_HIGHLIGHT_COLOR = '#FFFF00'` — yellow accent, matches
 * the TikTok / short-form-video convention users likely arrived
 * expecting.  Seeded into `karaokeHighlightColor` at toggle-ON so the
 * ColorPicker has a starting value; overridable per-cue.
 *
 * ## Base colour (unspoken/future words → ASS SecondaryColour, `\2c`)
 *
 * There is NO base-colour constant anymore.  REQ-0293 §2 removed the
 * per-cue `karaokeBaseColor` override entirely — the base half of the
 * karaoke sweep always tracks each cue's `textColorHex` at render
 * time in all three paths (ass-generator, subtitle-overlay, preview
 * rAF).  Users who want a different base colour change the cue's text
 * colour itself.  The old `KARAOKE_DEFAULT_BASE_COLOR` constant (=
 * `'#FFFFFF'`) was removed along with the field it seeded.
 */
export const KARAOKE_DEFAULT_HIGHLIGHT_COLOR = '#FFFF00'
