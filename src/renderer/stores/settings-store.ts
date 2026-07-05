import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TranscriptionDefaults, TranscriptionAdvancedParams, AppSettings, AppTheme, BaseColor, EncoderSetting, AudioMode, OutputContainer } from '../../shared/types'
import { BURNIN_DEFAULTS } from '../../shared/burnin-defaults'
import { DEFAULT_LANGUAGE } from '../../shared/app-info'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, OUTLINE_THICKNESS_MAX_PX, TRANSCRIPTION_DEFAULTS } from '../../shared/constants'
import { DEFAULT_FONT_ID, isFontId, type FontId } from '../../shared/fonts'

interface SettingsStore {
  language: string
  /** REQ-20260615-026: app-wide colour theme.  Default 'dark'. */
  theme: AppTheme
  /** REQ-20260615-029: app-wide base neutral palette.  Default 'neutral'. */
  baseColor: BaseColor
  transcriptionDefaults: TranscriptionDefaults
  transcriptionAdvanced: TranscriptionAdvancedParams
  autoLineBreak: boolean
  encoder: EncoderSetting
  audioMode: AudioMode
  defaultAudioTrackIndex: number
  fadeDurationSec: number
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
  /**
   * REQ-0121 — user-preferred fixed default folders shown by the input /
   * output dialogs (Settings > General).  Distinct from the MRU
   * `lastInputDir` / `lastOutputDir` on the main-side settings-store which
   * are updated automatically after each open/save.  `null` means "use the
   * OS Videos folder", which the main-side dialog handler resolves.
   */
  defaultInputDir: string | null
  defaultOutputDir: string | null

  setLanguage: (lang: string) => void
  setTheme: (t: AppTheme) => void
  setBaseColor: (b: BaseColor) => void
  updateTranscriptionDefaults: (patch: Partial<TranscriptionDefaults>) => void
  setTranscriptionAdvanced: (patch: Partial<TranscriptionAdvancedParams>) => void
  resetTranscriptionAdvanced: () => void
  setAutoLineBreak: (v: boolean) => void
  setEncoder: (e: EncoderSetting) => void
  setAudioMode: (m: AudioMode) => void
  setDefaultAudioTrackIndex: (i: number) => void
  setFadeDurationSec: (v: number) => void
  setOutputContainer: (v: OutputContainer) => void
  setActiveFontId: (id: FontId) => void
  setDefaultInputDir: (path: string | null) => void
  setDefaultOutputDir: (path: string | null) => void

  /**
   * REQ-20260613-016 Phase 4 — `burnin` / `subtitleBackground` were dropped
   * from the store along with the global panel UI; the per-row data
   * model on each SubtitleEntry replaces them.  `resetStep3Settings`
   * still resets `audioMode` + `outputContainer` so the navigation
   * lifecycle (Step 1 ⇆ Step 3) clears the Step 3-only choices.
   */
  resetStep3Settings: () => void

