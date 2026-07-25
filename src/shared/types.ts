import type { WhisperModelId } from './burnin-defaults'
import type { FontId } from './fonts'
export type { WhisperModelId }

// ---------------------------------------------------------------------------
// Video / Audio
// ---------------------------------------------------------------------------

export interface AudioTrack {
  /** 1-based index matching user-facing display. */
  index: number
  channels: 'mono' | 'stereo' | string
  sampleRateHz: number
  codec: string
  language?: string
}

export interface VideoInfo {
  path: string
  /**
   * REQ-027/028: `false` for audio-only inputs (mp3 / wav / m4a / aac /
   * flac / ogg).  When false, `widthPx` / `heightPx` / `fps` / `videoCodec`
   * are placeholders (0 / '') with no meaning — callers must check this
   * flag before reading them.  Existing video flows that read these
   * fields unconditionally continue to work for video inputs because
   * those still set the flag to `true`.
   */
  hasVideoStream: boolean
  widthPx: number
  heightPx: number
  durationSec: number
  fps: number
  container: 'mp4' | 'mkv' | string
  videoCodec: string
  audioTracks: AudioTrack[]
  fileSizeBytes: number
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

export interface SubtitleEntryOriginal {
  startSec: number
  endSec: number
  text: string
  /** Integer, 30–600 px. */
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  /** Integer, 0–5 px. */
  outlineThicknessPx: number
  /**
   * REQ-20260615-050 — per-entry fade ramp duration in seconds.
   *
   * Range: `[0, 0.5]`, step 0.1.  Semantics: **`0` means no fade**
   * (the ASS writer skips `\fad`, the preview rAF skips the opacity
   * ramp), `0.1`–`0.5` is the in/out duration applied symmetrically
   * (same value for fade-in and fade-out, matching libass `\fad(t,t)`).
   *
   * Replaces the legacy boolean `fadeEnabled` + global setting pair —
   * the migration path on store hydrate seeds this from the old
   * `fadeEnabled ? settings.fadeDurationSec : 0`.  New entries copy
   * `settings.fadeDurationSec` at creation time so the consolidated
   * General-tab slider IS the "default for new entries".
   */
  fadeDurationSec: number
  /**
   * Optional per-row font override.  When undefined, the row inherits the
   * project default (`useSettingsStore.activeFontId`) — both for preview
   * width measurement and for ASS `\fn` emission at burn-in time.  Stored
   * here (rather than only on the live entry) so the "Reset row" button
   * has a stable per-row reference point.  REQ-021.
   */
  fontId?: FontId
  /**
   * Per-row subtitle layout (REQ-20260613-016 / v1.2.2 機能A).
   *
   * Required (not optional) because the v1.2.2 data model is "作成時コピー
   * 方式" — every entry carries its own concrete values, no global
   * fallback at render time.  All entry-creation sites (fixtures, Step 2
   * add-row dialog, transcription segment mapping, duplicateRow,
   * style-sample-preview) seed from `ENTRY_LAYOUT_DEFAULTS` in
   * `shared/burnin-defaults.ts`.
   */
  horizontalPosition: 'left' | 'center' | 'right'
  /**
   * REQ-0140 — widened from `'top' | 'bottom'` (CLAUDE.md §21 protected
   * `SubtitleEntry` field, owner-approved 2026-07-08).  When `'center'`
   * the entry ignores `verticalMarginPx` (libass `\an4/5/6` anchors at
   * the vertical middle regardless of MarginV), and the inspector /
   * bulk-edit margin input is disabled with an explanatory tooltip.
   * `'top'` / `'bottom'` retain their pre-REQ-0140 semantics.
   */
  verticalPosition: 'top' | 'center' | 'bottom'
  verticalMarginPx: number
  /**
   * Per-row subtitle background (REQ-20260613-016 / v1.2.2 機能A).
   *
   * Same "作成時コピー方式" — required concrete value seeded from
   * `ENTRY_LAYOUT_DEFAULTS.subtitleBackground` at creation time.
   */
  subtitleBackground: SubtitleBackground
  /**
   * Free-position override (REQ-20260613-016 / v1.2.2 機能B).
   *
   * ASS coordinate space (= output video pixel space, same as
   * PlayResX/Y).  When both `posX` and `posY` are defined the row is
   * pinned at that point via `\pos(x,y)` and the alignment / MarginV
   * fields above are ignored on burn-in.  Independently undefined →
   * row uses alignment-based layout.  `\pos` is set/cleared as a pair;
   * see ass-generator and subtitle-overlay for the consumption sites.
   */
  posX?: number
  posY?: number

