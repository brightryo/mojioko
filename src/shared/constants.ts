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
 * Default fade-in/out duration in seconds for newly-created entries
 * and for fresh installs / hydrated-without-value settings.
 *
 * REQ-20260615-050: the slider exposed in Settings / Inspector / Bulk-edit
 * runs over `[FADE_DURATION_SEC_MIN, FADE_DURATION_SEC_MAX]` in increments
 * of `FADE_DURATION_SEC_STEP`.  A stored value of `0` means **no fade**
 * (the ASS writer skips `\fad`, the preview rAF skips the opacity ramp).
 * Converted to milliseconds when writing the ASS \fad() tag.
 *
 * REQ-20260615-057: shipping default lowered to `0` so a freshly-created
 * subtitle is visible the moment the playhead lands on its start time.
 * With a positive default, selecting a clip on the timeline jumps the
 * playhead to the entry's start time and the fade-in ramp begins from
 * alpha 0 — the overlay shows nothing for the first few hundred
 * milliseconds.  Existing persisted values are intentionally NOT
 * touched on hydrate (the user's choice is preserved); only fresh
 * installs and explicit resets see the new default.
 */
export const FADE_DURATION_SEC_DEFAULT = 0
export const FADE_DURATION_SEC_MIN = 0
export const FADE_DURATION_SEC_MAX = 0.5
export const FADE_DURATION_SEC_STEP = 0.1

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
/**
 * Maximum outline thickness in pixels (inclusive, integer). Range is
 * 0–OUTLINE_THICKNESS_MAX_PX.
 *
 * REQ-0292 §5 raised the ceiling from 10 to 20 so users can build the
 * heavier chunky-outline look common in short-form / kawaii captions.
 * Every consumer (slider `max`, settings-store clamp, ass-generator
 * `\bord`, subtitle-overlay's canvas ring) reads from this
 * constant so bumping it here propagates end-to-end in one step.
 */
export const OUTLINE_THICKNESS_MAX_PX = 20

/**
 * REQ-0311 §2 — how far the inspector's subtitle `<textarea>` may be dragged
 * open, as a multiple of its own default (`rows={3}`) height.  The floor is the
 * default height itself, so the row can never be made smaller than it ships.
 *
 * Expressed as a ratio rather than a px cap because the default height is a
 * product of the design tokens (`text-body` + `leading-snug` + `py-1.5`); a
 * hardcoded px ceiling would silently drift the moment those tokens change.
 * The bounds are applied imperatively from the measured natural height — see
 * `timeline-block-inspector.tsx`.
 */
export const INSPECTOR_TEXTAREA_MAX_HEIGHT_RATIO = 2

/**
 * Maximum drop-shadow depth in pixels (inclusive, integer).  Range is
 * 0–SHADOW_DEPTH_MAX_PX; depth of `0` means "no shadow".
 *
 * REQ-0293 §1 collapsed the shadow ON/OFF Switch into the depth
 * itself: depth > 0 draws a shadow, depth = 0 draws nothing.  The
 * ceiling dropped from 100 → 50 so the 0=OFF slider still has
 * useful resolution near the low end (typical usable depths are
 * 2–8 px; 50 covers the "as big as it gets before it becomes
 * absurd" range the owner wanted, without wasting slider real
 * estate on 51–100).
 *
 * All three shadow paths (inspector slider max, ass-generator
 * `\shad` clamp, subtitle-overlay CSS `text-shadow` depth clamp)
 * must read from this constant so bumping it in one place cannot
 * leave any path capped behind the others (a silent
 * preview↔burn-in divergence).
 */
export const SHADOW_DEPTH_MAX_PX = 50

/** Minimum vertical margin in pixels (inclusive, integer). */
export const MARGIN_V_MIN_PX = 0
/**
 * Maximum vertical margin in pixels (inclusive, integer).
 *
 * REQ-0269 A raises the ceiling from the pre-v1.3.6 hardcoded 300 to 9999
 * so short-form (vertical / 4K) editors can push subtitles far off the
 * visible frame when they want extreme offsets.  Values that place the
 * subtitle beyond the video edge are intentionally allowed — libass draws
 * off-canvas, and the user's own preview panel shows when the row leaves
 * the frame.  4 digits fits comfortably in the widened NumberStepperInput
 * `widthClass="w-16"` used at both call sites; the legacy 300 cap is not
 * enforced anywhere else in the pipeline (`verticalMarginPx` flows
 * unclamped through ass-generator → libass `MarginV`).
 */
export const MARGIN_V_MAX_PX = 9999

/**
 * Feature flag: show the video preview panel (D-1) in Step 2.
 * Set to `false` to instantly revert to the original Step 2 layout
 * without touching any other code.
 */
export const ENABLE_VIDEO_PREVIEW = true

/**
 * REQ-096 feature flag: rAF-throttle the HTML5 `<video>.currentTime`
 * seek during manual ruler scrub.  RES-095 measured the React layer
 * at < 0.18 ms per pointermove with no entries-count dependence, so
 * the residual stutter the owner reported has to live in the
 * browser-side video-seek decode (5–30 ms per non-keyframe seek on
 * real mp4/mkv).  When this flag is ON, the ruler scrub path:
 *   1. Updates `videoCurrentTimeSec` immediately on every pointermove
 *      so the Playhead sub-component (REQ-094 B) tracks the cursor
 *      with no lag.
 *   2. Coalesces multiple `setVideoSeekRequest` calls within one
 *      rAF tick into a single store write — the actual blocking
 *      `<video>.currentTime = X` runs at most once per frame instead
 *      of once per pointermove.
 *   3. Flushes any pending seek on pointerup so the final position
 *      always commits to the video element exactly.
 *
 * Set this flag to `false` to revert to the legacy per-event seek
 * behaviour bit-for-bit.  REQ-096 reversibility contract — owner
 * keeps both paths until field-tested.  Only the manual ruler-scrub
 * path is affected; auto-play, block-click seek, row-click seek, and
 * the navigation buttons all bypass the throttle and write seek
 * requests directly as before.
 */
export const SCRUB_SEEK_THROTTLE_ENABLED = true

/**
 * REQ-20260615-065 S-6 — version stamp written into every
 * downloaded model's sidecar metadata (`model.meta.json`) so a
 * future model-format break can be detected without the user
 * having to know what changed.
 *
 * v1.3.0 ships generation `1` — faster-whisper 1.2.1 +
 * ctranslate2 4.8 reading Systran / mobiuslabsgmbh CT2-format
 * archives.  Phase 0 confirmed the format is unchanged versus
 * fw 1.0.3, so existing on-disk models (which lack a meta file)
 * are treated as "unknown generation = current-compatible" by
 * the reader.  Only meta files whose `formatGeneration` is
 * STRICTLY less than this constant trigger a re-download
 * suggestion — and even that suggestion is log-only in v1.3.0,
 * never an automatic redownload.
 *
 * Bump this value when a future ctranslate2 / faster-whisper
 * release CHANGES the on-disk model file layout in a way the
 * runtime can't load transparently.  Tests pin the current
 * value so an accidental bump shows up in CI.
 */
export const MODEL_FORMAT_GENERATION = 1

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

/**
 * REQ-0324 §2 — ASS `lur N` to CSS `filter: blur()` conversion.
 *
 * Measured against real libass (bundled ffmpeg) and real Chromium (the
 * app's own Electron build, via `capturePage`), fitting sigma as the
 * second central moment of the edge-profile derivative:
 *
 *   libass  `lur N`      -> sigma = 0.834 x N   (linear to <1% for N>=4)
 *   Chromium `blur(Npx)`   -> sigma ~ 0.956 x N   (+-8%, kinks at N~5
 *                                                 where Skia switches
 *                                                 blur approximation)
 *
 * so sigma_ASS / sigma_CSS = 0.84 (mean; +-9% spread, all of it
 * Chromium's non-linearity rather than libass's).
 *
 * ALSO measured: `lur` is in OUTPUT DEVICE pixels and, unlike `ord`
 * and `\shad`, does NOT scale with PlayRes->frame. Since the generator
 * sets PlayRes to the video's pixel size, an ASS blur radius is already
 * in video pixels, so the preview must additionally multiply by its own
 * `containerWidthPx / videoWidthPx`. Omitting that term makes the preview
 * roughly 6x blurrier than the burn at a typical preview scale of 0.2 --
 * a far larger error than this factor corrects.
 */
export const ASS_BLUR_TO_CSS_SIGMA = 0.84

/**
 * REQ-0423 — supported input media extensions (lowercase, no leading dot).
 * Single source shared by the main-process open-dialog filter
 * (`main/ipc/dialog.ts`) and the renderer drag-&-drop validation
 * (`routes/step1.tsx`).  ffprobe still has the final say on the actual
 * decode (extension is UX only), but D&D validation and the picker filter
 * must agree, so both read these arrays.  Aligned to REQ-028/030's
 * confirmed-safe set: video = mp4 / mkv, audio = mp3 / wav / m4a / aac /
 * flac / ogg.
 */
export const SUPPORTED_VIDEO_EXTENSIONS = ['mp4', 'mkv'] as const
export const SUPPORTED_AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] as const
export const SUPPORTED_MEDIA_EXTENSIONS = [
  ...SUPPORTED_VIDEO_EXTENSIONS,
  ...SUPPORTED_AUDIO_EXTENSIONS,
] as const

/** True when `filePath`'s extension is one of SUPPORTED_MEDIA_EXTENSIONS. */
export function isSupportedMediaPath(filePath: string): boolean {
  const m = /\.([^./\\]+)$/.exec(filePath)
  if (!m) return false
  return (SUPPORTED_MEDIA_EXTENSIONS as readonly string[]).includes(m[1].toLowerCase())
}