  /** Hydrate from loaded AppSettings (overwrites local state). */
  hydrate: (s: Pick<AppSettings, 'language' | 'theme' | 'baseColor' | 'transcriptionDefaults' | 'transcriptionAdvanced' | 'autoLineBreak' | 'encoder' | 'audioMode' | 'defaultAudioTrackIndex' | 'fadeDurationSec' | 'activeFontId' | 'defaultInputDir' | 'defaultOutputDir'>) => void
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      language: DEFAULT_LANGUAGE,
      theme: 'dark',
      baseColor: 'neutral',
      transcriptionDefaults: {
        fontSizePx: BURNIN_DEFAULTS.fontSizePx,
        textColorHex: BURNIN_DEFAULTS.textColorHex,
        outlineColorHex: BURNIN_DEFAULTS.outlineColorHex,
        outlineThicknessPx: BURNIN_DEFAULTS.outlineThicknessPx,
        whisperModel: BURNIN_DEFAULTS.whisperModel
      },
      transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS },
      autoLineBreak: true,
      encoder: BURNIN_DEFAULTS.encoder,
      audioMode: BURNIN_DEFAULTS.audioMode,
      defaultAudioTrackIndex: BURNIN_DEFAULTS.defaultAudioTrackIndex,
      fadeDurationSec: BURNIN_DEFAULTS.fadeDurationSec,
      outputContainer: 'mp4',
      activeFontId: DEFAULT_FONT_ID,
      defaultInputDir: null,
      defaultOutputDir: null,

      setLanguage: (lang) => set({ language: lang }),
      setTheme: (t) => set({ theme: t }),
      setBaseColor: (b) => set({ baseColor: b }),
      updateTranscriptionDefaults: (patch) =>
        set((s) => ({ transcriptionDefaults: { ...s.transcriptionDefaults, ...patch } })),
      setTranscriptionAdvanced: (patch) =>
        set((s) => ({ transcriptionAdvanced: { ...s.transcriptionAdvanced, ...patch } })),
      resetTranscriptionAdvanced: () =>
        set({ transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS } }),
      setAutoLineBreak: (v) => set({ autoLineBreak: v }),
      setEncoder: (e) => set({ encoder: e }),
      setAudioMode: (m) => set({ audioMode: m }),
      setDefaultAudioTrackIndex: (i) => set({ defaultAudioTrackIndex: i }),
      setFadeDurationSec: (v) => set({ fadeDurationSec: v }),
      setOutputContainer: (v) => set({ outputContainer: v }),
      setActiveFontId: (id) => set({ activeFontId: id }),
      setDefaultInputDir: (path) => set({ defaultInputDir: path }),
      setDefaultOutputDir: (path) => set({ defaultOutputDir: path }),

      resetStep3Settings: () =>
        set({
          audioMode: BURNIN_DEFAULTS.audioMode,
          outputContainer: 'mp4'
        }),

      hydrate: (s) => {
        // REQ-20260615-050 — migration of the legacy fade representation.
        // Pre-REQ persisted state held two values:
        //   - `transcriptionDefaults.fadeEnabled: boolean` (default ON/OFF
        //     for new entries)
        //   - `fadeDurationSec: number` (global duration, 0.1–0.5)
        // The new model has a single per-entry / per-setting
        // `fadeDurationSec ∈ [0, 0.5]` where `0` means no fade.  Migration
        // rules:
        //   - explicit `fadeEnabled === false` → settings.fadeDurationSec
        //     coerced to 0 (user had opted out)
        //   - any other case (undefined / true) → preserve the stored
        //     fadeDurationSec, falling back to BURNIN_DEFAULTS.
        // The legacy `fadeEnabled` field is also stripped from the
        // `transcriptionDefaults` object so it does not leak forward.
        const td = s.transcriptionDefaults ?? {}
        const tdLegacy = td as { fadeEnabled?: boolean }
        const fadeOptedOut = tdLegacy.fadeEnabled === false
        const migratedFadeDurationSec =
          fadeOptedOut
            ? 0
            : (s.fadeDurationSec ?? BURNIN_DEFAULTS.fadeDurationSec)
        const tdCleaned: Omit<typeof td, 'fadeEnabled'> & { fadeEnabled?: never } = { ...td }
        delete (tdCleaned as { fadeEnabled?: boolean }).fadeEnabled

        const ta = s.transcriptionAdvanced ?? {}
        set({
          language: s.language,
          theme: s.theme === 'light' ? 'light' : 'dark',
          baseColor: (['neutral', 'stone', 'mauve', 'olive', 'mist', 'taupe'] as const).includes(s.baseColor as BaseColor)
            ? (s.baseColor as BaseColor)
            : 'neutral',
          transcriptionDefaults: {
            ...tdCleaned,
            fontSizePx: Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, td.fontSizePx ?? 100)),
            outlineThicknessPx: Math.min(OUTLINE_THICKNESS_MAX_PX, Math.max(0, td.outlineThicknessPx ?? 3))
          },
          transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS, ...ta },
          autoLineBreak: s.autoLineBreak ?? true,
          // Step 3 session-only state — ALWAYS reset to defaults regardless
          // of what settings.json contains.
          audioMode: BURNIN_DEFAULTS.audioMode,
          outputContainer: 'mp4',
          // Persisted system-wide settings.
          encoder: s.encoder ?? 'auto',
          defaultAudioTrackIndex: s.defaultAudioTrackIndex,
          fadeDurationSec: migratedFadeDurationSec,
          activeFontId: isFontId(s.activeFontId) ? s.activeFontId : DEFAULT_FONT_ID,
          // REQ-0121 — optional in AppSettings for backward compat with
          // settings.json files that predate this REQ.  `null` = use the
          // OS Videos folder (resolved by the main-side dialog handler).
          defaultInputDir: typeof s.defaultInputDir === 'string' ? s.defaultInputDir : null,
          defaultOutputDir: typeof s.defaultOutputDir === 'string' ? s.defaultOutputDir : null
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
        theme: state.theme,
        baseColor: state.baseColor,
        transcriptionDefaults: state.transcriptionDefaults,
        transcriptionAdvanced: state.transcriptionAdvanced,
        autoLineBreak: state.autoLineBreak,
        encoder: state.encoder,
        defaultAudioTrackIndex: state.defaultAudioTrackIndex,
        fadeDurationSec: state.fadeDurationSec,
        activeFontId: state.activeFontId,
        defaultInputDir: state.defaultInputDir,
        defaultOutputDir: state.defaultOutputDir
      })
    }
  )
)
