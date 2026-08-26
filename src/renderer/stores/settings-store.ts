import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { TranscriptionDefaults, TranscriptionAdvancedParams, AppSettings, AppTheme, BaseColor, EncoderSetting, AudioMode, OutputContainer } from '../../shared/types'
import { BURNIN_DEFAULTS } from '../../shared/burnin-defaults'
import { DEFAULT_LANGUAGE } from '../../shared/app-info'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, OUTLINE_THICKNESS_MAX_PX, SHADOW_DEPTH_MAX_PX, TRANSCRIPTION_DEFAULTS } from '../../shared/constants'
import { DEFAULT_FONT_ID, isFontId, type FontId } from '../../shared/fonts'
import { clampLineSpacingPercent } from '../../shared/line-spacing'
import { DEFAULT_TRANSLATION_TARGET, coerceTranslationTarget } from '../../shared/translation'
import { STYLE_PRESET_MAX, validatePresetName, type StylePreset } from '../../shared/style-preset'
import {
  rememberAnimationParams, sanitizeAnimationMemory, type AnimationMemory,
} from '../../shared/animation-memory'
import type { AnimationUiValue } from '../../shared/cue-animation'
// REQ-0311 §4 / REQ-0315 §2 — karaoke display style (adopted; default sweep).

interface SettingsStore {
  language: string
  /** REQ-20260615-026: app-wide colour theme.  Default 'dark'. */
  theme: AppTheme
  /** REQ-20260615-029: app-wide base neutral palette.  Default 'neutral'. */
  baseColor: BaseColor
  transcriptionDefaults: TranscriptionDefaults
  transcriptionAdvanced: TranscriptionAdvancedParams
  autoLineBreak: boolean
  /**
   * REQ-0426 — 「翻訳」設定タブ.  `translationAutoEnabled`: inspector auto-
   * translates on cue selection.  `translationTargetLang`: MADLAD target code
   * (`<2xx>`) it translates into.  Both are freely editable even when no
   * translation tool is downloaded (the gating lives in the inspector).
   */
  translationAutoEnabled: boolean
  translationTargetLang: string
  /** REQ-0443 §1 — preview timecode verbosity (false = simple M:SS, default). */
  playbackTimeDetailed: boolean
  /** REQ-0311 §4 / REQ-0315 §2 — karaoke display style (see shared/karaoke-style). */
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
  /**
   * REQ-0194 — user-preferred default folder for the `.mojioko` project
   * file save / open dialogs (Settings > General).  Same semantics as
   * `defaultInputDir` / `defaultOutputDir` (nullable → OS Videos fallback,
   * lazy existence check on use).
   */
  defaultProjectDir: string | null
  /**
   * REQ-0518 — three more folder rows (画像保存 / テキスト保存 / SRT入力).
   * Same shape and rules as the three above; the per-row OS fallback lives in
   * `shared/folder-settings.ts` and is applied by the main-side dialog handler.
   */
  defaultImageDir: string | null
  defaultTextDir: string | null
  defaultSrtDir: string | null
  /**
   * REQ-0208 — "user has clicked the Store review CTA in the export-
   * complete dialog at least once".  One-shot boolean: flips false → true
   * the first time the button is pressed and never flips back.  Used by
   * the dialog to decide whether to render the review row on future
   * exports (MSIX build only; the NSIS build never surfaces the row).
   *
   * Deliberately NOT threaded through `hydrate()` / AppSettings — the
   * flag lives only in zustand's own `persist` middleware (localStorage,
   * key `mojioko-settings`) and does NOT round-trip through the
   * main-process settings.json file.  This matters because the past
   * "setting lost on restart" regressions (GPU pick, default folder)
   * traced to hydrate() overwriting zustand-loaded values with a stale
   * settings.json subset.  By keeping this field out of both the
   * `Pick<AppSettings, ...>` hydrate signature AND the hydrate `set(...)`
   * body, the localStorage value is the ONLY source of truth for it,
   * and cannot be clobbered by an incomplete settings.json.
   */
  hasClickedStoreReview: boolean
  /**
   * REQ-0335 §3 — user-saved subtitle style presets, newest last.  Empty on
   * a fresh install; the owner's built-in presets are a separate list that
   * this array never contains.
   */
  stylePresets: StylePreset[]
  /**
   * REQ-0540 — the last animation parameters the user chose, per type.  Empty
   * until they tune one; every read falls back to `ANIMATION_TYPE_DEFAULTS`,
   * which is what makes an upgraded install behave exactly as it did.
   */
  animationMemory: AnimationMemory

