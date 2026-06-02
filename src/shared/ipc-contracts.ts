import type { SubtitleEntry, VideoInfo, AppSettings, BurninPosition, SubtitleBackground, H264Encoder, EncoderSetting, AudioMode, OutputContainer, ModelsState, TranscriptionAdvancedParams } from './types'
import type { FontId } from './fonts'
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
  defaults: {
    fontSizePx: number
    textColorHex: string
    outlineColorHex: string
    outlineThicknessPx: number
    fadeEnabled: boolean
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
  /** Fade-in/out duration in seconds for \fad() ASS tag. */
  fadeDurationSec: number
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
  | { event: 'completed'; segmentCount: number }
  | { event: 'failed'; error: string }
  | { event: 'needsDownload'; model: string }

export type BurninEvent =
  | { event: 'progress'; percent: number; currentTimeMs: number }
  | { event: 'completed'; outputPath: string; sizeMB: number }
  | { event: 'failed'; error: string }

export type DownloadModelEvent =
  | { event: 'progress'; file: string; fileIndex: number; totalFiles: number; percent: number }
  | { event: 'completed' }
  | { event: 'failed'; error: string }

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type { AppSettings }
