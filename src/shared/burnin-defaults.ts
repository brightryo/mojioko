import type { EncoderSetting, AudioMode, SubtitleBackground } from './types'
import { FADE_DURATION_SEC_DEFAULT } from './constants'

/**
 * REQ-20260615-065 S-3 — explicit union narrowed to the two
 * v1.3.0 ship models: `'large-v3-turbo'` (fast, default,
 * "recommended" in UI) and `'large-v3'` (higher-quality, kept for
 * users who already have it on disk and prefer it).  Pre-v1.3 IDs
 * `'small'` / `'medium'` are no longer in the explicit union but
 * remain assignable through the open `| string` fallback so
 * already-persisted settings hydrate without type errors; the
 * settings-store hydrate pass then migrates them to
 * `'large-v3-turbo'` (REQ-065 S-4).  Disk files for the deprecated
 * models are deliberately NOT deleted — user can remove them via
 * the existing "open models folder" link.
 */
export type WhisperModelId = 'large-v3-turbo' | 'large-v3' | string

/** Default subtitle styling applied to every transcribed entry. User-overridable via Settings. */
export const BURNIN_DEFAULTS = {
  fontSizePx: 100,
  // Uppercase hex to match the ColorPicker palette's normalisation (REQ-033)
  // so the default colours light up as "selected" in the swatch grid on
  // first launch.  Functionally identical to the previous lowercase values.
  textColorHex: '#FFFFFF',
  outlineColorHex: '#000000',
  outlineThicknessPx: 3,
  // REQ-20260615-050 — single per-entry `fadeDurationSec` replaces the
  // `fadeEnabled` boolean + global duration pair.  `0` means no fade,
  // `0.1`–`0.5` is the in/out duration in seconds.  This value seeds
  // both the renderer's `settings.fadeDurationSec` (= default for new
  // entries) and the live entry field copied at creation time.
  fadeDurationSec: FADE_DURATION_SEC_DEFAULT,
  // REQ-20260615-066 — fresh-install default flips back to large-v3
  // (= "recommended" in UI).  REQ-065 had landed on turbo based on
  // synthetic Phase-0 benchmarks where turbo and large-v3 matched in
  // quality, but in real-world Japanese transcription turbo produces
  // more spurious / wrong-character errors than large-v3, so the
  // recommendation moves back to large-v3.  turbo remains in the
  // model line-up as a fast-path option, just without the badge.
  whisperModel: 'large-v3' as WhisperModelId,

  horizontalPosition: 'center' as const,
  verticalPosition: 'bottom' as const,
  verticalMarginPx: 40,

  // REQ-0251 案件A — fresh-install default is track 1 (the most common
  // main-audio case).  Multi-track editing (e.g. capture-card track 2 =
  // clean game/mic split) is an advanced pattern; users who need it flip
  // this in Settings once and their persisted value overrides the default
  // on hydrate (settings-store `{ ...defaults, ...parsed }` keeps the
  // saved value).  Prior default was 2, kept for existing users.
  defaultAudioTrackIndex: 1,
  encoder: 'auto' as EncoderSetting,
  audioMode: 'simple' as AudioMode,

  subtitleBackground: {
    enabled: false,
    color: 'black' as const,
    opacityPercent: 50
  }
} as const

/**
 * Per-row layout / background defaults seeded onto every new SubtitleEntry
 * (REQ-20260613-016 / v1.2.2 機能A).
 *
 * Drawn from `BURNIN_DEFAULTS` so the values are physically the same as the
 * legacy global panel default — but exposed via a dedicated factory so:
 *   1. Every creation site (fixtures, Step 2 add-row, transcription,
 *      duplicateRow, style-sample-preview) has a single source of truth.
 *   2. Phase 4 (global panel removal) can repoint these defaults without
 *      touching every call site.
 *   3. `subtitleBackground` is returned as a FRESH object literal each call
 *      so mutating one entry's background never aliases another entry's
 *      (BURNIN_DEFAULTS is `as const` = frozen, but spread would still
 *      share nested object identity).
 */
export function makeEntryLayoutDefaults(): {
  horizontalPosition: 'left' | 'center' | 'right'
  // REQ-0140 — widened to include `'center'`; default stays `'bottom'`.
  verticalPosition: 'top' | 'center' | 'bottom'
  verticalMarginPx: number
  subtitleBackground: SubtitleBackground
} {
  return {
    horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
    verticalPosition: BURNIN_DEFAULTS.verticalPosition,
    verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx,
    subtitleBackground: {
      enabled: BURNIN_DEFAULTS.subtitleBackground.enabled,
      color: BURNIN_DEFAULTS.subtitleBackground.color,
      opacityPercent: BURNIN_DEFAULTS.subtitleBackground.opacityPercent,
    },
  }
}
