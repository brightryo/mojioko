/**
 * REQ-0129 Phase 1 — retry-with-backoff wrapper around `fs.rename`,
 * extracted into its own module so unit tests can exercise it without
 * pulling in electron via the paths / logger dependency tree.
 *
 * Symptom (see RES-0119 §1 / RES-0129 Phase 1): on MSIX Windows, the
 * preview-mix finalise rename occasionally fails with EPERM.  The
 * kernel-level file handle release lags ffmpeg's stdio `close` event,
 * so a race between "ffmpeg process exits" and "OS releases the write
 * handle on `.tmp`" can hit rename right in the middle.  Retrying with
 * exponential backoff [100 / 200 / 400 ms] covers the typical Windows
 * release lag (< 300 ms measured in the field).
 *
 * Only `EPERM` / `EACCES` / `EBUSY` are retried — those are the codes
 * Windows returns while a file handle is still open.  Every other error
 * code (ENOENT / ENOSPC / EROFS / ...) is unrecoverable and propagates
 * immediately.
 */

export type RenameFn = (src: string, dst: string) => Promise<void>
export type WaitFn = (ms: number) => Promise<void>

export const RETRY_DELAYS_MS = [100, 200, 400] as const
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Core loop, injectable renameFn + waitFn for tests.  Total attempts =
 * `1 + RETRY_DELAYS_MS.length`.  The optional `onRetry` fires once per
 * retry with `(attemptNumber, delayMs, err)` and is used by callers to
 * surface log lines.
 */
export async function renameWithRetryInternal(
  src: string,
  dst: string,
  renameFn: RenameFn,
  waitFn: WaitFn,
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void,
): Promise<void> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await renameFn(src, dst)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (!code || !RETRY_CODES.has(code)) {
        // Not a retry-worthy error — bail immediately.
        break
      }
      if (attempt === RETRY_DELAYS_MS.length) {
        // Out of retries — bail.
        break
      }
      const delay = RETRY_DELAYS_MS[attempt]
      onRetry?.(attempt + 1, delay, err)
      await waitFn(delay)
    }
  }
  throw lastErr
}

export function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
