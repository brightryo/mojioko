/**
 * REQ-0286 §0 — single tier-gate switch for karaoke (Phase B word-level
 * highlight).  Every UI surface, ass-generator emit path, and preview
 * renderer consults this ONE function to decide whether karaoke is
 * available in the current build.
 *
 * ## Current policy: paid (MSIX) only
 *
 * Karaoke ships paid-only for v1.3.6 because:
 *   - It is a marquee Phase B feature that motivates paid-tier adoption.
 *   - word_timestamps=True (RES-0285) adds ~10-25 % transcribe overhead
 *     for EVERY transcribe run; making karaoke paid-only aligns "who
 *     pays the cost" with "who gets the value".
 *
 * ## Flipping to free-tier: one-line change
 *
 * If a future REQ decides karaoke should be free too, change:
 *
 *   return isMsix
 *
 * to:
 *
 *   return true
 *
 * Every consumer (inspector / bulk-edit / DefaultStyleControls / ass-
 * generator / subtitle-overlay) reads through this function, so the
 * flip takes effect everywhere at once with no per-site edit.  A
 * regression test (`karaoke-gate.test.ts`) pins that this function is
 * the SOLE decision surface — if a future contributor bypasses it
 * with an inline `isMsix` check somewhere, that test breaks.
 *
 * ## Why not use canSelectFontInTier's shape
 *
 * `canSelectFontInTier(isMsix, fontId)` gates per-item (each font
 * declares its own eligibility).  Karaoke has no per-cue tier
 * variation — it is either enabled for the whole build or not — so
 * the interface is simply `(isMsix) => boolean` with no second
 * parameter.  A future per-cue variant (e.g. "karaoke only on cues
 * matching some criterion") would extend the signature, but the
 * flip-point stays in this one file.
 */
export function canUseKaraokeInTier(isMsix: boolean): boolean {
  return isMsix
}

/**
 * REQ-0286 / REQ-0290 — colour defaults used when the user first toggles
 * karaoke ON for a cue.
 *
 * ## Highlight (spoken/past words → ASS PrimaryColour, `\c`)
 *
 * `KARAOKE_DEFAULT_HIGHLIGHT_COLOR = '#FFFF00'` — yellow accent, matches
 * the TikTok / short-form-video convention users likely arrived
 * expecting.  Seeded into `karaokeHighlightColor` at toggle-ON so the
 * ColorPicker has a starting value; overridable per-cue.
 *
 * ## Base (unspoken/future words → ASS SecondaryColour, `\2c`)
 *
 * `KARAOKE_DEFAULT_BASE_COLOR = '#FFFFFF'` — kept as an exported constant
 * for API stability, but **not seeded at toggle-ON anymore** (REQ-0290
 * §1).  Instead every render path (`ass-generator`, `subtitle-overlay`,
 * `video-preview-panel` rAF loop) resolves an unset `karaokeBaseColor`
 * to the cue's `textColorHex`, so the user's per-row text colour is
 * preserved as the base half of the sweep after enabling karaoke.
 * The user can still explicitly pick a base colour via the ColorPicker;
 * that overrides the inheritance.
 *
 * This constant remains useful for tests and any future feature that
 * needs an absolute-white reference; nothing in the current code path
 * consults it at render time.
 */
export const KARAOKE_DEFAULT_HIGHLIGHT_COLOR = '#FFFF00'
export const KARAOKE_DEFAULT_BASE_COLOR = '#FFFFFF'
