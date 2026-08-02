/**
 * REQ-0375 §3 — snap a playhead time to a `-ss` value that makes ffmpeg's
 * output-side seek (`first frame with pts >= ss`) select the SAME frame the
 * preview `<video>` shows at `currentTime = timeSec`.
 *
 * The preview displays the frame whose interval contains timeSec — the frame
 * with pts <= timeSec, index `k = floor(timeSec·fps)`.  ffmpeg's output-side
 * `-ss timeSec`, however, selects the first frame with pts >= timeSec, which
 * is frame k+1 whenever timeSec sits strictly between two frame boundaries
 * (the normal case for an arbitrary float currentTime) — so the still came
 * out exactly one frame AFTER the preview.
 *
 * Returning `(k − 0.5)/fps` puts the seek half a frame before frame k's own
 * pts: `pts >= ss` clears frame k's pts (`k/fps`) but not frame k−1's, so
 * ffmpeg lands on frame k, robust to sub-frame pts rounding.  `fps <= 0`
 * (unknown / audio-only) returns timeSec unchanged.
 *
 * Pure and Electron-free so it can be unit-tested directly (frame-exporter.ts
 * imports Electron-only modules).
 */
export function displayedFrameSeekSec(timeSec: number, fps: number): number {
  if (!(fps > 0)) return timeSec
  const k = Math.floor(timeSec * fps + 1e-6)
  return Math.max(0, (k - 0.5) / fps)
}

/**
 * REQ-0381 — the `-vf` for PASS 2 of a subtitle frame export: burn the subtitle
 * onto an already-extracted still at the exact playhead time.
 *
 * The `subtitles` (libass) filter renders every time-based tag — karaoke
 * `\k`/`\kf`, animation `\fad`/`\t`/`\move` — at the frame's presentation
 * timestamp.  A single-pass output-side `-ss` render leaves that pts at the
 * extracted frame's own time (`floor(timeSec·fps)/fps`), so the subtitle is
 * drawn at the frame boundary while the preview renders at the exact playhead
 * `timeSec`; the gap is the intra-frame remainder `timeSec −
 * floor(timeSec·fps)/fps` ∈ [0, 1/fps).  A single-pass fix is impossible:
 * output `-ss` trims frames on the POST-filter pts, so any `setpts` that moves
 * the clock to the playhead also discards the wrong frames.  The exporter
 * therefore extracts the frame first (pass 1, no filters — same command the
 * no-subtitle path uses, so §3 frame selection is preserved) and calls this to
 * build pass 2 over that still.
 *
 * `settb=AVTB` widens the timebase to microseconds BEFORE `setpts`: on the
 * native `1/fps` timebase, `setpts=<t>/TB` would round the pts back to the
 * frame grid (re-quantising the karaoke sweep to whole frames — the very error
 * being fixed).  `setpts=<timeSec>/TB` then sets the still's clock to the
 * continuous playhead so libass renders exactly the state the preview shows at
 * `timeSec`.  A non-finite or negative time falls back to the bare filter so a
 * bad input can never produce a broken filtergraph.
 *
 * `subtitlesFilter` is the fully-built `subtitles='…':fontsdir='…'` string.
 * Pure and Electron-free so the real-pixel parity gate and unit tests can
 * exercise the exact string the exporter emits.
 */
export function frameExportSubtitleFilter(timeSec: number, subtitlesFilter: string): string {
  if (!Number.isFinite(timeSec) || timeSec < 0) return subtitlesFilter
  return `settb=AVTB,setpts=${timeSec.toFixed(6)}/TB,${subtitlesFilter}`
}
