import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TranscriptionDefaults, TranscriptionAdvancedParams, BurninPosition, SubtitleBackground, AppSettings, EncoderSetting, AudioMode, OutputContainer } from '../../shared/types'
import { BURNIN_DEFAULTS } from '../../shared/burnin-defaults'
import { DEFAULT_LANGUAGE } from '../../shared/app-info'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, OUTLINE_THICKNESS_MAX_PX, TRANSCRIPTION_DEFAULTS } from '../../shared/constants'
import { DEFAULT_FONT_ID, isFontId, type FontId } from '../../shared/fonts'

interface SettingsStore {
  language: string
  transcriptionDefaults: TranscriptionDefaults
  transcriptionAdvanced: TranscriptionAdvancedParams
  autoLineBreak: boolean
  burnin: BurninPosition
  encoder: EncoderSetting
  audioMode: AudioMode
  defaultAudioTrackIndex: number
  fadeDurationSec: number
  subtitleBackground: SubtitleBackground
  /**
   * Step 3 output container choice.  Default `'mp4'` so users unfamiliar with
   * container formats land on the SNS-safe option (YouTube Shorts / TikTok /
   * Instagram Reels all require MP4).  Session-only — not persisted.
   */
  outputContainer: OutputContainer
  /**
   * Currently active subtitle font.  Drives both the CSS @font-face used by
   * SubtitleOverlay/Step 2 previews and the ASS `Style:` `Fontname` at
   * burn-in time.  Persisted alongside other system-wide settings.
   */
  activeFontId: FontId

  setLanguage: (lang: string) => void
  updateTranscriptionDefaults: (patch: Partial<TranscriptionDefaults>) => void
  setTranscriptionAdvanced: (patch: Partial<TranscriptionAdvancedParams>) => void
  resetTranscriptionAdvanced: () => void
  setAutoLineBreak: (v: boolean) => void
  updateBurnin: (patch: Partial<BurninPosition>) => void
  setEncoder: (e: EncoderSetting) => void
  setAudioMode: (m: AudioMode) => void
  setDefaultAudioTrackIndex: (i: number) => void
  setFadeDurationSec: (v: number) => void
  setSubtitleBackground: (v: SubtitleBackground) => void
  setOutputContainer: (v: OutputContainer) => void
  setActiveFontId: (id: FontId) => void

  /**
   * Reset Step 3-only UI state (`burnin`, `subtitleBackground`, `audioMode`)
   * to BURNIN_DEFAULTS.  Called when the user navigates to Step 1 so the next
   * Step 3 visit always starts from a clean slate.  Step 2 ⇔ Step 3
   * round-trips preserve the working values because Step 2 mount does NOT
   * call this.
   */
  resetStep3Settings: () => void

