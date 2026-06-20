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
  fadeEnabled: boolean
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
  verticalPosition: 'top' | 'bottom'
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
  fadeEnabled: boolean
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
  verticalPosition: 'top' | 'bottom'
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
 * REQ-20260615-029: user-selectable base neutral palette.  Default is
 * `'neutral'` (zero hue, truest grey).  See globals.css for the per-base
 * scale definitions.
 */
export type BaseColor = 'neutral' | 'zinc' | 'slate' | 'gray' | 'stone'

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
  /** Fade-in/out duration in seconds applied to \fad() in ASS output. Default 0.2. */
  fadeDurationSec: number
  activeModelId: WhisperModelId | null
  /**
   * Currently selected subtitle font ID.  Drives both the CSS preview family
   * and the ASS `Style:` `Fontname` at burn-in time.  Optional because
   * existing settings files predating font selection do not contain it;
   * defaults to `'noto-sans-jp-semibold'` when absent.
   */
  activeFontId?: FontId
  lastInputDir: string | null
  lastOutputDir: string | null
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
