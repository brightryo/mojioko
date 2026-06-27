import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// `model-downloader.ts` imports `../lib/logger` which transitively
// pulls in `../lib/paths.ts` → `electron.app.isPackaged`.  Vitest
// has no electron runtime, so we stub the bits the import chain
// touches (just enough to let logger / paths construct) before the
// importing line runs.
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => tmpdir(),
    getAppPath: () => tmpdir(),
  },
}))

// Lazy-import after the mock is registered.
const { downloadFile, DownloadError: _DE } = await import('../../src/main/services/model-downloader')
void _DE // DownloadError shape asserted via name+code on the rejection

/**
 * REQ-20260615-081 — integration coverage for `downloadFile`'s retry
 * loop with HTTP Range resume.  Drives the function with a mocked
 * `global.fetch` so we can:
 *
 *   - Drop the body mid-stream and verify the next attempt sends
 *     `Range: bytes=<received>-`
 *   - Return `206 Partial Content` and verify bytes are APPENDED
 *     onto the partial (not retruncated)
 *   - Return `200 OK` on a Range request and verify the file
 *     restarts from zero (server-ignored-Range fallback)
 *   - Surface an HTTP 404 / 5xx as fatal (no retry)
 *   - Honour AbortSignal mid-stream (no retry)
 *   - Throw DownloadError with the correct code after the retry
 *     budget is exhausted
 *
 * The mocked stream is intentionally tiny (8 bytes/chunk, multi-MB
 * total well below partial-detection floors) — we are testing the
 * resume protocol, not the model-bin size gate.
 */

type FetchInput = string | URL | Request
type FetchInit = RequestInit | undefined

interface MockResponse {
  status: number
  headers: Record<string, string>
  body: Uint8Array
  /** If set, the stream throws this error after `interruptAt` bytes. */
  interruptAt?: number
  interruptError?: Error
}

interface FetchCall {
  url: string
  rangeHeader: string | null
}

function setMockFetch(responses: MockResponse[]): { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  let i = 0
  const fakeFetch = async (input: FetchInput, init?: FetchInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
    const headersIn = (init?.headers ?? {}) as Record<string, string>
    calls.push({ url, rangeHeader: headersIn['Range'] ?? null })

    if (i >= responses.length) {
      throw new Error(`mock fetch: no response for call ${i + 1} (url=${url})`)
    }
    const r = responses[i++]

    // Honour AbortSignal at fetch time so an early abort path is testable.
    const signal = init?.signal as AbortSignal | undefined
    if (signal?.aborted) {
      const err = Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
      throw err
    }

    // Build a ReadableStream that either:
    //   - delivers the whole body and closes, OR
    //   - delivers `interruptAt` bytes then errors out.
    //
    // We yield (setImmediate) between chunk enqueues so the consumer's
    // reader actually consumes each chunk before we move on.  Without
    // the yield, `controller.error()` after the final enqueue can drop
    // the LAST queued chunk on the floor (the ReadableStream spec
    // discards unread queued chunks when the stream errors), which
    // manifested as an off-by-one-chunk Range header in earlier
    // iterations of this test.
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const total = r.body.length
        const interrupt = r.interruptAt ?? total
        const CHUNK = 8
        for (let pos = 0; pos < interrupt; pos += CHUNK) {
          const end = Math.min(pos + CHUNK, interrupt)
          controller.enqueue(r.body.subarray(pos, end))
          await new Promise<void>((resolve) => setImmediate(resolve))
        }
        if (interrupt < total) {
          controller.error(r.interruptError ?? new TypeError('terminated'))
        } else {
          controller.close()
        }
      },
    })

    return new Response(body, {
      status: r.status,
      headers: new Headers(r.headers),
    })
  }
  ;(global as { fetch: typeof fakeFetch }).fetch = fakeFetch
  return { calls }
}

function bodyOfBytes(n: number, fillByte = 0xAB): Uint8Array {
  return new Uint8Array(n).fill(fillByte)
}

