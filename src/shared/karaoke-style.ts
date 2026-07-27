/**
 * REQ-0311 §4 / REQ-0315 §2 / REQ-0322 §3 — karaoke rendering style.
 *
 * ADOPTED.  The default is `sweep` (ASS `\kf`, the fill sweeping
 * left-to-right).  `switch` (ASS `\k`, the instant flip) remains selectable.
 *
 * **Scope: PER-CUE since REQ-0322 §3.**  It began app-wide (a settings-store
 * field only) to keep `SubtitleEntry` — a protected surface — untouched.  The
 * owner then asked for per-clip control, and approved the additive field, so
 * `SubtitleEntry.karaokeStyle` is now the authority for a cue and the settings
 * value has become the **default for cues that have not chosen one**.
 * `switch` and `sweep` can therefore be mixed within a single project.
 *
 * Two different narrowing functions, for two different jobs — do not swap them:
 *
 *   - `coerceKaraokeStyle`  — for the PERSISTED SETTINGS value.  `undefined`
 *     legitimately means "never set", so it resolves to a concrete default.
 *   - `resolveKaraokeStyle` — for a CUE's value.  `undefined` means "follow
 *     the default", so the caller supplies that default rather than a
 *     hard-coded one.  Using `coerceKaraokeStyle` here would freeze whatever
 *     `KARAOKE_STYLE_DEFAULT` happens to be today into every untouched cue,
 *     which is the exact trap REQ-0315 §2 documents one level down.
 *
 * Existing saved settings are NOT migrated, and neither are existing project
 * files: a cue with no `karaokeStyle` stays `undefined` and follows the
 * default.  That is why `coerceKaraokeStyle` names BOTH values explicitly
 * instead of falling through — with the default now `sweep`, a fall-through
 * would silently rewrite a stored `switch`.
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

/**
 * Resolve a CUE's karaoke style.
 *
 * @param cueStyle  `entry.karaokeStyle` — `undefined` means "no per-cue
 *                  choice; follow the default".  An unrecognised value
 *                  (hand-edited project file) is treated the same way.
 * @param fallback  The new-cue default, i.e. `useSettingsStore.karaokeStyle`
 *                  in the renderer or the `karaokeStyle` field of the burn-in
 *                  request in main.
 *
 * Both render paths (CSS preview and the ASS writer) MUST call this, or they
 * will disagree about a cue — which is precisely the preview/burn-in split
 * that hid REQ-0320 §1 for a whole release cycle.
 */
export function resolveKaraokeStyle(
  cueStyle: unknown,
  fallback: KaraokeStyle,
): KaraokeStyle {
  if (cueStyle === 'switch') return 'switch'
  if (cueStyle === 'sweep') return 'sweep'
  return fallback
}