  setLanguage: (lang: string) => void
  setTheme: (t: AppTheme) => void
  setBaseColor: (b: BaseColor) => void
  updateTranscriptionDefaults: (patch: Partial<TranscriptionDefaults>) => void
  setTranscriptionAdvanced: (patch: Partial<TranscriptionAdvancedParams>) => void
  resetTranscriptionAdvanced: () => void
  setAutoLineBreak: (v: boolean) => void
  /** REQ-0426 — 「翻訳」設定タブ setters. */
  setTranslationAutoEnabled: (v: boolean) => void
  setTranslationTargetLang: (v: string) => void
  setPlaybackTimeDetailed: (v: boolean) => void
  setEncoder: (e: EncoderSetting) => void
  setAudioMode: (m: AudioMode) => void
  setDefaultAudioTrackIndex: (i: number) => void
  setFadeDurationSec: (v: number) => void
  setOutputContainer: (v: OutputContainer) => void
  setActiveFontId: (id: FontId) => void
  setDefaultInputDir: (path: string | null) => void
  setDefaultOutputDir: (path: string | null) => void
  setDefaultProjectDir: (path: string | null) => void
  setDefaultImageDir: (path: string | null) => void
  setDefaultTextDir: (path: string | null) => void
  setDefaultSrtDir: (path: string | null) => void
  /**
   * REQ-0208 — one-way setter for the Store review CTA.  Only flips to
   * true (idempotent on repeat calls); there is no path back to false.
   * Intentionally takes no boolean argument to make misuse impossible.
   */
  markStoreReviewClicked: () => void

  /**
   * REQ-0335 §3-6 — append a preset.  Returns `false` (and changes nothing)
   * when the name is invalid or the cap is reached; the caller has already
   * validated with `validatePresetName` and surfaces the reason, so this is
   * a belt-and-braces guard rather than the user-facing check.
   */
  addStylePreset: (preset: StylePreset) => boolean
  /** Rename in place, keeping the id (the picker keys on it). */
  renameStylePreset: (id: string, name: string) => boolean
  deleteStylePreset: (id: string) => void

  /**
   * REQ-20260613-016 Phase 4 — `burnin` / `subtitleBackground` were dropped
   * from the store along with the global panel UI; the per-row data
   * model on each SubtitleEntry replaces them.  `resetStep3Settings`
   * still resets `audioMode` + `outputContainer` so the navigation
   * lifecycle (Step 1 ⇆ Step 3) clears the Step 3-only choices.
   */
  resetStep3Settings: () => void

  /**
   * REQ-0540 — record the parameters now in use for `value.type`.
   *
   * The ONLY writer is `AnimationControls`' commit handlers.  Opening a
   * project, applying a preset, undo/redo and new-cue stamping must never
   * reach this — see `shared/animation-memory.ts` for the full list and why
   * none of them can.
   */
  rememberAnimation: (value: AnimationUiValue) => void

  /** Hydrate from loaded AppSettings (overwrites local state). */
  hydrate: (s: Pick<AppSettings, 'language' | 'theme' | 'baseColor' | 'transcriptionDefaults' | 'transcriptionAdvanced' | 'autoLineBreak' | 'translationAutoEnabled' | 'translationTargetLang' | 'playbackTimeDetailed' | 'encoder' | 'audioMode' | 'defaultAudioTrackIndex' | 'fadeDurationSec' | 'activeFontId' | 'defaultInputDir' | 'defaultOutputDir' | 'defaultProjectDir' | 'defaultImageDir' | 'defaultTextDir' | 'defaultSrtDir' | 'stylePresets' | 'animationMemory'>) => void
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
      // REQ-0426 — auto-translate off by default; target defaults to English
      // (the previously-fixed target), so nothing changes until the user opts in.
      translationAutoEnabled: false,
      translationTargetLang: DEFAULT_TRANSLATION_TARGET,
      // REQ-0443 §1 — timecode starts simple (M:SS); click toggles to detailed.
      playbackTimeDetailed: false,
      encoder: BURNIN_DEFAULTS.encoder,
      audioMode: BURNIN_DEFAULTS.audioMode,
      defaultAudioTrackIndex: BURNIN_DEFAULTS.defaultAudioTrackIndex,
      fadeDurationSec: BURNIN_DEFAULTS.fadeDurationSec,
      outputContainer: 'mp4',
      activeFontId: DEFAULT_FONT_ID,
      defaultInputDir: null,
      defaultOutputDir: null,
      defaultProjectDir: null,
      defaultImageDir: null,
      defaultTextDir: null,
      defaultSrtDir: null,
      // REQ-0208 — user has not yet clicked the Store review CTA.  Once
      // true, stays true across sessions via the persist middleware.
      hasClickedStoreReview: false,
      // REQ-0335 §3 — no built-in presets ship in v1.3.6 (the owner will
      // author their contents later); the mechanism starts empty.
      stylePresets: [],
      // REQ-0540 — nothing remembered yet: every type seeds from the fixed table.
      animationMemory: {},

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
      setTranslationAutoEnabled: (v) => set({ translationAutoEnabled: v }),
      setTranslationTargetLang: (v) => set({ translationTargetLang: v }),
      setPlaybackTimeDetailed: (v) => set({ playbackTimeDetailed: v }),
      setEncoder: (e) => set({ encoder: e }),
      setAudioMode: (m) => set({ audioMode: m }),
      setDefaultAudioTrackIndex: (i) => set({ defaultAudioTrackIndex: i }),
      setFadeDurationSec: (v) => set({ fadeDurationSec: v }),
      setOutputContainer: (v) => set({ outputContainer: v }),
      setActiveFontId: (id) => set({ activeFontId: id }),
      setDefaultInputDir: (path) => set({ defaultInputDir: path }),
      setDefaultOutputDir: (path) => set({ defaultOutputDir: path }),
      setDefaultProjectDir: (path) => set({ defaultProjectDir: path }),
      setDefaultImageDir: (path) => set({ defaultImageDir: path }),
      setDefaultTextDir: (path) => set({ defaultTextDir: path }),
      setDefaultSrtDir: (path) => set({ defaultSrtDir: path }),
      markStoreReviewClicked: () => set({ hasClickedStoreReview: true }),