  // ---------------------------------------------------------------------------
  // REQ-0277 Phase A — additional per-row style effects.  All optional +
  // neutral default so existing project files (pre-REQ-0277) hydrate as
  // "effect off" without any migration.  Renderers (ass-generator + CSS
  // preview) treat `undefined` identically to "off" / neutral value.
  // ---------------------------------------------------------------------------
  /**
   * REQ-0277 §1 — display-only casing transform.  `'uppercase'` renders
   * the text in ALL CAPS at burn-in + preview time WITHOUT mutating the
   * stored transcript.  SRT export uses the original text unchanged.
   * Latin-only in effect; CJK has no case.  `undefined` = `'none'`.
   */
  casing?: 'none' | 'uppercase'
  /**
   * REQ-0277 §2 — drop shadow.  ASS `\shad<depth>` + `\4c` + `\4a`.
   * libass draws shadows at a fixed bottom-right offset (there is no
   * angle control in ASS); the depth in px is the offset magnitude.
   * `undefined` on `shadowEnabled` OR `shadowEnabled === false` =
   * disabled (ass-generator emits `\shad0`; preview writes no
   * text-shadow).
   */
  shadowEnabled?: boolean
  /** Integer px, 0-20 (typical 2-8).  Depth = both X and Y offset in libass' fixed bottom-right direction. */
  shadowDepth?: number
  /** `#RRGGBB`; default `#000000`. */
  shadowColor?: string
  /** Integer 0-100 (opacity %; higher = more opaque).  Default `100`. */
  shadowAlpha?: number
  // REQ-0278 — glow (glowEnabled / glowRadius / glowColor) was
  // removed here.  See SPECIFICATION.md §11: reason was "colour is
  // the essence of a glow effect but the colour picker never made
  // it into the UI, so the shipped feature had a white-only halo
  // that was less useful than promised."  Fields deleted rather
  // than deprecated because no released version persisted them —
  // pre-REQ-0278 project files do not carry these keys, and any
  // legacy JSON that hypothetically does will hit the standard
  // "unknown key on parse" tolerance (see project-store hydrate)
  // and be silently ignored.
  /**
   * REQ-0277 §4 — clockwise text rotation in degrees, 0-360.  ASS
   * `\frz<deg>`.  Preview: CSS `transform: rotate(<deg>deg)` with
   * `transform-origin: center`.  `undefined` = `0` (no rotation).
   *
   * Note (from REQ): libass measures degrees COUNTER-clockwise on the
   * `\frz` axis but our UI convention is clockwise (standard CSS/user
   * expectation).  ass-generator negates the value before emitting.
   */
  rotation?: number

  /**
   * REQ-0285 Phase B foundation — per-word timestamps captured by
   * faster-whisper at transcribe time.  Absolute video seconds (same
   * axis as `startSec` / `endSec`).  `text` retains faster-whisper's
   * leading space where present (`" hello"`) so a future re-tokenise
   * has the raw input.
   *
   * `undefined` means "no per-word data available for this row" — either
   * a pre-REQ-0285 project file, or the entry was created outside a
   * fresh transcribe (Add row, project import), or the entry's text
   * was edited and the pre-edit words were invalidated (§4 in
   * REQ-0285: `commit-text-edit.ts` clears `words` on any text
   * mutation).  Empty array (`[]`) means "words WERE captured but
   * the segment contained no timed word tokens" (silence-only chunk);
   * Phase B visual features treat empty identically to undefined and
   * fall back to plain rendering.
   *
   * Validity: use `areWordsValidForText(words, text)` from
   * `src/shared/words-validity.ts` before consuming.  A cue whose
   * `words` textual concatenation no longer matches `text` (project
   * file was edited by hand, cue was split/merged without clearing
   * words) MUST fall back to plain rendering — the visual features
   * cannot safely animate mis-aligned word data.
   *
   * NOT reset on the row's Reset button — `original.words` mirrors
   * `words` at creation time exactly like every other original-snapshot
   * field, so Reset row also restores the initial word data.
   */
  words?: WordSpan[]
}

/**
 * REQ-0285 — per-word timing.  Single source of truth: this file.
 * `ipc-contracts.ts` re-exports the same symbol so the sidecar's
 * `segment` event and `SubtitleEntry.words` share one declaration
 * (no shape drift between wire and domain).
 *
 * Semantics:
 *   - `startSec` / `endSec`: absolute video seconds, same axis as
 *     `SubtitleEntry.startSec` / `endSec`.
 *   - `text`: retains faster-whisper's leading space where present
 *     (`" hello"`).  Visual renderers should trim per-render if they
 *     display the word standalone; concatenation `.join('')` of a full
 *     `words[]` reproduces the original transcript spacing.
 */
export interface WordSpan {
  startSec: number
  endSec: number
  text: string
}

export interface SubtitleEntry extends SubtitleEntryOriginal {
  /** Stable UUID — survives reordering. Display index recomputed at render time. */
  id: string

