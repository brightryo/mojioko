import { describe, it, expect, beforeEach, vi } from 'vitest'

// Stub electron-log so `logger.info(...)` in the manager doesn't try to
// pull in the real electron `app`.  We don't need Electron itself here
// — the REQ-0244 DownloadManager doesn't broadcast (no BrowserWindow
// dependency any more).
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
 * REQ-0244 — the DownloadManager is a per-key mutex (was single-slot
 * in REQ-0241).  Different `{kind, targetId}` pairs download in
 * parallel; same key is refused.  These tests pin:
 *
 *   • same-key refusal (busy) vs different-key parallel success
 *   • dynamic list resilience (unknown kind/target added at runtime
 *     works because the key is a plain string)
 *   • cancel and release semantics per token (independent per key)
 *   • stale release does not wipe a fresh slot that took the same key
 *
 * A test-only `_resetForTests()` clears every slot so each `it()`
 * starts idle.
 */
describe('REQ-0244 DownloadManager (per-key parallel)', () => {
  beforeEach(() => {
    downloadManager._resetForTests()
  })

  it('idle: snapshot is empty', () => {
    expect(downloadManager.snapshot()).toEqual([])
  })

  it('acquire: returns a token and marks that key busy', () => {
    const t = downloadManager.acquire('model', 'large-v3')
    expect('busy' in t).toBe(false)
    if ('busy' in t) throw new Error('unreachable')
    expect(t.kind).toBe('model')
    expect(t.targetId).toBe('large-v3')
    expect(t.signal.aborted).toBe(false)
    expect(downloadManager.isActive('model', 'large-v3')).toBe(true)
    expect(downloadManager.isActive('model', 'large-v3-turbo')).toBe(false)
  })

  it('same key: second acquire returns busy with the existing holder info', () => {
    const first = downloadManager.acquire('model', 'large-v3')
    if ('busy' in first) throw new Error('unreachable')
    const second = downloadManager.acquire('model', 'large-v3')
    expect('busy' in second).toBe(true)
    if (!('busy' in second)) throw new Error('unreachable')
    expect(second.existing.kind).toBe('model')
    expect(second.existing.targetId).toBe('large-v3')
  })

  it('different keys succeed in parallel (same kind, different target)', () => {
    const a = downloadManager.acquire('model', 'large-v3')
    const b = downloadManager.acquire('model', 'large-v3-turbo')
    expect('busy' in a).toBe(false)
    expect('busy' in b).toBe(false)
    // Both live simultaneously.
    expect(downloadManager.snapshot().length).toBe(2)
    expect(downloadManager.isActive('model', 'large-v3')).toBe(true)
    expect(downloadManager.isActive('model', 'large-v3-turbo')).toBe(true)
  })

  it('different keys succeed in parallel (cross kind — the REQ-0244 core guarantee)', () => {
    const m = downloadManager.acquire('model', 'large-v3')
    const g = downloadManager.acquire('gpu-tool', 'cuda-v1')
    const f = downloadManager.acquire('font', 'Delius')
    expect('busy' in m).toBe(false)
    expect('busy' in g).toBe(false)
    expect('busy' in f).toBe(false)
    expect(downloadManager.snapshot().length).toBe(3)
  })

  it('dynamic list: acquiring a targetId the codebase has never seen before works', () => {
    // The manager keys purely on kind + string.  Adding a new Whisper
    // model or a new font shipped in a later release doesn't require
    // any manager change.  Simulated here by using arbitrary strings.
    const future1 = downloadManager.acquire('model', 'large-v4-hypothetical')
    const future2 = downloadManager.acquire('font', 'FutureFontFamily2027')
    expect('busy' in future1).toBe(false)
    expect('busy' in future2).toBe(false)
  })

  it('release: after release the same key can be acquired again', () => {
    const first = downloadManager.acquire('font', 'Delius')
    if ('busy' in first) throw new Error('unreachable')
    first.release()
    expect(downloadManager.isActive('font', 'Delius')).toBe(false)
    const second = downloadManager.acquire('font', 'Delius')
    expect('busy' in second).toBe(false)
  })

  it('release is idempotent', () => {
    const t = downloadManager.acquire('gpu-tool', 'cuda-v1')
    if ('busy' in t) throw new Error('unreachable')
    t.release()
    t.release()  // no-op, no throw
    expect(downloadManager.isActive('gpu-tool', 'cuda-v1')).toBe(false)
  })

  it('stale release does not wipe a fresh slot that took the same key', () => {
    const a = downloadManager.acquire('model', 'large-v3')
    if ('busy' in a) throw new Error('unreachable')
    a.release()

    const b = downloadManager.acquire('model', 'large-v3')
    if ('busy' in b) throw new Error('unreachable')

    // Simulates: the old cancelled DL's `.finally { release() }` fires
    // after a fresh acquire has taken the same key.  Identity guard
    // must prevent the stale release from clearing the fresh slot.
    a.release()

    expect(downloadManager.isActive('model', 'large-v3')).toBe(true)
    const snap = downloadManager.snapshot()
    expect(snap.length).toBe(1)
    expect(snap[0].targetId).toBe('large-v3')
  })

  it('cancel: aborts the signal and releases the slot (that key only)', () => {
    const m = downloadManager.acquire('model', 'large-v3')
    const g = downloadManager.acquire('gpu-tool', 'cuda-v1')
    if ('busy' in m || 'busy' in g) throw new Error('unreachable')
    expect(m.signal.aborted).toBe(false)
    expect(g.signal.aborted).toBe(false)

    m.cancel()
    // Only the cancelled slot goes away and only its signal aborts.
    expect(m.signal.aborted).toBe(true)
    expect(g.signal.aborted).toBe(false)
    expect(downloadManager.isActive('model', 'large-v3')).toBe(false)
    expect(downloadManager.isActive('gpu-tool', 'cuda-v1')).toBe(true)
  })

  it('cancel is idempotent', () => {
    const t = downloadManager.acquire('model', 'large-v3')
    if ('busy' in t) throw new Error('unreachable')
    t.cancel()
    t.cancel()
    expect(t.signal.aborted).toBe(true)
    expect(downloadManager.isActive('model', 'large-v3')).toBe(false)
  })

  it('snapshot returns all in-flight downloads with correct payload', () => {
    downloadManager.acquire('model', 'large-v3', 'Whisper large-v3')
    downloadManager.acquire('font', 'Delius', 'Delius')
    const snap = downloadManager.snapshot()
    expect(snap.length).toBe(2)
    const byKey = new Map(snap.map((s) => [`${s.kind}:${s.targetId}`, s]))
    expect(byKey.get('model:large-v3')?.label).toBe('Whisper large-v3')
    expect(byKey.get('font:Delius')?.label).toBe('Delius')
    for (const s of snap) {
      expect(typeof s.startedAt).toBe('number')
    }
  })
})
