import { describe, it, expect, beforeEach } from 'vitest'
import {
  useDownloadActiveStore,
  selectActiveKeys,
} from '../../src/renderer/stores/download-active-store'

/**
 * REQ-0245 — the renderer mirror + the per-kind selector.  The
 * selector is the mechanism that lets each UI row check "is my
 * targetId active?" without depending on a local `downloadingId`
 * that a second concurrent DL would clobber.  These tests pin the
 * shape so a future refactor doesn't silently reintroduce the
 * REQ-0245 regression (large-v3 button flipping back to "Download"
 * when large-v3-turbo starts).
 */
describe('REQ-0245 selectActiveKeys', () => {
  it('returns an empty Set when nothing is active', () => {
    expect(selectActiveKeys([], 'model').size).toBe(0)
  })

  it('returns only the targetIds of the requested kind', () => {
    const active = [
      { kind: 'model' as const, targetId: 'large-v3', label: 'large-v3', startedAt: 0 },
      { kind: 'model' as const, targetId: 'large-v3-turbo', label: 'large-v3-turbo', startedAt: 0 },
      { kind: 'font' as const, targetId: 'Delius', label: 'Delius', startedAt: 0 },
      { kind: 'gpu-tool' as const, targetId: 'cuda-v1', label: 'cuda-v1', startedAt: 0 },
    ]
    const modelKeys = selectActiveKeys(active, 'model')
    expect(modelKeys.size).toBe(2)
    expect(modelKeys.has('large-v3')).toBe(true)
    expect(modelKeys.has('large-v3-turbo')).toBe(true)
    expect(modelKeys.has('Delius')).toBe(false)
    expect(modelKeys.has('cuda-v1')).toBe(false)

    const fontKeys = selectActiveKeys(active, 'font')
    expect(fontKeys.size).toBe(1)
    expect(fontKeys.has('Delius')).toBe(true)

    const gpuKeys = selectActiveKeys(active, 'gpu-tool')
    expect(gpuKeys.size).toBe(1)
    expect(gpuKeys.has('cuda-v1')).toBe(true)
  })

  /**
   * The bug REQ-0245 addresses in a nutshell:
   *   • large-v3 acquires → active = [{model:large-v3}]
   *     → selectActiveKeys(active, 'model') = {large-v3}
   *     → large-v3's row sees `isDownloading=true` (correct)
   *   • large-v3-turbo acquires → active = [{model:large-v3}, {model:turbo}]
   *     → selectActiveKeys(active, 'model') = {large-v3, turbo}
   *     → BOTH rows see `isDownloading=true` (this test proves it)
   *
   * The pre-fix local `downloadingId: string | null` state would
   * have flipped from 'large-v3' to 'large-v3-turbo' on the second
   * click, making large-v3's row false — that's the regression.
   */
  it('REQ-0245 regression: adding a second same-kind download keeps the first flagged', () => {
    const active1 = [
      { kind: 'model' as const, targetId: 'large-v3', label: 'x', startedAt: 0 },
    ]
    const keys1 = selectActiveKeys(active1, 'model')
    expect(keys1.has('large-v3')).toBe(true)
    expect(keys1.has('large-v3-turbo')).toBe(false)

    const active2 = [
      { kind: 'model' as const, targetId: 'large-v3', label: 'x', startedAt: 0 },
      { kind: 'model' as const, targetId: 'large-v3-turbo', label: 'y', startedAt: 0 },
    ]
    const keys2 = selectActiveKeys(active2, 'model')
    expect(keys2.has('large-v3')).toBe(true)     // ← the bug: was flipping to false
    expect(keys2.has('large-v3-turbo')).toBe(true)
  })

  it('REQ-0245 regression: removing one target does not affect the others', () => {
    const active = [
      { kind: 'model' as const, targetId: 'large-v3', label: 'x', startedAt: 0 },
      { kind: 'model' as const, targetId: 'large-v3-turbo', label: 'y', startedAt: 0 },
      { kind: 'font' as const, targetId: 'Delius', label: 'z', startedAt: 0 },
    ]
    const afterCancelLarge = active.filter((a) => !(a.kind === 'model' && a.targetId === 'large-v3'))
    const keys = selectActiveKeys(afterCancelLarge, 'model')
    expect(keys.has('large-v3')).toBe(false)
    expect(keys.has('large-v3-turbo')).toBe(true)  // Sibling still flagged.
    expect(selectActiveKeys(afterCancelLarge, 'font').has('Delius')).toBe(true)
  })
})

describe('REQ-0245 useDownloadActiveStore', () => {
  beforeEach(() => {
    useDownloadActiveStore.getState().setActive([])
  })

  it('starts empty', () => {
    expect(useDownloadActiveStore.getState().active).toEqual([])
  })

  it('setActive replaces the whole array (broadcast semantics)', () => {
    const next = [
      { kind: 'model' as const, targetId: 'large-v3', label: 'x', startedAt: 1 },
    ]
    useDownloadActiveStore.getState().setActive(next)
    expect(useDownloadActiveStore.getState().active).toEqual(next)

    const next2 = [
      ...next,
      { kind: 'gpu-tool' as const, targetId: 'cuda-v1', label: 'y', startedAt: 2 },
    ]
    useDownloadActiveStore.getState().setActive(next2)
    expect(useDownloadActiveStore.getState().active).toEqual(next2)
    expect(useDownloadActiveStore.getState().active.length).toBe(2)
  })
})
