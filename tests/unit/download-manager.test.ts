import { describe, it, expect, beforeEach, vi } from 'vitest'

// The DownloadManager module imports `BrowserWindow` from electron to
// broadcast state changes to all open windows.  Under vitest there is
// no Electron runtime, so we stub the module with an empty window list
// (getAllWindows returns [] → the broadcast becomes a no-op).  The
// logger import also transitively pulls in electron via `paths.ts`
// dependencies; the same stub covers both.
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
  },
}))

// electron-log's main entry expects an Electron app object; the file
// logger transport also touches `app.getPath('userData')`.  The mock
// above satisfies both.  Stub electron-log outright to avoid noisy
// stdout from log lines emitted by the manager under test.
vi.mock('../../src/main/lib/logger', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

import { downloadManager } from '../../src/main/services/download-manager'

/**
 * REQ-0241 — DownloadManager is a global mutex.  These tests exercise
 * the core invariants that make the "one active download across all
 * kinds" guarantee useful:
 *
 *   §2.1 serialization — a second acquire while one is held must
 *     return `busy` (never a second live token).
 *   §2.1 release — after release the next acquire succeeds.
 *   §2.3 cancel — cancel aborts the signal AND releases the slot.
 *   §2.5 progress channel — the `changed` event fires on each
 *     transition so the renderer stays in sync without polling.
 *   snapshot integrity — the returned info matches what was acquired.
 *
 * A test-only `_resetForTests()` clears the slot between cases so
 * each `it` starts from a known idle state.
 */
describe('REQ-0241 DownloadManager', () => {
  beforeEach(() => {
    downloadManager._resetForTests()
  })

  it('idle: snapshot is null before any acquire', () => {
    expect(downloadManager.snapshot()).toBeNull()
  })

  it('acquire: returns a token and marks the slot busy', () => {
    const t = downloadManager.acquire('model', 'large-v3')
    expect('busy' in t).toBe(false)
    if ('busy' in t) throw new Error('unreachable')
    expect(t.kind).toBe('model')
    expect(t.label).toBe('large-v3')
    expect(t.signal.aborted).toBe(false)
    const snap = downloadManager.snapshot()
    expect(snap).not.toBeNull()
    expect(snap?.kind).toBe('model')
    expect(snap?.label).toBe('large-v3')
    expect(typeof snap?.startedAt).toBe('number')
  })

  it('acquire while busy: second call returns { busy, active } and NO new token', () => {
    const first = downloadManager.acquire('model', 'large-v3')
    if ('busy' in first) throw new Error('first acquire should succeed')

    const second = downloadManager.acquire('font', 'Delius')
    expect('busy' in second).toBe(true)
    if (!('busy' in second)) throw new Error('unreachable')
    expect(second.active.kind).toBe('model')
    expect(second.active.label).toBe('large-v3')

    // Cross-kind: gpu-tool trying to elbow into a font/model DL slot
    // must also fail.  This is the core cross-kind guarantee.
    const third = downloadManager.acquire('gpu-tool', 'cuda-v1')
    expect('busy' in third).toBe(true)
  })

  it('release: after release the next acquire succeeds', () => {
    const first = downloadManager.acquire('font', 'Delius')
    if ('busy' in first) throw new Error('first acquire should succeed')
    first.release()

    expect(downloadManager.snapshot()).toBeNull()
    const second = downloadManager.acquire('model', 'large-v3-turbo')
    expect('busy' in second).toBe(false)
  })

  it('release is idempotent: second release is a no-op', () => {
    const t = downloadManager.acquire('gpu-tool', 'cuda-v1')
    if ('busy' in t) throw new Error('unreachable')
    t.release()
    t.release()  // must not throw and must not corrupt state
    expect(downloadManager.snapshot()).toBeNull()
  })

  it('release from a stale token does not clear a fresh slot', () => {
    // Simulates: model DL finishes and calls release() in its finally
    // block, but by then a different code path has already released
    // + started a new (font) DL.  Token identity must gate the release.
    const first = downloadManager.acquire('model', 'large-v3')
    if ('busy' in first) throw new Error('unreachable')
    first.release()

    const second = downloadManager.acquire('font', 'Delius')
    if ('busy' in second) throw new Error('unreachable')

    // Stale release from the completed model download — the slot is
    // now held by 'font'; the model's late release must NOT wipe it.
    first.release()

    const snap = downloadManager.snapshot()
    expect(snap?.kind).toBe('font')
    expect(snap?.label).toBe('Delius')
  })

  it('cancel: aborts the signal and releases the slot', () => {
    const t = downloadManager.acquire('gpu-tool', 'cuda-v1')
    if ('busy' in t) throw new Error('unreachable')
    expect(t.signal.aborted).toBe(false)

    t.cancel()
    expect(t.signal.aborted).toBe(true)
    expect(downloadManager.snapshot()).toBeNull()
  })

  it('cancel is idempotent: second call is a no-op', () => {
    const t = downloadManager.acquire('model', 'large-v3')
    if ('busy' in t) throw new Error('unreachable')
    t.cancel()
    t.cancel()
    expect(t.signal.aborted).toBe(true)
    expect(downloadManager.snapshot()).toBeNull()
  })

  it('emits "changed" on acquire and release with the correct payload', () => {
    const events: Array<null | { kind: string; label: string }> = []
    const listener = (info: null | { kind: string; label: string }): void => {
      events.push(info ? { kind: info.kind, label: info.label } : null)
    }
    downloadManager.on('changed', listener)

    try {
      const t = downloadManager.acquire('model', 'large-v3')
      if ('busy' in t) throw new Error('unreachable')
      t.release()
    } finally {
      downloadManager.off('changed', listener)
    }

    expect(events).toEqual([
      { kind: 'model', label: 'large-v3' },
      null,
    ])
  })

  it('busy acquires do NOT emit changed', () => {
    const first = downloadManager.acquire('gpu-tool', 'cuda-v1')
    if ('busy' in first) throw new Error('unreachable')

    const events: Array<null | { kind: string }> = []
    const listener = (info: null | { kind: string }): void => {
      events.push(info ? { kind: info.kind } : null)
    }
    downloadManager.on('changed', listener)

    try {
      const second = downloadManager.acquire('font', 'Delius')
      expect('busy' in second).toBe(true)
      // Slot state didn't transition, so nothing should have fired.
      expect(events).toEqual([])
    } finally {
      downloadManager.off('changed', listener)
      first.release()
    }
  })

  it('after acquire cycles the "changed" listener sees the full sequence in order', () => {
    const seq: string[] = []
    const listener = (info: null | { kind: string; label: string }): void => {
      seq.push(info ? `${info.kind}:${info.label}` : 'null')
    }
    downloadManager.on('changed', listener)

    try {
      const a = downloadManager.acquire('model', 'large-v3')
      if ('busy' in a) throw new Error('unreachable')
      a.release()

      const b = downloadManager.acquire('gpu-tool', 'cuda-v1')
      if ('busy' in b) throw new Error('unreachable')
      b.cancel()  // cancel also releases

      const c = downloadManager.acquire('font', 'Delius')
      if ('busy' in c) throw new Error('unreachable')
      c.release()
    } finally {
      downloadManager.off('changed', listener)
    }

    expect(seq).toEqual([
      'model:large-v3',
      'null',
      'gpu-tool:cuda-v1',
      'null',
      'font:Delius',
      'null',
    ])
  })
})
