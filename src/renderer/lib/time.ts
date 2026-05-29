/** Format seconds to "HH:MM:SS.cc" (centiseconds, 2 digits). */
export function formatTimecode(sec: number): string {
  const totalCs = Math.round(sec * 100)
  const cs = totalCs % 100
  const totalSec = Math.floor(totalCs / 100)
  const s = totalSec % 60
  const totalMin = Math.floor(totalSec / 60)
  const m = totalMin % 60
  const h = Math.floor(totalMin / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** Format seconds to "HH:MM:SS" (no centiseconds, for display). */
export function formatDuration(sec: number): string {
  const s = Math.floor(sec) % 60
  const m = Math.floor(sec / 60) % 60
  const h = Math.floor(sec / 3600)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Parse "HH:MM:SS.cc" → seconds. Returns NaN if invalid. */
export function parseTimecode(tc: string): number {
  const match = tc.match(/^(\d+):(\d{2}):(\d{2})\.(\d{2})$/)
  if (!match) return NaN
  const [, h, m, s, cs] = match
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs) / 100
}

/** Format seconds as rough human-readable estimate ("~2 min", "~45 sec"). */
export function formatEstimatedTime(sec: number): string {
  if (sec < 60) return `~${Math.round(sec)} sec`
  return `~${Math.round(sec / 60)} min`
}
