import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * REQ-0244 — regression coverage for the promise-hang cancel bug
 * called out in REQ-0244 §0.1 / §0.3 (batch-cancel doesn't restore
 * the batch button).
 *
 * The pre-fix pattern in the three renderer download services was:
 *
 *     cancel: () => {
 *       unsub?.()                                 // ← BUG
 *       if (channelId) electronAPI.<x>Cancel(channelId)
 *     }
 *
 * Unsubscribing before triggering the main-side cancel meant the
 * `{event:'failed', errorCode:'aborted'}` event that main emits on
 * abort landed on nobody, and the inner `new Promise((resolve, reject)
 * => {...})` never settled.  Any caller doing `await run.promise` —
 * for example font-picker's `handleBatchDownload` — stalled forever
 * on the cancelled iteration, and its post-loop cleanup (which resets
 * `batchState` to null and re-shows the batch button) never ran.
 *
 * These tests reconstruct that scenario against a stubbed electronAPI
 * and assert the outer promise *does* settle (reject with
 * Cancelled-shaped error) after cancel().  Both `downloadFont` and
 * `downloadModel` are exercised because both had the same bug pattern
 * and both are fixed the same way.  `startGpuToolDownload` uses a
 * subtly different shape but the same principle.
 */

// The main-side services need Electron IPC types; the renderer's
// `services/*` modules only call `window.electronAPI.*` at runtime.
// Set up a stub window before importing the services under test.
type Handler = (payload: unknown) => void
interface Sub { channel: string; handler: Handler; active: boolean }
const subs: Sub[] = []

// The stubbed `subscribeToChannel` records the handler + returns an
// unsubscribe fn.  Tests use `subs` to introspect whether a service
// left its subscription attached (correct — lets main's 'failed'
// event settle the promise) or unsubscribed early (bug).
function makeElectronStub() {
  return {
    fontDownload: vi.fn().mockResolvedValue({ ok: true, data: { channelId: 'font:download:test-1' } }),
    fontDownloadCancel: vi.fn().mockResolvedValue(undefined),
    transcriptionDownloadModel: vi.fn().mockResolvedValue({ ok: true, data: { channelId: 'transcription:download:test-1' } }),
    transcriptionDownloadModelCancel: vi.fn().mockResolvedValue(undefined),
    gpuToolDownload: vi.fn().mockResolvedValue({ ok: true, data: { channelId: 'gpu-tool:event:test-1' } }),
    gpuToolDownloadCancel: vi.fn().mockResolvedValue(undefined),
    subscribeToChannel: vi.fn((channel: string, handler: Handler): (() => void) => {
      const sub: Sub = { channel, handler, active: true }
      subs.push(sub)
      return () => { sub.active = false }
    }),
  }
}

// Fresh window for each test so cross-test state doesn't leak.
beforeEach(() => {
  subs.length = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: makeElectronStub(),
  }
})

describe('REQ-0244 downloadFont cancel settles the outer promise', () => {
  it('cancel() causes await run.promise to reject (the batch-cancel-restore fix)', async () => {
    const { downloadFont } = await import('../../src/renderer/services/font')
    const run = downloadFont('Delius', () => {})

    // Wait for the async IIFE to reach the subscribe step.  A single
    // microtask flush isn't enough because the initial invoke is
    // itself an awaited promise; a `setImmediate`-equivalent (queued
    // microtask twice) resolves it under the vitest jsdom runtime.
    // Flush all pending microtasks + one macrotask tick so the
    // async IIFE reaches the subscribe step (a plain double
    // `await Promise.resolve()` isn't enough under jsdom).
    await new Promise((r) => setTimeout(r, 0))

    expect(subs.length).toBe(1)
    expect(subs[0].active).toBe(true)

    // Call cancel.  Pre-fix this would have unsubbed immediately;
    // post-fix the subscription stays attached so main's 'failed'
    // event settles the inner Promise.  We simulate the main-side
    // 'failed' event by invoking the recorded handler ourselves.
    run.cancel()
    expect(subs[0].active).toBe(true)  // still attached — this is the fix
    expect(window.electronAPI.fontDownloadCancel).toHaveBeenCalledWith('font:download:test-1')

    // Simulate main emitting the abort-triggered failed event.
    subs[0].handler({ event: 'failed', error: 'AbortError' })

    // The outer promise MUST now reject (pre-fix it would hang forever).
    await expect(run.promise).rejects.toThrow()
    expect(subs[0].active).toBe(false)  // handler unsubbed on reject
  })

  it('cancel() before initial invoke resolves: subscription never attaches, promise still settles', async () => {
    // If the user hits cancel between "clicked Install" and "IPC
    // invoke resolved", we must still unwind cleanly.  The renderer
    // service sets a `cancelled` flag; the async IIFE checks it after
    // the invoke and throws.
    const { downloadFont } = await import('../../src/renderer/services/font')
    const run = downloadFont('Delius', () => {})

    // Cancel immediately, before the invoke resolves.
    run.cancel()

    await expect(run.promise).rejects.toThrow(/Cancel/i)
    // Main-side cancel was invoked (with the channelId, which is
    // known by the time the invoke resolved and the flag was checked).
    expect(window.electronAPI.fontDownloadCancel).toHaveBeenCalled()
  })
})

describe('REQ-0244 downloadModel cancel settles the outer promise', () => {
  it('cancel() leaves subscription attached so failed event can reject', async () => {
    const { downloadModel } = await import('../../src/renderer/services/transcription')
    const run = downloadModel('large-v3', () => {})

    // Flush all pending microtasks + one macrotask tick so the
    // async IIFE reaches the subscribe step (a plain double
    // `await Promise.resolve()` isn't enough under jsdom).
    await new Promise((r) => setTimeout(r, 0))

    expect(subs.length).toBe(1)

    run.cancel()
    expect(subs[0].active).toBe(true)
    expect(window.electronAPI.transcriptionDownloadModelCancel).toHaveBeenCalled()

    subs[0].handler({ event: 'failed', error: 'AbortError', errorCode: 'aborted' })

    await expect(run.promise).rejects.toThrow()
    expect(subs[0].active).toBe(false)
  })
})

describe('REQ-0244 startGpuToolDownload cancel settles the outer promise', () => {
  it('cancel() during subscribe leaves the channel open until failed event lands', async () => {
    const { startGpuToolDownload } = await import('../../src/renderer/services/gpu-tool')
    const run = startGpuToolDownload(() => {})

    // Flush all pending microtasks + one macrotask tick so the
    // async IIFE reaches the subscribe step (a plain double
    // `await Promise.resolve()` isn't enough under jsdom).
    await new Promise((r) => setTimeout(r, 0))

    expect(subs.length).toBe(1)
    expect(subs[0].active).toBe(true)

    run.cancel()
    expect(subs[0].active).toBe(true)
    expect(window.electronAPI.gpuToolDownloadCancel).toHaveBeenCalled()

    subs[0].handler({ event: 'failed', error: 'AbortError', errorCode: 'aborted' })

    await expect(run.promise).rejects.toThrow()
    expect(subs[0].active).toBe(false)
  })
})
