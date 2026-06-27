import { describe, it, expect } from 'vitest'
import {
  nextBackoffMs,
  classifyDownloadError,
  toErrorCode,
  shouldRetry,
  MAX_DOWNLOAD_ATTEMPTS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
} from '../../src/main/services/download-retry'

/**
 * REQ-20260615-081 — pure retry helpers used by `downloadFile`.
 * Covers:
 *   - backoff sequence (1s, 2s, 4s, ...) capped at MAX_BACKOFF_MS
 *   - error classification across the undici-shaped surface we see
 *     in Node 20 (terminated / fetch failed / ECONNRESET / ENOTFOUND
 *     / ETIMEDOUT / AbortError / HTTP 4xx / unknown)
 *   - shouldRetry: transient + budget remaining → yes; everything
 *     else → no
 *   - constant pins so a future accidental edit (e.g., bumping
 *     attempts to 50, or backoff to 1 minute) surfaces in CI
 */

describe('REQ-081 — nextBackoffMs', () => {
  it('attempt 1 → BASE_BACKOFF_MS (first retry)', () => {
    expect(nextBackoffMs(1)).toBe(BASE_BACKOFF_MS)
  })

  it('doubles per attempt (1s, 2s, 4s, 8s)', () => {
    expect(nextBackoffMs(1)).toBe(1000)
    expect(nextBackoffMs(2)).toBe(2000)
    expect(nextBackoffMs(3)).toBe(4000)
    expect(nextBackoffMs(4)).toBe(8000)
  })

  it('caps at MAX_BACKOFF_MS so a future bump of attempts does not surprise the user with a 60 s pause', () => {
    expect(nextBackoffMs(10)).toBe(MAX_BACKOFF_MS)
    expect(nextBackoffMs(20)).toBe(MAX_BACKOFF_MS)
  })

  it('returns 0 for non-positive attempts (defensive — caller should never pass these)', () => {
    expect(nextBackoffMs(0)).toBe(0)
    expect(nextBackoffMs(-1)).toBe(0)
  })
})

describe('REQ-081 — classifyDownloadError', () => {
  it('undici mid-stream `TypeError: terminated` → transient', () => {
    const err = new TypeError('terminated')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('undici outer `TypeError: fetch failed` → transient', () => {
    const err = new TypeError('fetch failed')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('ECONNRESET (TCP reset) → transient', () => {
    const err = new Error('connect ECONNRESET 13.227.219.65:443')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('ENOTFOUND (DNS) → transient', () => {
    const err = new Error('getaddrinfo ENOTFOUND huggingface.co')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('ETIMEDOUT → transient', () => {
    const err = new Error('connect ETIMEDOUT 13.227.219.65:443')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('EAI_AGAIN (transient DNS) → transient', () => {
    const err = new Error('getaddrinfo EAI_AGAIN huggingface.co')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('socket hang up → transient', () => {
    const err = new Error('socket hang up')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('"network is unreachable" → transient', () => {
    const err = new Error('connect ENETUNREACH: network is unreachable')
    expect(classifyDownloadError(err)).toBe('transient')
  })

  it('AbortError (user cancel) → abort', () => {
    const err = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
    expect(classifyDownloadError(err)).toBe('abort')
  })

  it('DOMException with code=20 (legacy AbortError shape) → abort', () => {
    const err = { name: 'Error', message: 'aborted', code: 20 }
    expect(classifyDownloadError(err)).toBe('abort')
  })

  it('HTTP 4xx wrapped as `HTTP 404 ...` → fatal (no retry on a renamed model URL)', () => {
    const err = new Error('HTTP 404 fetching model.bin')
    expect(classifyDownloadError(err)).toBe('fatal')
  })

  it('HTTP 5xx wrapped as `HTTP 503 ...` → fatal (conservative: bail out, let the user manually retry)', () => {
    const err = new Error('HTTP 503 fetching model.bin')
    expect(classifyDownloadError(err)).toBe('fatal')
  })

  it('unknown error message → fatal (default conservative branch)', () => {
    const err = new Error('something weird happened')
    expect(classifyDownloadError(err)).toBe('fatal')
  })

  it('null / undefined → fatal (defensive)', () => {
    expect(classifyDownloadError(null)).toBe('fatal')
    expect(classifyDownloadError(undefined)).toBe('fatal')
  })

  it('case-insensitive on the underlying message', () => {
    expect(classifyDownloadError(new Error('TERMINATED'))).toBe('transient')
    expect(classifyDownloadError(new Error('Connect ECONNRESET'))).toBe('transient')
  })
})

describe('REQ-081 — toErrorCode', () => {
  it('maps transient → network', () => {
    expect(toErrorCode('transient')).toBe('network')
  })

  it('maps abort → aborted', () => {
    expect(toErrorCode('abort')).toBe('aborted')
  })

  it('maps fatal → fatal', () => {
    expect(toErrorCode('fatal')).toBe('fatal')
  })
})

describe('REQ-081 — shouldRetry', () => {
  it('transient + first attempt → retry', () => {
    expect(shouldRetry(1, 'transient')).toBe(true)
  })

  it('transient + budget-1 → retry once more', () => {
    expect(shouldRetry(MAX_DOWNLOAD_ATTEMPTS - 1, 'transient')).toBe(true)
  })

  it('transient + budget exactly reached → no more retry', () => {
    expect(shouldRetry(MAX_DOWNLOAD_ATTEMPTS, 'transient')).toBe(false)
  })

  it('transient + over budget → no retry (defensive)', () => {
    expect(shouldRetry(MAX_DOWNLOAD_ATTEMPTS + 1, 'transient')).toBe(false)
  })

  it('abort → never retry regardless of budget', () => {
    expect(shouldRetry(1, 'abort')).toBe(false)
    expect(shouldRetry(MAX_DOWNLOAD_ATTEMPTS - 1, 'abort')).toBe(false)
  })

  it('fatal → never retry regardless of budget', () => {
    expect(shouldRetry(1, 'fatal')).toBe(false)
    expect(shouldRetry(MAX_DOWNLOAD_ATTEMPTS - 1, 'fatal')).toBe(false)
  })
})

describe('REQ-081 — config sanity (constant pins)', () => {
  it('MAX_DOWNLOAD_ATTEMPTS is 5 (a tighter cap would give up too fast on Wi-Fi blips)', () => {
    expect(MAX_DOWNLOAD_ATTEMPTS).toBe(5)
  })

  it('BASE_BACKOFF_MS is 1 s (anything shorter hammers the server during sustained outages)', () => {
    expect(BASE_BACKOFF_MS).toBe(1_000)
  })

  it('MAX_BACKOFF_MS is 10 s (cap so the bar does not appear frozen for a minute+)', () => {
    expect(MAX_BACKOFF_MS).toBe(10_000)
  })
})