  /** Hydrate from loaded AppSettings (overwrites local state). */
  hydrate: (s: Pick<AppSettings, 'language' | 'transcriptionDefaults' | 'transcriptionAdvanced' | 'autoLineBreak' | 'burnin' | 'encoder' | 'audioMode' | 'defaultAudioTrackIndex' | 'fadeDurationSec' | 'subtitleBackground' | 'activeFontId'>) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      language: DEFAULT_LANGUAGE,
      transcriptionDefaults: {
        fontSizePx: BURNIN_DEFAULTS.fontSizePx,
        textColorHex: BURNIN_DEFAULTS.textColorHex,
        outlineColorHex: BURNIN_DEFAULTS.outlineColorHex,
        outlineThicknessPx: BURNIN_DEFAULTS.outlineThicknessPx,
        fadeEnabled: BURNIN_DEFAULTS.fadeEnabled,
        whisperModel: BURNIN_DEFAULTS.whisperModel
      },
      transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS },
      autoLineBreak: true,
      burnin: {
        horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
        verticalPosition: BURNIN_DEFAULTS.verticalPosition,
        verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx
      },
      encoder: BURNIN_DEFAULTS.encoder,
      audioMode: BURNIN_DEFAULTS.audioMode,
      defaultAudioTrackIndex: BURNIN_DEFAULTS.defaultAudioTrackIndex,
      fadeDurationSec: BURNIN_DEFAULTS.fadeDurationSec,
      subtitleBackground: { ...BURNIN_DEFAULTS.subtitleBackground },
      outputContainer: 'mp4',
      activeFontId: DEFAULT_FONT_ID,

      setLanguage: (lang) => set({ language: lang }),
      updateTranscriptionDefaults: (patch) =>
        set((s) => ({ transcriptionDefaults: { ...s.transcriptionDefaults, ...patch } })),
      setTranscriptionAdvanced: (patch) =>
        set((s) => ({ transcriptionAdvanced: { ...s.transcriptionAdvanced, ...patch } })),
      resetTranscriptionAdvanced: () =>
        set({ transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS } }),
      setAutoLineBreak: (v) => set({ autoLineBreak: v }),
      updateBurnin: (patch) =>
        set((s) => ({ burnin: { ...s.burnin, ...patch } })),
      setEncoder: (e) => set({ encoder: e }),
      setAudioMode: (m) => set({ audioMode: m }),
      setDefaultAudioTrackIndex: (i) => set({ defaultAudioTrackIndex: i }),
      setFadeDurationSec: (v) => set({ fadeDurationSec: v }),
      setSubtitleBackground: (v) => set({ subtitleBackground: v }),
      setOutputContainer: (v) => set({ outputContainer: v }),
      setActiveFontId: (id) => set({ activeFontId: id }),

      resetStep3Settings: () =>
        set({
          burnin: {
            horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
            verticalPosition: BURNIN_DEFAULTS.verticalPosition,
            verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx
          },
          subtitleBackground: { ...BURNIN_DEFAULTS.subtitleBackground },
          audioMode: BURNIN_DEFAULTS.audioMode,
          outputContainer: 'mp4'
        }),

      hydrate: (s) => {
        const td = s.transcriptionDefaults ?? {}
        const ta = s.transcriptionAdvanced ?? {}
        set({
          language: s.language,
          transcriptionDefaults: {
            ...td,
            fontSizePx: Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, td.fontSizePx ?? 100)),
            outlineThicknessPx: Math.min(OUTLINE_THICKNESS_MAX_PX, Math.max(0, td.outlineThicknessPx ?? 3))
          },
          transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS, ...ta },
          autoLineBreak: s.autoLineBreak ?? true,
          // Step 3 UI state — ALWAYS reset to defaults regardless of what
          // settings.json contains.  These fields are session-only by design;
          // stale persisted values from earlier versions (pre-v1.0.0) are
          // discarded here.
          burnin: {
            horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
            verticalPosition: BURNIN_DEFAULTS.verticalPosition,
            verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx
          },
          audioMode: BURNIN_DEFAULTS.audioMode,
          subtitleBackground: { ...BURNIN_DEFAULTS.subtitleBackground },
          outputContainer: 'mp4',
          // Persisted system-wide settings.
          encoder: s.encoder ?? 'auto',
          defaultAudioTrackIndex: s.defaultAudioTrackIndex,
          fadeDurationSec: s.fadeDurationSec ?? BURNIN_DEFAULTS.fadeDurationSec,
          activeFontId: isFontId(s.activeFontId) ? s.activeFontId : DEFAULT_FONT_ID
        })
      }
    }),
    {
      name: 'mojioko-settings',
      // Persist only the system-wide settings; Step 3 UI state (burnin,
      // subtitleBackground, audioMode) is intentionally session-only and is
      // reset on every navigation to Step 1.  See `resetStep3Settings`.
      partialize: (state) => ({
        language: state.language,
        transcriptionDefaults: state.transcriptionDefaults,
        transcriptionAdvanced: state.transcriptionAdvanced,
        autoLineBreak: state.autoLineBreak,
        encoder: state.encoder,
        defaultAudioTrackIndex: state.defaultAudioTrackIndex,
        fadeDurationSec: state.fadeDurationSec,
        activeFontId: state.activeFontId
      })
    }
  )
)
