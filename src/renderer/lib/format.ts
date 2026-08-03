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

/**
 * REQ-0409 — download throughput, e.g. "12.3 MB/s".  Sub-1 MB/s shows KB/s so a
 * slow link still reads as moving rather than frozen.  Returns '' for 0/invalid.
 */
export function formatBytesPerSec(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return ''
  if (bps < 1_000_000) return `${(bps / 1_000).toFixed(0)} KB/s`
  return `${(bps / 1_000_000).toFixed(1)} MB/s`
}

/**
 * REQ-0409 — a compact ETA as "m:ss" (or "h:mm:ss" past an hour).  Returns ''
 * when the inputs cannot yield a finite estimate (no rate yet, done, invalid).
 */
export function formatEtaSeconds(remainingBytes: number, bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0 || remainingBytes <= 0) return ''
  const sec = Math.round(remainingBytes / bytesPerSec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
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
