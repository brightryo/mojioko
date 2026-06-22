/**
 * Pure helper for the preview overlay's fade-in / fade-out opacity ramp
 * (REQ-20260615-048).  Mirrors the libass `\fad(t1,t2)` semantics used by
 * `ass-generator.ts:180`, so the on-screen preview matches what the
 * burn-in writes to the output video.
 *
 * libass `\fad(N,N)` ramps alpha from 0→1 across the first N ms of the
 * dialogue and from 1→0 across the last N ms (linear interpolation).
 * Outside those ramps the dialogue is at full alpha.  When the
 * dialogue's total duration is shorter than 2·N the two ramps overlap
 * and meet at the midpoint — this helper keeps the same interpretation
 * (linear from each edge, take the minimum of the two ramps) so a
 * short caption can never reach alpha 1.
 *
 * Pure / dependency-free so the unit tests can pin behaviour without
 * mounting React or the video element.  Caller supplies seconds — the
 * helper does not care about playhead axis (Original or Edited) as long
 * as `currentTimeSec`, `startSec`, `endSec` are all on the same axis.
 *
 * Returns a number in `[0, 1]`.  Always returns 1 when `fadeEnabled` is
 * `false` (the caller can still multiply this with other opacity sources
 * uniformly).  Returns 0 when the playhead sits strictly outside
 * `[startSec, endSec]`; the caller normally only renders the overlay
 * while the playhead is inside, so this defensive case is rarely seen.
 */
export function computeFadeOpacity(args: {
  currentTimeSec: number
  startSec: number
  endSec: number
  fadeEnabled: boolean
  fadeDurationSec: number
}): number {
  const { currentTimeSec, startSec, endSec, fadeEnabled, fadeDurationSec } = args
  if (!fadeEnabled) return 1
  if (fadeDurationSec <= 0) return 1
  if (currentTimeSec < startSec || currentTimeSec > endSec) return 0

  const elapsed = currentTimeSec - startSec
  const remaining = endSec - currentTimeSec

  const fadeIn = clamp01(elapsed / fadeDurationSec)
  const fadeOut = clamp01(remaining / fadeDurationSec)

  // The on-screen alpha is bounded by both ramps; for short captions
  // (duration < 2·fadeDurationSec) the two ramps overlap and meet,
  // producing a triangular alpha curve that never reaches 1 — same as
  // how libass renders the overlap case for `\fad`.
  return Math.min(fadeIn, fadeOut)
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
