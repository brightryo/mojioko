import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { vi } from 'vitest'

// Same electron stub as download-file.test.ts — model-downloader pulls in
// logger → paths → electron.app.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() },
}))

const { downloadFile } = await import('../../src/main/services/model-downloader')

/**
 * REQ-0409 — idle-stall detection + Range resume.  The first attempt delivers
 * some bytes then goes silent (a hung connection); the opt-in stall watchdog
 * must abort that attempt and RETRY with `Range: bytes=<received>-`, appending
 * the rest — NOT restart from zero, and NOT hang forever.
 *
 * Real timers: the watchdog (40 ms) + one retry backoff (~1 s) must actually
 * elapse, so this test takes ~1 s.
 */
function makeStallThenResumeFetch(): { calls: Array<{ rangeHeader: string | null }> } {
  const calls: Array<{ rangeHeader: string | null }> = []
  let i = 0
  const fake = async (_input: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({ rangeHeader: headers['Range'] ?? null })
    const signal = init?.signal as AbortSignal | undefined
    if (i++ === 0) {
      // Attempt 1: deliver 256 B, then STALL (never enqueue more, never close).
      // When the watchdog aborts the attempt signal, error the stream so the
      // reader rejects (mirrors a real fetch cancelling its body stream).
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () =>
            controller.error(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
          controller.enqueue(new Uint8Array(256).fill(0xAB))
          // …and then nothing (stall).
        },
      })
      return new Response(body, { status: 200, headers: new Headers({ 'content-length': '1024' }) })
    }
    // Attempt 2: honour the Range with 206 + the remaining 768 B.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(768).fill(0xAB))
        controller.close()
      },
    })
    return new Response(body, { status: 206, headers: new Headers({ 'content-length': '768' }) })
  }
  ;(global as { fetch: unknown }).fetch = fake
  return { calls }
}

describe('REQ-0409 — downloadFile stall detection + Range resume', () => {
  let workDir: string
  let destPath: string
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'mojioko-stall-test-'))
    destPath = join(workDir, 'model.bin')
    originalFetch = globalThis.fetch
    vi.useRealTimers()
  })
  afterEach(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    rmSync(workDir, { recursive: true, force: true })
    globalThis.fetch = originalFetch
  })

  it('aborts a stalled attempt and resumes with Range bytes=256-', async () => {
    const { calls } = makeStallThenResumeFetch()
    const controller = new AbortController()
    await downloadFile('https://example.com/model.bin', destPath, () => {}, controller.signal, {
      stallTimeoutMs: 40,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].rangeHeader).toBeNull() // fresh
    expect(calls[1].rangeHeader).toBe('bytes=256-') // resume, not from zero
    expect(statSync(destPath).size).toBe(1024) // 256 + 768 appended
  }, 15_000)

  it('a genuine user cancel during a stall-enabled download does NOT retry', async () => {
    // fetch that hangs forever until aborted.
    const calls: number[] = []
    ;(global as { fetch: unknown }).fetch = async (_i: unknown, init?: RequestInit) => {
      calls.push(1)
      const signal = init?.signal as AbortSignal | undefined
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const onAbort = () =>
            controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted) return onAbort()
          signal?.addEventListener('abort', onAbort, { once: true })
        },
      })
      return new Response(body, { status: 200, headers: new Headers({ 'content-length': '1024' }) })
    }
    const controller = new AbortController()
    const p = downloadFile('https://example.com/model.bin', destPath, () => {}, controller.signal, {
      stallTimeoutMs: 5_000, // long, so the user cancel wins the race
    })
    setTimeout(() => controller.abort(), 20)
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    expect(calls).toHaveLength(1) // no retry after a real user cancel
  }, 15_000)
})
