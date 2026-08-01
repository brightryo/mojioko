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
