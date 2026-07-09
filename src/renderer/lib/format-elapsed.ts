/**
 * REQ-0143 / REQ-0148 — format elapsed seconds as `mm:ss`.
 *
 * Shared by the transcription drawer (REQ-0143) and the burn-in
 * drawer (REQ-0148 Part A).  The two drawers hold the elapsed
 * counter in their own local timer state (start time + setInterval
 * tick), but the string rendering is identical so it lives here.
 *
 * Zero-padded so digit width is stable and the layout does not shift
 * as seconds roll over from 9 → 10.
 */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}
