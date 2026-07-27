/**
 * REQ-0311 §4 / REQ-0315 §2 — karaoke rendering style, an APP-WIDE setting
 * (not per-cue).
 *
 * ADOPTED.  The default is `'sweep'` (`\kf`, the fill sweeping left-to-right).
 * `'switch'` (`\k`, the instant flip) remains selectable.  The deletion list that
 * used to live here is gone — the feature is shipping, not on trial.
 *
 * Scope is the settings store rather than a field on `SubtitleEntry`, so the
 * shared entry type (a protected surface) stays untouched.  Accepted trade-off:
 * `\k` and `\kf` cannot be mixed within one project; the toggle applies to
 * every karaoke cue at once.
 *
 * Existing saved settings are NOT migrated (REQ-0315 §2): a user who has
 * explicitly stored a value keeps it.  That is why `coerceKaraokeStyle` names
 * BOTH values instead of falling through to the default — with the default now
 * `'sweep'`, a fall-through would silently rewrite a stored `'switch'`.
 */

/** `'switch'` = `\k` (instant).  `'sweep'` = `\kf` (fill) — the default. */
export type KaraokeStyle = 'switch' | 'sweep'

export const KARAOKE_STYLE_DEFAULT: KaraokeStyle = 'sweep'

/**
 * Narrows an unknown persisted value.
 *
 * BOTH valid values are matched explicitly.  A `v === 'sweep' ? … : DEFAULT`
 * form would, now that the default is `'sweep'`, rewrite a stored `'switch'`
 * into `'sweep'` on load — silently migrating exactly the users REQ-0315 §2
 * says must keep their choice.
 */
export function coerceKaraokeStyle(v: unknown): KaraokeStyle {
  if (v === 'switch') return 'switch'
  if (v === 'sweep') return 'sweep'
  return KARAOKE_STYLE_DEFAULT
}
