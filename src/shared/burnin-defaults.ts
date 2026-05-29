import type { EncoderSetting, AudioMode } from './types'
import { FADE_DURATION_SEC_DEFAULT } from './constants'

export type WhisperModelId = 'small' | 'medium' | 'large-v3' | string

/** Default subtitle styling applied to every transcribed entry. User-overridable via Settings. */
export const BURNIN_DEFAULTS = {
  fontSizePx: 100,
  textColorHex: '#ffffff',
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