  isDeleted: boolean
  /** True when any field diverges from `original`. */
  isEdited: boolean

  /** Snapshot of original values for the row Reset button. */
  original: SubtitleEntryOriginal
}

/** Row state priority: deleted > overflow > edited > normal. */
export type RowState = 'normal' | 'edited' | 'overflow' | 'deleted'

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface TranscriptionDefaults {
  /** Integer, 30–600 px. */
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  /** Integer, 0–5 px. */
  outlineThicknessPx: number
  whisperModel: WhisperModelId
}

export interface ProjectState {
  video: VideoInfo | null
  /** 1-based audio track index selected for transcription. */
  selectedTrackIndex: number
  entries: SubtitleEntry[]
  /** Seed values used for newly created / transcribed rows. */
  defaults: TranscriptionDefaults
}

// ---------------------------------------------------------------------------
// Transcription advanced parameters
// ---------------------------------------------------------------------------

/**
 * Advanced faster-whisper transcription parameters, stored in AppSettings
 * and forwarded to the Python sidecar on each transcription run.
 * Default values are defined in TRANSCRIPTION_DEFAULTS (shared/constants.ts).
 */
export interface TranscriptionAdvancedParams {
  vadFilter: boolean
  vadThreshold: number
  /** Minimum speech segment duration in milliseconds. */
  minSpeechDurationMs: number
  /** Minimum silence duration to split segments, in milliseconds. */
  minSilenceDurationMs: number
  beamSize: number
  /** ISO 639-1 language code, or 'auto' for auto-detection (language=None in faster-whisper). */
  language: string
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface BurninPosition {
  horizontalPosition: 'left' | 'center' | 'right'
  verticalPosition: 'top' | 'center' | 'bottom'
  verticalMarginPx: number
}

export interface SubtitleBackground {
  enabled: boolean
  color: 'black' | 'white'
  /** Integer 0–100. Higher = more opaque. */
  opacityPercent: number
}

export type H264Encoder = 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'h264_mf'
export type EncoderSetting = 'auto' | H264Encoder
export type AudioMode = 'simple' | 'preserve'

/**
 * Step 3 output container choice.
 * - `'mp4'`        : force `.mp4` regardless of input.  ffmpeg invoked with
 *                    `-f mp4` and `-movflags +faststart` for SNS/Web streaming.
 * - `'sameAsInput'`: keep the input file's extension.  Container is left to
 *                    ffmpeg's filename auto-detection (no `-f`).
 *
 * Session-only — like `burnin` / `subtitleBackground` / `audioMode`, this
 * value is intentionally reset on every navigation to Step 1 and on launch.
 */
export type OutputContainer = 'mp4' | 'sameAsInput'

export type AppTheme = 'dark' | 'light'

/**
 * REQ-20260615-029 / 030: user-selectable base neutral palette.  Default
 * is `'neutral'` (zero hue, truest grey).  REQ-030 swapped the cool /
 * gray-leaning options (zinc / slate / gray) for hue-distinct ones
 * (mauve / olive / mist / taupe).  See globals.css for the per-base
 * scale definitions.
 */
export type BaseColor = 'neutral' | 'stone' | 'mauve' | 'olive' | 'mist' | 'taupe'

export interface AppSettings {
  version: 1
  language: string
  /**
   * REQ-20260615-026: app-wide colour theme.  `dark` is the default and
   * the only value emitted by versions before this REQ shipped; the
   * field is optional in the persisted struct so old settings.json
   * files hydrate cleanly (falling back to `dark`).
   */
  theme?: AppTheme
  /**
   * REQ-20260615-029: app-wide base neutral palette.  Default
   * `'neutral'`.  Optional so settings.json files predating this REQ
   * hydrate cleanly.
   */
  baseColor?: BaseColor
  transcriptionDefaults: TranscriptionDefaults
  transcriptionAdvanced: TranscriptionAdvancedParams
  /** When true, \N line breaks are auto-inserted after transcription for lines exceeding video width. */
  autoLineBreak: boolean
  /**
   * Step 3 session-only `audioMode`.  Optional because the renderer does
   * not persist it — reset to BURNIN_DEFAULTS on every navigation to
   * Step 1 and on every launch.
   *
   * REQ-20260613-016 Phase 4 — `burnin` and `subtitleBackground` were
   * retired from the settings store along with the global panel UI.
   * Kept as optional dead-weight in the IPC contract so legacy
   * settings.json files from v1.0–v1.2.1 still hydrate cleanly (the
   * renderer's hydrate() now ignores both); a follow-up phase may
   * remove them entirely after the next persisted-settings migration.
   */
  burnin?: BurninPosition
  audioMode?: AudioMode
  subtitleBackground?: SubtitleBackground
  encoder: EncoderSetting
  defaultAudioTrackIndex: number
  /**
   * REQ-20260615-050 — default fade ramp duration in seconds applied
   * when a NEW SubtitleEntry is created (transcription, add-row,
   * duplicate-row).  Range `[0, 0.5]`, step 0.1; `0` means new entries
   * default to no fade.  No longer used at burn-in time — each entry
   * carries its own `fadeDurationSec` after creation.
   */
  fadeDurationSec: number
  activeModelId: WhisperModelId | null
  /**
   * Currently selected subtitle font ID.  Drives both the CSS preview family
   * and the ASS `Style:` `Fontname` at burn-in time.  Optional because
   * existing settings files predating font selection do not contain it;
   * defaults to `'noto-sans-jp-semibold'` when absent.
   */
  activeFontId?: FontId
  /**
   * REQ-0269 C-4 — records the `FONT_SET_VERSION` that was current the
   * last time the user completed a bulk "font set" download.  Compared
   * against `FONT_SET_VERSION` on startup / picker open: when strictly
   * less (or absent), the picker treats the on-disk set as `outdated`
   * and offers to re-download the incremental additions.
   *
   * Optional so pre-v1.3.6 settings.json files hydrate cleanly with
   * `undefined` — which correctly means "no font set downloaded" for
   * paid-tier users who never triggered the bulk flow.  Never set for
   * free-tier users (they cannot trigger the download at all, per
   * REQ-0269 C-2).
   */
  fontSetInstalledVersion?: number
  lastInputDir: string | null
  lastOutputDir: string | null
  /**
   * REQ-0121 — User-preferred fixed default folders shown in the input /
   * output dialogs.  Distinct from `lastInputDir` / `lastOutputDir` which
   * are MRU (updated after each open/save).  When `null` the dialog falls
   * back to `app.getPath('videos')`.  The main-side handler validates the
   * path on use (`fs.existsSync`) and silently falls back to Videos when
   * the folder has been removed / moved — no toast to avoid noise.
   */
  defaultInputDir?: string | null
  defaultOutputDir?: string | null
  /**
   * REQ-0194 — user-preferred default folder for the `.mojioko` project
   * file save / open dialogs.  Same shape as `defaultInputDir` /
   * `defaultOutputDir` (nullable, folder-picker on Settings > General,
   * lazy existence check on use, silent fallback to the OS Videos
   * folder).  Optional in the persisted struct so settings.json files
   * predating this REQ hydrate cleanly.
   */
  defaultProjectDir?: string | null
  /**
   * REQ-0150 — user-picked transcription accelerator.  `'cpu'` (default)
   * runs faster-whisper on the CPU path; `'gpu'` opts into CUDA via the
   * downloaded GPU tools (`%APPDATA%/MOJIOKO/gpu-tools/cuda-v1/`).
   *
   * The renderer surfaces this via the 2-card picker under the Whisper
   * model accordion; `transcription-sidecar.ts` reads it at spawn time
   * and only injects `MOJIOKO_GPU_TOOL_DIR` when this is `'gpu'` AND
   * the tools are fully installed on disk.  A user who has downloaded
   * the GPU tools but explicitly picked the CPU card gets CPU
   * execution — the tools stay on disk for a later re-select.
   *
   * Optional in the persisted struct so settings.json files predating
   * this REQ hydrate as CPU (the safe default — nothing extra to load).
   */
  activeAccelerator?: 'cpu' | 'gpu'
}

// ---------------------------------------------------------------------------
// Whisper model management
// ---------------------------------------------------------------------------

export type ModelStatus = 'not-installed' | 'installed' | 'active'

export interface ModelInfo {
  id: WhisperModelId
  displayName: string
  /** Actual disk usage; 0 when not installed. */
  sizeBytes: number
  /** Estimated download size before installation. */
  expectedSizeBytes: number
  status: ModelStatus
}

export interface ModelsState {
  models: ModelInfo[]
  activeModelId: WhisperModelId | null
  totalUsedBytes: number
  diskFreeBytes: number
  diskDrive: string
  modelsDir: string
}

// ---------------------------------------------------------------------------
// IPC response envelope
// ---------------------------------------------------------------------------

export type IpcOk<T> = { ok: true; data: T }
export type IpcErr = { ok: false; error: { code: string; message: string } }
export type IpcResult<T> = IpcOk<T> | IpcErr
