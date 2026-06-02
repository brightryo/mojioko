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

export interface AppSettings {
  version: 1
  language: string
  transcriptionDefaults: TranscriptionDefaults
  transcriptionAdvanced: TranscriptionAdvancedParams
  /** When true, \N line breaks are auto-inserted after transcription for lines exceeding video width. */
  autoLineBreak: boolean
  /**
   * Step 3-only UI state.  Optional because the renderer no longer persists
   * these fields — they are reset to BURNIN_DEFAULTS on every navigation to
   * Step 1 and on every app launch.  The main-process `buildDefaults()` still
   * supplies values for first-launch hydration; subsequent saves omit them.
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
