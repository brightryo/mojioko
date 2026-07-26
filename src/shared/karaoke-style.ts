/**
 * REQ-0311 §4 — karaoke rendering style, an APP-WIDE setting (not per-cue).
 *
 * Owner decision: scoping this to the settings store rather than adding a field
 * to `SubtitleEntry` keeps the shared entry type — a REQ-0311 protected
 * surface — untouched, and makes the experiment trivially removable.  The
 * trade-off accepted with it: `\k` and `\kf` cannot be mixed within one
 * project; the toggle applies to every karaoke cue at once.
 *
 * DELETION LIST for dropping the sweep experiment:
 *   1. this file
 *   2. `src/shared/karaoke-sweep.ts` + `tests/unit/karaoke-sweep-req-0311.test.ts`
 *   3. `karaokeStyle` / `setKaraokeStyle` in `settings-store.ts` (+ its
 *      persistence entry and the main-process settings schema)
 *   4. the `karaokeStyle === 'sweep'` ternary in `ass-generator.ts`
 *   5. the sweep branch in `subtitle-overlay.tsx` and in the rAF loop in
 *      `video-preview-panel.tsx`
 *   6. the `karaokeStyleRow` StyleRow in `timeline-block-inspector.tsx` and the
 *      `styleCell.karaokeStyle*` i18n keys in ja/en `step2.json`
 * Nothing in the shipping `\k` path changes.
 */

/** `'switch'` = `\k` (instant, shipping default).  `'sweep'` = `\kf` (fill). */
export type KaraokeStyle = 'switch' | 'sweep'

export const KARAOKE_STYLE_DEFAULT: KaraokeStyle = 'switch'

/** Narrows an unknown persisted value, falling back to the shipping default. */
export function coerceKaraokeStyle(v: unknown): KaraokeStyle {
  return v === 'sweep' ? 'sweep' : KARAOKE_STYLE_DEFAULT
}
