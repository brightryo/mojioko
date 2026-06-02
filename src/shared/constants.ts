/** Splash screen display duration in milliseconds before navigating to Step 1. */
export const SPLASH_DURATION_MS = 1000

/** Fade-out duration for the splash screen. */
export const SPLASH_FADEOUT_MS = 200

/** Duration in seconds assigned to a newly added subtitle row. */
export const NEW_ROW_DURATION_SEC = 1.0

/** Maximum undo history entries. */
export const MAX_HISTORY = 100

/**
 * Left/right margin in pixels used by both the ASS generator and the overflow calculator.
 * These MUST stay in sync. Changing one requires changing the other.
 */
export const ASS_MARGIN_LR_PX = 10

/** Top/bottom margin used in ASS vertical alignment. */
export const ASS_MARGIN_V_DEFAULT_PX = 40

/**
 * Default fade-in/out duration in seconds.
 * Stored as `fadeDurationSec` in AppSettings and configurable via Settings dialog.
 * Converted to milliseconds when writing the ASS \fad() tag.
 */
export const FADE_DURATION_SEC_DEFAULT = 0.2

/** Timeout in milliseconds for ffprobe video probe operations. */
export const FFPROBE_TIMEOUT_MS = 10_000

/** Grace period before SIGKILL is sent after SIGTERM during ffmpeg cancellation. */
export const FFMPEG_KILL_GRACE_SEC = 3

/** Log file rotation: max size per file (bytes). */
export const LOG_MAX_SIZE = 5_242_880 // 5 MB

/** Log file rotation: max number of archived files retained (the live file is in addition). */
export const LOG_MAX_FILES = 3

/** Debounce delay for coalescing rapid text edits into one history entry (ms). */
export const EDIT_COALESCE_MS = 500

/** Debounce delay before persisting settings changes to disk (ms). */
export const SETTINGS_DEBOUNCE_MS = 500

/** Minimum subtitle font size in pixels (inclusive). */
export const FONT_SIZE_MIN_PX = 30
/**
 * Maximum subtitle font size in pixels (inclusive).
 *
 * REQ-040 confirmed the previous 200 ceiling was a convenience UI clamp,
 * not a technical limit — ASS `\fs`, libass, opentype.js measurement, and
 * the CSS preview all scale linearly with fontSizePx without any
 * upper-bound dependency.  REQ-041 raises the ceiling to 600 to cover:
 *   - 1080p meme captions up to ~55 % of frame height
 *   - 4K editing where 200 px reads as small (≈9 %); 600 px is ~28 %
 *   - vertical short formats where ~30 % of frame width is a common big
 *     caption size
 *
 * Values higher than 600 (e.g. 1000) tend to occupy the entire frame and
 * are easy to hit accidentally via a typo, so the cap stops here.
 */
export const FONT_SIZE_MAX_PX = 600
/** Maximum outline thickness in pixels (inclusive, integer). Range is 0–OUTLINE_THICKNESS_MAX_PX. */
export const OUTLINE_THICKNESS_MAX_PX = 10

/**
 * Feature flag: show the video preview panel (D-1) in Step 2.
 * Set to `false` to instantly revert to the original Step 2 layout
 * without touching any other code.
 */
export const ENABLE_VIDEO_PREVIEW = true

/**
 * Parameters passed to faster-whisper's `model.transcribe()` in the Python sidecar.
 * Displayed read-only in the Step 1 "Advanced settings" accordion.
 *
 * Source: python-sidecar/main.py — `model.transcribe(tmp_wav, …)`
 *
 * VAD parameters (vadThreshold, minSpeechDurationMs, minSilenceDurationMs) are NOT
 * explicitly set in the sidecar; values shown here are the faster-whisper / silero-vad
 * library defaults that are active when vad_filter=True.
 */
export const TRANSCRIPTION_DEFAULTS = {
  /** Voice activity detection filter (vad_filter=True). */
  vadFilter: true,
  /** Silero-VAD confidence threshold. Library default: 0.5. */
  vadThreshold: 0.5,
  /** Minimum speech segment duration in ms. Library default: 250. */
  minSpeechDurationMs: 250,
  /** Minimum silence duration in ms used to split segments. Library default: 2000. */
  minSilenceDurationMs: 2000,
  /** Beam search width (beam_size=5). */
  beamSize: 5,
  /** Target language — 'auto' means language=None (auto-detect) in the sidecar. */
  language: 'auto',
} as const
