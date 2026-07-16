import { describe, it, expect, vi } from 'vitest'
import { renameWithRetryInternal } from '../../src/main/services/rename-with-retry'

/**
 * REQ-0129 Phase 1 — the preview-mix finalise `fs.rename` is wrapped
 * in a retry-with-backoff loop.  On Windows / MSIX the kernel-level
 * file handle release can lag ffmpeg's stdio close, causing an EPERM
 * on rename that resolves within ~300ms.  The retry ladder is
 * [100ms, 200ms, 400ms] = 3 retries after the initial attempt (4
 * total attempts).
 *
 * We inject a fake renameFn + waitFn so the tests run instantly and
 * deterministically without touching real files or timers.
 */

function makeEpermError(): NodeJS.ErrnoException {
  const err = new Error('EPERM: operation not permitted, rename …') as NodeJS.ErrnoException
  err.code = 'EPERM'
  return err
}

function makeEnoentError(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file …') as NodeJS.ErrnoException
  err.code = 'ENOENT'
  return err
}

describe('REQ-0129 Phase 1 — renameWithRetry backoff ladder', () => {
  it('resolves on the first attempt when rename succeeds immediately', async () => {
    const renameFn = vi.fn().mockResolvedValue(undefined)
    const waitFn = vi.fn().mockResolvedValue(undefined)
    await renameWithRetryInternal('src', 'dst', renameFn, waitFn)
    expect(renameFn).toHaveBeenCalledTimes(1)
    expect(waitFn).not.toHaveBeenCalled()
  })

  it('retries on EPERM and succeeds on the second attempt', async () => {
    const renameFn = vi.fn()
      .mockRejectedValueOnce(makeEpermError())
      .mockResolvedValueOnce(undefined)
    const waitFn = vi.fn().mockResolvedValue(undefined)
    await renameWithRetryInternal('src', 'dst', renameFn, waitFn)
    expect(renameFn).toHaveBeenCalledTimes(2)
    expect(waitFn).toHaveBeenCalledTimes(1)
    expect(waitFn).toHaveBeenNthCalledWith(1, 100)
  })

  it('retries three times before giving up (4 total attempts, 3 waits: 100 / 200 / 400)', async () => {
    const renameFn = vi.fn().mockRejectedValue(makeEpermError())
    const waitFn = vi.fn().mockResolvedValue(undefined)
    await expect(renameWithRetryInternal('src', 'dst', renameFn, waitFn))
      .rejects.toThrow('EPERM')
    expect(renameFn).toHaveBeenCalledTimes(4)
    expect(waitFn).toHaveBeenCalledTimes(3)
    expect(waitFn).toHaveBeenNthCalledWith(1, 100)
    expect(waitFn).toHaveBeenNthCalledWith(2, 200)
    expect(waitFn).toHaveBeenNthCalledWith(3, 400)
  })

  it('bails immediately on non-retryable errors (ENOENT)', async () => {
    const renameFn = vi.fn().mockRejectedValue(makeEnoentError())
    const waitFn = vi.fn().mockResolvedValue(undefined)
    await expect(renameWithRetryInternal('src', 'dst', renameFn, waitFn))
      .rejects.toThrow('ENOENT')
    expect(renameFn).toHaveBeenCalledTimes(1)
    expect(waitFn).not.toHaveBeenCalled()
  })

  it('also retries on EACCES and EBUSY (Windows lock code variants)', async () => {
    async function testRetriedCode(code: string) {
      const err = new Error(`${code}: file busy`) as NodeJS.ErrnoException
      err.code = code
      const renameFn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce(undefined)
      const waitFn = vi.fn().mockResolvedValue(undefined)
      await renameWithRetryInternal('src', 'dst', renameFn, waitFn)
      expect(renameFn).toHaveBeenCalledTimes(2)
    }
    await testRetriedCode('EACCES')
    await testRetriedCode('EBUSY')
  })

  it('invokes the onRetry callback once per retry with the delay + error', async () => {
    const err = makeEpermError()
    const renameFn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(undefined)
    const waitFn = vi.fn().mockResolvedValue(undefined)
    const onRetry = vi.fn()
    await renameWithRetryInternal('src', 'dst', renameFn, waitFn, onRetry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(1, 100, err)
  })
})
