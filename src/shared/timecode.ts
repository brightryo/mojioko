/**
 * REQ-0382 — frame-precision timecode for the preview playhead, and the
 * one-frame step used by Shift+←/→.  Pure so both are pinned by unit tests.
 */

/**
 * Format a time (seconds) as `M:SS.mmm (fF)` — minutes, seconds, milliseconds,
 * and the 0-based frame number WITHIN that second (owner decision, REQ-0382 §A).
 * `H:MM:SS.mmm (fF)` once past an hour.
 *
 * - Milliseconds are the true (rounded) fractional time, so sub-frame drift is
 *   still readable for the karaoke diagnosis this was filed for.
 * - The frame number is `floor(frac · fps)` (0 … ceil(fps)−1), computed from the
 *   raw time so a value sitting exactly on a frame boundary reads as that frame.
 * - Non-finite / negative time → 0; non-positive fps falls back to 30 so the
 *   label never shows NaN before metadata loads.
 */
export function formatTimecode(sec: number, fps: number): string {
  const f = Number.isFinite(fps) && fps > 0 ? fps : 30
  const x = Number.isFinite(sec) && sec >= 0 ? sec : 0
  const totalMs = Math.round(x * 1000)
  const whole = Math.floor(totalMs / 1000)
  const ms = totalMs % 1000
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const s = whole % 60
  const maxFrame = Math.max(0, Math.ceil(f) - 1)
  const frame = Math.min(maxFrame, Math.floor((x - Math.floor(x)) * f + 1e-6))
  const hms = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
  return `${hms}.${String(ms).padStart(3, '0')} (f${frame})`
}

/**
 * The time one video frame away from `currentSec`, snapped to the frame grid
 * and clamped to `[0, maxSec]`.  `dir` is +1 (forward) or −1 (back).  Snapping
 * current to the nearest frame first makes repeated steps land on exact
 * `k / fps` boundaries regardless of where the playhead started.
 */
export function frameStepSec(currentSec: number, fps: number, dir: 1 | -1, maxSec: number): number {
  const f = Number.isFinite(fps) && fps > 0 ? fps : 30
  const maxFrame = Math.max(0, Math.floor((Number.isFinite(maxSec) && maxSec > 0 ? maxSec : 0) * f + 1e-6))
  const cur = Math.round((Number.isFinite(currentSec) && currentSec > 0 ? currentSec : 0) * f)
  const next = Math.min(maxFrame, Math.max(0, cur + dir))
  return next / f
}