      addStylePreset: (preset) => {
        let ok = false
        set((s) => {
          if (validatePresetName(preset.name, s.stylePresets) !== null) return s
          ok = true
          return { stylePresets: [...s.stylePresets, preset] }
        })
        return ok
      },
      renameStylePreset: (id, name) => {
        let ok = false
        set((s) => {
          if (validatePresetName(name, s.stylePresets, { ignoreId: id }) !== null) return s
          ok = true
          return {
            stylePresets: s.stylePresets.map((p) =>
              p.id === id ? { ...p, name: name.trim() } : p,
            ),
          }
        })
        return ok
      },
      deleteStylePreset: (id) =>
        set((s) => ({ stylePresets: s.stylePresets.filter((p) => p.id !== id) })),

      rememberAnimation: (value) =>
        set((s) => ({ animationMemory: rememberAnimationParams(s.animationMemory, value) })),

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
            // REQ-0295 — explicit field-by-field passthrough of every
            // TranscriptionDefaults key, driven by
            // `Object.prototype.hasOwnProperty` semantics via the `td.<key>`
            // reads.  The trailing `...tdCleaned` spread ONLY appears to
            // preserve `whisperModel` (the one required field the code
            // above doesn't clamp explicitly).  A future refactor that
            // introduces `AppSettings.transcriptionDefaults` schema
            // migration should replace this with a proper allowlist —
            // REQ-0279 documented the class of clobber bug that happens
            // when nested-object hydrate silently drops fields.  For
            // v1.3.6 the additive-optional contract + the trailing
            // spread is enough: any legacy save that has more keys than
            // the current type declares still flows through, and any
            // new key added here is preserved because the ALL-optional
            // fields hydrate via the explicit line below.
            ...tdCleaned,
            fontSizePx: Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, td.fontSizePx ?? 100)),
            outlineThicknessPx: Math.min(OUTLINE_THICKNESS_MAX_PX, Math.max(0, td.outlineThicknessPx ?? 3)),

            // REQ-0295 — additive optional fields.  Clamp what needs
            // clamping (shadowDepth, shadowAlpha, rotation) and pass
            // string / boolean fields through unchanged.  `undefined`
            // stays `undefined` (falls back to the per-cue neutral
            // default at render time — see TranscriptionDefaults
            // docstring for the mapping).
            shadowDepth: td.shadowDepth === undefined
              ? undefined
              : Math.min(SHADOW_DEPTH_MAX_PX, Math.max(0, td.shadowDepth)),
            shadowColor: td.shadowColor,
            shadowAlpha: td.shadowAlpha === undefined
              ? undefined
              : Math.min(100, Math.max(0, td.shadowAlpha)),
            // REQ-0310 — text / outline opacity.  `undefined` MUST stay
            // `undefined`: writing `?? 100` here would turn "the user never
            // touched this" into a persisted 100 and defeat the
            // additive-optional contract (the REQ-0279 clobber class).  0 is a
            // legal saved value and is clamped only against out-of-range junk.
            textAlpha: td.textAlpha === undefined
              ? undefined
              : Math.min(100, Math.max(0, td.textAlpha)),
            outlineAlpha: td.outlineAlpha === undefined
              ? undefined
              : Math.min(100, Math.max(0, td.outlineAlpha)),
            karaokeEnabled: td.karaokeEnabled,
            karaokeHighlightColor: td.karaokeHighlightColor,
            casing: td.casing === 'uppercase' ? 'uppercase' : td.casing === 'none' ? 'none' : undefined,
            rotation: td.rotation === undefined
              ? undefined
              : (((td.rotation % 360) + 360) % 360),
            horizontalPosition: td.horizontalPosition === 'left' || td.horizontalPosition === 'center' || td.horizontalPosition === 'right'
              ? td.horizontalPosition
              : undefined,
            verticalPosition: td.verticalPosition === 'top' || td.verticalPosition === 'center' || td.verticalPosition === 'bottom'
              ? td.verticalPosition
              : undefined,
            verticalMarginPx: td.verticalMarginPx === undefined
              ? undefined
              : Math.max(0, Math.floor(td.verticalMarginPx)),
            // REQ-0332 — line spacing (行間), clamped on load like every
            // other numeric default so a hand-edited settings.json cannot
            // push the slider out of range.
            lineSpacingPercent: td.lineSpacingPercent === undefined
              ? undefined
              : clampLineSpacingPercent(Math.round(td.lineSpacingPercent)),
            posOffsetX: td.posOffsetX === undefined ? undefined : Math.floor(td.posOffsetX),
            posOffsetY: td.posOffsetY === undefined ? undefined : Math.floor(td.posOffsetY),
          },
          transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS, ...ta },
          autoLineBreak: s.autoLineBreak ?? true,
          // REQ-0426 — optional in AppSettings; absent ≡ off / default target.
          translationAutoEnabled: s.translationAutoEnabled ?? false,
          translationTargetLang: coerceTranslationTarget(s.translationTargetLang),
          // REQ-0443 §1 — optional in AppSettings; absent ≡ simple.
          playbackTimeDetailed: s.playbackTimeDetailed ?? false,
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
          defaultOutputDir: typeof s.defaultOutputDir === 'string' ? s.defaultOutputDir : null,
          // REQ-0194 — optional for backward compat with settings.json files
          // that predate the project-save feature.  Same fallback semantics.
          defaultProjectDir: typeof s.defaultProjectDir === 'string' ? s.defaultProjectDir : null,
          defaultImageDir: typeof s.defaultImageDir === 'string' ? s.defaultImageDir : null,
          defaultTextDir: typeof s.defaultTextDir === 'string' ? s.defaultTextDir : null,
          defaultSrtDir: typeof s.defaultSrtDir === 'string' ? s.defaultSrtDir : null,
          // REQ-0335 §3 — presets from settings.json.  Only the envelope is
          // validated here (id / name / style object); individual style
          // fields are NOT clamped, because a preset written by a NEWER
          // build may legitimately carry keys this build does not know, and
          // dropping them would corrupt the file on the next save.  Unknown
          // keys are inert: `resolveStylePresetPatch` iterates the keys this
          // build classifies, so it simply does not read them.
          stylePresets: Array.isArray(s.stylePresets)
            ? s.stylePresets
                .filter(
                  (p): p is StylePreset =>
                    !!p &&
                    typeof p.id === 'string' &&
                    typeof p.name === 'string' &&
                    !!p.style &&
                    typeof p.style === 'object',
                )
                .slice(0, STYLE_PRESET_MAX)
            : [],
          // REQ-0540 — absent in every settings.json written before this REQ,
          // and `sanitizeAnimationMemory` turns that into `{}` = "nothing
          // remembered" = the pre-REQ behaviour, with no migration.
          animationMemory: sanitizeAnimationMemory(s.animationMemory)
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
        // REQ-0426 — dual persistence (localStorage here + settings.json via
        // App.tsx save + `incoming-wins` merge), same as other renderer-owned settings.
        translationAutoEnabled: state.translationAutoEnabled,
        translationTargetLang: state.translationTargetLang,
        // REQ-0443 §1 — dual persistence (localStorage + settings.json).
        playbackTimeDetailed: state.playbackTimeDetailed,
        encoder: state.encoder,
        defaultAudioTrackIndex: state.defaultAudioTrackIndex,
        fadeDurationSec: state.fadeDurationSec,
        activeFontId: state.activeFontId,
        defaultInputDir: state.defaultInputDir,
        defaultOutputDir: state.defaultOutputDir,
        defaultProjectDir: state.defaultProjectDir,
        // REQ-0208 — persist through localStorage only.  See interface
        // doc-comment for why this field is NOT in the AppSettings /
        // hydrate() path.
        hasClickedStoreReview: state.hasClickedStoreReview,
        // REQ-0335 §3-6 — presets round-trip through BOTH localStorage
        // (here) and settings.json (via App.tsx's debounced save + the
        // `incoming-wins` merge rule).  Same dual persistence every other
        // renderer-owned setting already has.
        stylePresets: state.stylePresets,
        // REQ-0540 — same dual persistence as stylePresets: localStorage here,
        // settings.json via App.tsx's debounced save.
        animationMemory: state.animationMemory
      })
    }
  )
)
