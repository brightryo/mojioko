import type { EncoderSetting, AudioMode, SubtitleBackground } from './types'
import { FADE_DURATION_SEC_DEFAULT } from './constants'

export type WhisperModelId = 'small' | 'medium' | 'large-v3' | string

/** Default subtitle styling applied to every transcribed entry. User-overridable via Settings. */
export const BURNIN_DEFAULTS = {
  fontSizePx: 100,
  // Uppercase hex to match the ColorPicker palette's normalisation (REQ-033)
  // so the default colours light up as "selected" in the swatch grid on
  // first launch.  Functionally identical to the previous lowercase values.
  textColorHex: '#FFFFFF',
  outlineColorHex: '#000000',
  outlineThicknessPx: 3,
  fadeEnabled: true,
  fadeDurationSec: FADE_DURATION_SEC_DEFAULT,
  whisperModel: 'medium' as WhisperModelId,

  horizontalPosition: 'center' as const,
  verticalPosition: 'bottom' as const,
  verticalMarginPx: 40,

  defaultAudioTrackIndex: 2,
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
  verticalPosition: 'top' | 'bottom'
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
