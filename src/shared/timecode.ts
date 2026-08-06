/**
 * REQ-0382 — frame-precision timecode for the preview playhead, and the
 * one-frame step used by Shift+←/→.  Pure so both are pinned by unit tests.
 */

/**
 * Format a time (seconds) as a playhead timecode.
 *
 * `detailed` (default true, the historical behavior) → `M:SS.mmm (fF)`:
 * minutes, seconds, milliseconds, and the 0-based frame number WITHIN that
 * second (owner decision, REQ-0382 §A).  `H:MM:SS.mmm (fF)` once past an hour.
 *
 * `detailed === false` (REQ-0443 §1 "simple" mode) → `M:SS` / `H:MM:SS`:
 * hours/minutes/seconds only, no milliseconds and no frame number.
 *
 * - Milliseconds are the true (rounded) fractional time, so sub-frame drift is
 *   still readable for the karaoke diagnosis this was filed for.
 * - The frame number is `floor(frac · fps)` (0 … ceil(fps)−1), computed from the
 *   raw time so a value sitting exactly on a frame boundary reads as that frame.
 * - Non-finite / negative time → 0; non-positive fps falls back to 30 so the
 *   label never shows NaN before metadata loads.
 */
export function formatTimecode(sec: number, fps: number, detailed = true): string {
  const f = Number.isFinite(fps) && fps > 0 ? fps : 30
  const x = Number.isFinite(sec) && sec >= 0 ? sec : 0
  const totalMs = Math.round(x * 1000)
  const whole = Math.floor(totalMs / 1000)
  const ms = totalMs % 1000
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const hms = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
  // REQ-0443 §1 — simple mode: h/m/s only (no ms, no frame number).
  if (!detailed) return hms
  const maxFrame = Math.max(0, Math.ceil(f) - 1)
  const frame = Math.min(maxFrame, Math.floor((x - Math.floor(x)) * f + 1e-6))
  return `${hms}.${String(ms).padStart(3, '0')} (f${frame})`
}

/**
 * The seek time for stepping ONE video frame from `currentSec`, with the frame
 * INDEX as the source of truth.  `dir` is +1 (forward) / −1 (back).
 *
 * REQ-0383: the previous version snapped to the frame grid and returned the
 * frame BOUNDARY `k/fps`.  Seeking a `<video>` to an exact frame boundary is
 * ambiguous — Chromium reads the position back a hair UNDER it (verified: it
 * lands on `k/fps − ~1µs`), so `floor(currentTime·fps)` drops to `k−1` and the
 * boundary itself decodes inconsistently.  Feeding that drifted read-back into
 * the next step duplicated and skipped frames (owner: `f0,f0,f1,f3,f3,f4,f6`).
 *
 * The displayed frame is `index = floor(currentSec·fps)`.  We step that index,
 * clamp to `[0, lastFrame]`, and seek to the frame's CENTER `(index+0.5)/fps`
 * — half a frame (≈8ms at 60 fps) from either boundary, dwarfing the ~1µs seek
 * drift, so the video lands squarely on `index` and `floor(readback·fps)`
 * recovers it every time.  Verified in real Chromium at 60 AND 59.94 fps by
 * `scripts/verify-frame-step`; the pure-function tests are supporting.
 * `fps ≤ 0` falls back to 30 so the step never divides by zero before metadata.
 */
export function frameStepSec(currentSec: number, fps: number, dir: 1 | -1, maxSec: number): number {
  const f = Number.isFinite(fps) && fps > 0 ? fps : 30
  const dur = Number.isFinite(maxSec) && maxSec > 0 ? maxSec : 0
  // Last addressable frame index (0-based).  A `dur`-second clip at `f` fps has
  // frames 0 … ceil(dur·f)−1; `dur·f` itself is the exclusive end.
  const lastFrame = Math.max(0, Math.ceil(dur * f - 1e-6) - 1)
  const raw = Math.floor((Number.isFinite(currentSec) && currentSec > 0 ? currentSec : 0) * f + 1e-6)
  const cur = Math.min(lastFrame, Math.max(0, raw))
  const next = Math.min(lastFrame, Math.max(0, cur + dir))
  return (next + 0.5) / f
}
