/**
 * REQ-20260615-081 — pure retry / classification helpers for the model
 * downloader.  Owns three concerns the downloader pipeline needs:
 *
 *   1. How many times do we retry a transient failure?
 *   2. How long do we sleep between attempts?
 *   3. Is this error transient (retry) / fatal (give up) / abort
 *      (user-cancelled, do not surface as an error)?
 *
 * Pure module — no fs, no fetch, no electron, no logger.  Tested by
 * `tests/unit/download-retry.test.ts` against fabricated error shapes
 * matching the undici / standard fetch error surface we see in Node
 * 20.x: `TypeError: terminated`, `TypeError: fetch failed`, AbortError,
 * HTTP 4xx wrapped as `Error: HTTP NNN ...`, and unknown shapes.
 */

/**
 * Total number of stream attempts allowed for a single file download.
 * The first attempt is "attempt 1"; attempts 2–{@link MAX_DOWNLOAD_ATTEMPTS}
 * are retries after a transient failure.  Set at 5 because the dominant
 * failure modes we've seen (mid-stream undici `terminated`, transient
 * DNS, brief Wi-Fi drops) recover within a handful of seconds — five
 * attempts with the exponential backoff below give the user up to
 * 1 + 2 + 4 + 8 = 15 s of automatic patience before the
 * surfaced-to-the-renderer failure.
 */
export const MAX_DOWNLOAD_ATTEMPTS = 5

/**
 * Base backoff in milliseconds.  Successive retries sleep
 * `BASE_BACKOFF_MS * 2^(attempt-1)` so the first retry waits ~1 s,
 * second ~2 s, etc.  Capped by {@link MAX_BACKOFF_MS} below.
 */
export const BASE_BACKOFF_MS = 1_000

/**
 * Hard cap on a single retry sleep, so a future bump of
 * {@link MAX_DOWNLOAD_ATTEMPTS} doesn't accidentally make the user
 * stare at a 30-second silent pause.
 */
export const MAX_BACKOFF_MS = 10_000

/**
 * Compute the backoff for the upcoming retry given the previous
 * attempt number.  `attempt` is 1-indexed (1 = first attempt that
 * just failed → about to retry → caller sleeps this many ms before
 * the second attempt).  Sequence: 1000, 2000, 4000, 8000, 10000, ...
 */
export function nextBackoffMs(attempt: number): number {
  if (attempt < 1) return 0
  const ms = BASE_BACKOFF_MS * Math.pow(2, attempt - 1)
  return Math.min(ms, MAX_BACKOFF_MS)
}

export type DownloadErrorClass = 'transient' | 'fatal' | 'abort'

/**
 * Renderer-facing error code carried on the IPC `failed` event.
 * Renderer maps to a localized toast — keeps the locale decision out
 * of main process logs and out of `String(err)` stringification.
 *
 *   - `network`: transient connectivity failure — what the user sees
 *     in the field 99 % of the time (undici `terminated` on a Wi-Fi
 *     drop).  Toast tells them to check the connection and retry.
 *   - `fatal`:   server says no (HTTP 4xx / 5xx beyond the retry
 *     budget) or an unexpected non-network failure.  Toast falls back
 *     to a generic "download failed" with the raw message attached so
 *     bug reports still carry diagnostic detail.
 *   - `aborted`: user clicked Cancel.  Renderer suppresses the toast
 *     entirely (see whisper-model-manager.tsx).
 */
export type DownloadErrorCode = 'network' | 'fatal' | 'aborted'

/**
 * Classify a thrown error from the fetch / stream-read pipeline.
 *
 * Heuristics (in order):
 *
 *   1. AbortError / cancelled message → `abort`
 *   2. undici / node-fetch transient surface (terminated, fetch
 *      failed, ECONNRESET, ENOTFOUND, ETIMEDOUT, EAI_AGAIN,
 *      network is unreachable) → `transient`
 *   3. Anything else (including HTTP 4xx/5xx that the downloader
 *      wrapped with `HTTP NNN ...`) → `fatal`
 *
 * The "fatal" default is deliberately conservative — we'd rather
 * surface a real failure than keep retrying on an HTTP 404, which
 * would happen if a model was renamed upstream and the URL no
 * longer resolves.  A 5xx that's actually transient (HF capacity
 * blip) reads as fatal here, but the user can re-click "Install"
 * and the next click runs the full retry budget again, so the
 * worst case is one manual retry rather than an infinite loop on
 * a genuine outage.
 */
export function classifyDownloadError(err: unknown): DownloadErrorClass {
  // Abort path — AbortController.abort(), Cancelled-marked errors.
  if (isAbortError(err)) return 'abort'

  if (err instanceof Error) {
    const msg = `${err.name}: ${err.message}`.toLowerCase()
    // Match on the bare network failure surface we've actually seen
    // out of Node 20's undici-backed fetch and TCP / DNS errors that
    // propagate through.  Conservative — anything unknown stays
    // `fatal` so the user gets a real "download failed" toast instead
    // of an infinite retry on a 4xx.
    if (
      msg.includes('terminated')           // undici mid-stream drop
      || msg.includes('fetch failed')      // undici outer error
      || msg.includes('econnreset')        // TCP RST
      || msg.includes('enotfound')         // DNS lookup failed
      || msg.includes('etimedout')         // TCP / HTTP timeout
      || msg.includes('eai_again')         // transient DNS error
      || msg.includes('network is unreachable')
      || msg.includes('socket hang up')    // Node's classic mid-stream
    ) return 'transient'
  }

  return 'fatal'
}

/**
 * Map an error to the IPC-facing code the renderer toasts.
 * Wrapper around {@link classifyDownloadError} so the IPC layer
 * doesn't repeat the {transient → network} mapping inline.
 */
export function toErrorCode(cls: DownloadErrorClass): DownloadErrorCode {
  switch (cls) {
    case 'transient': return 'network'
    case 'abort':     return 'aborted'
    case 'fatal':     return 'fatal'
  }
}

/**
 * Decide whether the caller should attempt one more retry.
 * Centralizes the "we hit the budget AND the error is transient AND
 * we're not aborted" tri-rule so the downloadFile loop stays linear.
 */
export function shouldRetry(attempt: number, cls: DownloadErrorClass): boolean {
  if (cls !== 'transient') return false
  return attempt < MAX_DOWNLOAD_ATTEMPTS
}

/**
 * AbortController.abort() throws a `DOMException` with name
 * `'AbortError'` from Node's undici-backed fetch and from a stream
 * `reader.read()` whose signal was aborted.  Older shapes set
 * `code === 20` (DOMException.ABORT_ERR).  Match both to be safe
 * across runtime versions, but DON'T match on raw message text —
 * undici uses "aborted" in some non-user-abort branches and we'd
 * mis-classify a network-side abort as a user cancel.
 */
function isAbortError(err: unknown): boolean {
  if (err == null) return false
  if (typeof err === 'object') {
    const e = err as { name?: unknown; code?: unknown }
    if (e.name === 'AbortError') return true
    if (e.code === 20) return true
  }
  return false
}