describe('REQ-081 — downloadFile retry + Range resume', () => {
  let workDir: string
  let destPath: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mojioko-dlfile-test-'))
    destPath = join(workDir, 'model.bin')
    originalFetch = globalThis.fetch
    // Speed up retry loop in tests — downloadFile uses delay() with
    // an exponential schedule; we patch the global so 1 s / 2 s / 4 s
    // waits collapse to one event-loop tick.  setImmediate (not
    // queueMicrotask) so the callback runs AFTER any pending stream-
    // pump microtasks already in flight from the mock fetch.
    vi.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
      setImmediate(cb)
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)
  })

  afterEach(async () => {
    // `createWriteStream` opens the underlying file lazily, so a
    // synchronous rmSync immediately after `await downloadFile(...)`
    // can race with a pending file-handle close.  One macrotask
    // yield is enough to let Node flush any pending close before
    // we yank the directory.
    await new Promise<void>((resolve) => setImmediate(resolve))
    rmSync(workDir, { recursive: true, force: true })
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('completes a normal download in one attempt (no Range header)', async () => {
    const body = bodyOfBytes(1024)
    const { calls } = setMockFetch([
      { status: 200, headers: { 'content-length': String(body.length) }, body },
    ])

    const controller = new AbortController()
    let lastProgress = 0
    await downloadFile('https://example.com/model.bin', destPath, (recv, total) => {
      lastProgress = recv / total
    }, controller.signal)

    expect(calls).toHaveLength(1)
    expect(calls[0].rangeHeader).toBeNull()
    expect(statSync(destPath).size).toBe(1024)
    expect(lastProgress).toBe(1)
  })

  it('resumes mid-stream failure: drops at 256 B → retries with Range bytes=256- → appends 768 B', async () => {
    const fullBody = bodyOfBytes(1024, 0xCD)
    const { calls } = setMockFetch([
      // First attempt: deliver 256 B then drop
      {
        status: 200,
        headers: { 'content-length': String(fullBody.length) },
        body: fullBody,
        interruptAt: 256,
      },
      // Retry: 206 with the remaining 768 B
      {
        status: 206,
        headers: { 'content-length': String(fullBody.length - 256) },
        body: fullBody.subarray(256),
      },
    ])

    const controller = new AbortController()
    await downloadFile('https://example.com/model.bin', destPath, () => {}, controller.signal)

    expect(calls).toHaveLength(2)
    expect(calls[0].rangeHeader).toBeNull()
    expect(calls[1].rangeHeader).toBe('bytes=256-')
    expect(statSync(destPath).size).toBe(1024)
    // The full file should match — the resume APPENDED rather than re-truncated.
    expect(Array.from(readFileSync(destPath))).toEqual(Array.from(fullBody))
  })

  it('falls back to full restart when server returns 200 on a Range request (HF ignored Range)', async () => {
    const fullBody = bodyOfBytes(1024, 0xEF)
    const { calls } = setMockFetch([
      // Drop at 256 B
      {
        status: 200,
        headers: { 'content-length': String(fullBody.length) },
        body: fullBody,
        interruptAt: 256,
      },
      // Retry: server ignores Range and returns 200 with the WHOLE body
      {
        status: 200,
        headers: { 'content-length': String(fullBody.length) },
        body: fullBody,
      },
    ])

    const controller = new AbortController()
    await downloadFile('https://example.com/model.bin', destPath, () => {}, controller.signal)

    expect(calls[1].rangeHeader).toBe('bytes=256-') // we did try
    // File is 1024 (the restart truncated to 0 and wrote the whole body).
    expect(statSync(destPath).size).toBe(1024)
    expect(Array.from(readFileSync(destPath))).toEqual(Array.from(fullBody))
  })

  it('classifies HTTP 404 as fatal — no retry, throws DownloadError(fatal)', async () => {
    const { calls } = setMockFetch([
      { status: 404, headers: {}, body: new Uint8Array(0) },
    ])

    const controller = new AbortController()
    await expect(
      downloadFile('https://example.com/model.bin', destPath, () => {}, controller.signal),
    ).rejects.toMatchObject({
      name: 'DownloadError',
      code: 'fatal',
    })
    expect(calls).toHaveLength(1) // no retry
  })

  it('respects AbortSignal pre-fetch: throws DownloadError(aborted), no fetch issued', async () => {
    const { calls } = setMockFetch([
      { status: 200, headers: { 'content-length': '1024' }, body: bodyOfBytes(1024) },
    ])
    const controller = new AbortController()
    controller.abort()

    await expect(
      downloadFile('https://example.com/model.bin', destPath, () => {}, controller.signal),
    ).rejects.toMatchObject({ name: 'DownloadError', code: 'aborted' })
    expect(calls).toHaveLength(0)
  })

  it('exhausts the retry budget on sustained transient failures → throws DownloadError(network)', async () => {
    // Each attempt receives 50 B then drops.  Retries 2-5 use 206
    // (server honoured Range), so received accumulates 50 B per
    // attempt and the Range header increments accordingly.  5
    // attempts total = the MAX_DOWNLOAD_ATTEMPTS cap, after which
    // downloadFile gives up and throws.
    const body = bodyOfBytes(1024)
    const firstResp: MockResponse = {
      status: 200,
      headers: { 'content-length': String(body.length) },
      body,
      interruptAt: 50,
      interruptError: new TypeError('terminated'),
    }
    const retryResp: MockResponse = {
      // 206 so the downloader appends rather than treating it as
      // "server ignored Range" and resetting received to 0.
      status: 206,
      headers: { 'content-length': '974' /* remainder, ish — we drop early anyway */ },
      body,
      interruptAt: 50,
      interruptError: new TypeError('terminated'),
    }
    const { calls } = setMockFetch([
      firstResp, retryResp, retryResp, retryResp, retryResp,
    ])

    const controller = new AbortController()
    await expect(
      downloadFile('https://example.com/model.bin', destPath, () => {}, controller.signal),
    ).rejects.toMatchObject({ name: 'DownloadError', code: 'network' })

    expect(calls).toHaveLength(5) // MAX_DOWNLOAD_ATTEMPTS
    expect(calls[0].rangeHeader).toBeNull()
    expect(calls[1].rangeHeader).toBe('bytes=50-')
    expect(calls[2].rangeHeader).toBe('bytes=100-')
    expect(calls[3].rangeHeader).toBe('bytes=150-')
    expect(calls[4].rangeHeader).toBe('bytes=200-')
  })

  it('preserves received bytes across retries (no progress regression)', async () => {
    // 800 B total.  Attempt 1 drops at 200 B (cl=800).  Attempt 2 is
    // 206 with cl=600 (the bytes-200- range), no drop — completes the
    // file.  Both attempts together: 200 + 600 = 800.
    const fullBody = bodyOfBytes(800, 0x12)
    setMockFetch([
      { status: 200, headers: { 'content-length': '800' }, body: fullBody, interruptAt: 200 },
      { status: 206, headers: { 'content-length': '600' }, body: fullBody.subarray(200) },
    ])

    const progressSnapshots: number[] = []
    const controller = new AbortController()
    await downloadFile('https://example.com/model.bin', destPath, (received) => {
      progressSnapshots.push(received)
    }, controller.signal)

    // The progress sequence MUST be monotonically non-decreasing —
    // a retry that restarted from 0 would show received dropping
    // back to a small number mid-stream, which is the user-facing
    // bug REQ-081 explicitly avoids.
    for (let i = 1; i < progressSnapshots.length; i++) {
      expect(progressSnapshots[i]).toBeGreaterThanOrEqual(progressSnapshots[i - 1])
    }
    expect(progressSnapshots.at(-1)).toBe(800)
    expect(statSync(destPath).size).toBe(800)
  })

  // APPEND-mode contract is asserted by the "resumes mid-stream
  // failure" test above — it compares file content byte-for-byte
  // against the original body, which only passes when the second
  // attempt appends rather than truncates.  No dedicated test
  // here.
})
