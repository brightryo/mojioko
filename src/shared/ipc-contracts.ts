import type { SubtitleEntry, VideoInfo, AppSettings, BurninPosition, SubtitleBackground, H264Encoder, EncoderSetting, AudioMode, OutputContainer, ModelsState, TranscriptionAdvancedParams } from './types'
import type { FontId } from './fonts'
import type { Cut } from './cuts'
export type { ModelsState }

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export interface TranscriptionStartRequest {
  videoPath: string
  trackIndex: number
  modelId: string
  modelsDir: string
  ffmpegPath: string
  /**
   * REQ-086 — total count of audio tracks the source file carries
   * (NOT the index of the transcribed track).  When this is >= 2 the
   * main process runs a preview-mix amix pass after Whisper completes
   * so the editor's `<video muted>` + hidden `<audio>` pair can play
   * every track at once.  When the source has 0 or 1 audio tracks the
   * mix step is skipped and `completed.previewMixUrl` is `null`.
   *
   * Optional so legacy callers (e.g. older renderers) keep working —
   * the main process treats `undefined` as 0 (= mix is skipped).
   */
  audioTrackCount?: number
  defaults: {
    fontSizePx: number
    textColorHex: string
    outlineColorHex: string
    outlineThicknessPx: number
    /**
     * REQ-20260615-050 — seeded onto each transcribed SubtitleEntry's
     * `fadeDurationSec`.  `0` = no fade, `0.1`–`0.5` is the in/out
     * ramp in seconds.  Replaces the legacy `fadeEnabled` boolean.
     */
    fadeDurationSec: number
  }
  advanced: TranscriptionAdvancedParams
}

export interface BurninStartRequest {
  inputPath: string
  outputPath: string
  entries: SubtitleEntry[]
  video: VideoInfo
  burnin: BurninPosition
  encoderSetting: EncoderSetting
  audioMode: AudioMode
  // REQ-20260615-050 — global `fadeDurationSec` removed from the burn-in
  // request.  Each SubtitleEntry now carries its own `fadeDurationSec`
  // so the ASS writer reads it per-Dialogue.
  subtitleBackground: SubtitleBackground
  /**
   * Output container choice.  When `'mp4'`, ffmpeg is invoked with
   * `-f mp4 -movflags +faststart` for SNS/Web upload compatibility.  When
   * `'sameAsInput'`, container is inferred from `outputPath`'s extension.
   */
  outputContainer: OutputContainer
  /**
   * Currently selected subtitle font ID.  Drives the ASS Style `Fontname`
   * and the `fontsdir=` argument passed to libass.  Optional so callers
   * predating font selection keep working; defaults to the bundled Noto
   * font when omitted at the main-side handler.
   */
  fontId?: FontId
  /**
   * REQ-074: trim/cut list — Original-axis intervals to remove from the
   * final video via filter_complex trim+concat.  Optional and absent /
   * empty means "no cuts", in which case the main handler falls back to
   * the legacy single-input argv byte-for-byte (back-compat with every
   * caller predating Phase 1d).
   */
  cuts?: Cut[]
}

/**
 * REQ-20260615-021: single-frame export request shared by step2's
 * "save current frame as image" affordance.  Time is expressed on the
 * SOURCE video's original axis (= the <video> element's `currentTime`),
 * so callers do not have to convert through `editedToOrig`.
 */
export interface ExportFrameRequest {
  inputPath: string
  outputPath: string
  timeSec: number
  video: VideoInfo
  /** PNG (lossless, default) or JPG (mjpeg, high quality). */
  format: 'png' | 'jpg'
  includeSubtitles: boolean
  /**
   * Only consumed when includeSubtitles is true.  Same shape as
   * BurninStartRequest.entries — burn-in's ass-generator path is
   * reused verbatim for visual fidelity.
   */
  entries?: SubtitleEntry[]
  // REQ-20260615-050 — same per-entry consolidation as BurninStartRequest.
  subtitleBackground?: SubtitleBackground
  fontId?: FontId
}

export interface ExportFrameResult {
  outputPath: string
  sizeBytes: number
}

export interface EncoderDetectionResult {
  available: H264Encoder[]
  best: H264Encoder
}

export type { H264Encoder, EncoderSetting, AudioMode, OutputContainer }

export interface ModelCheckResult {
  installed: boolean
  sizeMB: number
}

export interface BuildInfo {
  electronVersion: string
  nodeVersion: string
  chromeVersion: string
  pythonAvailable: boolean
}

// ---------------------------------------------------------------------------
// Streaming event shapes (pushed main → renderer via channelId)
// ---------------------------------------------------------------------------

export type TranscriptionEvent =
  | { event: 'started'; totalDurationSec: number }
  | { event: 'segment'; segment: { startSec: number; endSec: number; text: string } }
  | { event: 'progress'; percent: number }
  /**
   * REQ-086 — phase change.  Emitted by the main process between Whisper
   * completion and preview-mix generation so the renderer can update
   * the drawer label (e.g. "音声準備中…").  No-op when the source has
   * fewer than 2 audio tracks; in that case the run goes Whisper →
   * `completed` directly without a `phase` event.
   */
  | { event: 'phase'; phase: 'preview-mix' }
  /**
   * REQ-086 — `previewMixUrl` carries the `mojioko-preview-mix://` URL
   * (with a cache-buster query) when a multi-track preview audio file
   * was generated.  `null` for 0- or 1-track sources where no mix is
   * needed.  Always present on this event for callers built against
   * the v1.3.2+ contract; pre-v1.3.2 renderers ignore unknown fields.
   */
  | { event: 'completed'; segmentCount: number; previewMixUrl: string | null }
  | { event: 'failed'; error: string }
  | { event: 'needsDownload'; model: string }

export type BurninEvent =
  | { event: 'progress'; percent: number; currentTimeMs: number }
  | { event: 'completed'; outputPath: string; sizeMB: number }
  | { event: 'failed'; error: string }

/**
 * REQ-20260615-081 — IPC contract for model download.  The `failed`
 * variant carries an OPTIONAL `errorCode` so the renderer can pick
 * the right localized toast without parsing `error: string`.  The
 * field is additive — old callers / older renderers that never read
 * it keep working.  Codes:
 *
 *   - `network`: transient connectivity failure (undici terminated,
 *     DNS, TCP reset).  Renderer suggests "check your connection
 *     and retry".
 *   - `fatal`:   server said no (HTTP 4xx/5xx) or unknown shape —
 *     renderer falls back to the generic "download failed" toast
 *     with the raw message attached for diagnostics.
 *   - `aborted`: user clicked Cancel; renderer suppresses the toast.
 *
 * `error` (free-form string) stays for log / bug-report breadcrumbs
 * and as a fallback when `errorCode` is absent (e.g., older v1.3.x
 * main process feeding a v1.3.2+ renderer).
 */
export type DownloadModelEvent =
  | { event: 'progress'; file: string; fileIndex: number; totalFiles: number; percent: number }
  | { event: 'completed' }
  | { event: 'failed'; error: string; errorCode?: 'network' | 'fatal' | 'aborted' }

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type { AppSettings }
