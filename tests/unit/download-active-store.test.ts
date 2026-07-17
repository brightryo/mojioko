import { describe, it, expect } from 'vitest'
import {
  useDownloadActiveStore,
  isOtherDownloadActive,
} from '../../src/renderer/stores/download-active-store'

/**
 * REQ-0241 — the renderer mirror + the "is a DIFFERENT kind running?"
 * selector.  The selector's contract (same-kind is caller's own
 * progress and does not block) is what keeps each manager's own
 * in-place progress UI live while cross-kind buttons are disabled.
 * These are trivial pure-function tests but pin the contract.
 */
describe('REQ-0241 isOtherDownloadActive', () => {
  it('returns false when nothing is active', () => {
    expect(isOtherDownloadActive(null, 'model')).toBe(false)
    expect(isOtherDownloadActive(null, 'gpu-tool')).toBe(false)
    expect(isOtherDownloadActive(null, 'font')).toBe(false)
    expect(isOtherDownloadActive(null, null)).toBe(false)
  })

  it('returns false when the active kind matches my kind (my own progress)', () => {
    const active = { kind: 'model' as const, label: 'large-v3', startedAt: 0 }
    expect(isOtherDownloadActive(active, 'model')).toBe(false)
  })

  it('returns true when the active kind differs from my kind', () => {
    const active = { kind: 'model' as const, label: 'large-v3', startedAt: 0 }
    expect(isOtherDownloadActive(active, 'font')).toBe(true)
    expect(isOtherDownloadActive(active, 'gpu-tool')).toBe(true)
  })

  it('returns true when myKind is null (any active DL counts)', () => {
    const active = { kind: 'font' as const, label: 'Delius', startedAt: 0 }
    expect(isOtherDownloadActive(active, null)).toBe(true)
  })
})

describe('REQ-0241 useDownloadActiveStore', () => {
  it('starts idle', () => {
    // The store is a module-level singleton; reset by writing null
    // before asserting so any earlier test can't leak state in.
    useDownloadActiveStore.getState().setActive(null)
    expect(useDownloadActiveStore.getState().active).toBeNull()
  })

  it('setActive updates the slot and roundtrips the shape', () => {
    const next = { kind: 'gpu-tool' as const, label: 'cuda-v1', startedAt: 12345 }
    useDownloadActiveStore.getState().setActive(next)
    const got = useDownloadActiveStore.getState().active
    expect(got).toEqual(next)

    useDownloadActiveStore.getState().setActive(null)
    expect(useDownloadActiveStore.getState().active).toBeNull()
  })
})
