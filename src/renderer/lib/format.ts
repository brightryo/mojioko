/** Format bytes to MB with one decimal place. */
export function formatMB(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

/** Format bytes to a human-readable string (MB or GB). */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 MB'
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`
}

/** Format a resolution as "1920×1080". */
export function formatResolution(w: number, h: number): string {
  return `${w}×${h}`
}

/** Rough estimated output file size in MB. */
export function estimateOutputSizeMB(durationSec: number): number {
  const bitrateEstimateBps = 8_000_000
  return Math.round((durationSec * bitrateEstimateBps) / 8 / 1_000_000)
}

/** Rough estimated render time in seconds. */
export function estimateRenderTimeSec(durationSec: number, subtitleCount: number): number {
  return durationSec / 8 + subtitleCount * 0.5
}
