import { describe, it, expect, vi } from 'vitest'
import { resolveActiveModelId } from '../../src/main/services/resolve-active-model'
import type { WhisperModelId } from '../../src/shared/types'

/**
 * REQ-20260615-077 — pure reconciler that decides the runtime
 * `activeModelId` given persisted settings + an on-disk installed-check.
 *
 * Coverage targets each of the 4 decision branches and the two
 * crossover cases the REQ explicitly calls out:
 *
 *   (a) activeModelId set + files present → keep, no save
 *   (b) activeModelId set + files MISSING → corrected-null (REQ-077),
 *       no save (Option A)
 *   (c) activeModelId null + no whisperModel candidate → keep null
 *   (d) activeModelId null + whisperModel installed → migrate (pre-077
 *       v1.3.0 behavior preserved)
 *
 * Plus:
 *   - crossover: stale activeModelId AND a whisperModel rescue path →
 *     migrate (not corrected-null) — the migration log subsumes the
 *     correction so we don't double-log
 *   - undefined inputs (older settings shapes) treated as null
 */

const TURBO: WhisperModelId = 'large-v3-turbo'
const V3: WhisperModelId = 'large-v3'

function fakeInstalled(installedIds: WhisperModelId[]): (id: WhisperModelId) => boolean {
  const set = new Set<WhisperModelId>(installedIds)
  return (id) => set.has(id)
}

describe('REQ-077 — resolveActiveModelId', () => {
  it('(a) keeps activeModelId when its files are present on disk', () => {
    const result = resolveActiveModelId(TURBO, V3, fakeInstalled([TURBO]))
    expect(result.activeModelId).toBe(TURBO)
    expect(result.source).toBe('kept')
    expect(result.correctedFrom).toBeUndefined()
  })

  it('(b) reverts activeModelId to null when its files are missing AND no whisperModel rescue', () => {
    const result = resolveActiveModelId(TURBO, undefined, fakeInstalled([]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('corrected-null')
    expect(result.correctedFrom).toBe(TURBO)
  })

  it('(b) MSIX scenario — leaked NSIS settings (turbo) but virtualized models dir is empty', () => {
    // Mirrors the live MSIX bug: settings says turbo, whisperModel says
    // large-v3 (also NSIS-leaked), neither file is in the MSIX models dir.
    const result = resolveActiveModelId(TURBO, V3, fakeInstalled([]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('corrected-null')
    expect(result.correctedFrom).toBe(TURBO)
  })

  it('(c) keeps null when activeModelId is null AND no whisperModel is configured', () => {
    const result = resolveActiveModelId(null, null, fakeInstalled([]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('kept')
  })

  it('(c) keeps null when activeModelId is null AND whisperModel candidate is not installed', () => {
    const result = resolveActiveModelId(null, V3, fakeInstalled([]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('kept')
  })

  it('(d) migrates from whisperModel when activeModelId is null and the candidate is installed', () => {
    const result = resolveActiveModelId(null, V3, fakeInstalled([V3]))
    expect(result.activeModelId).toBe(V3)
    expect(result.source).toBe('migrated-from-whisper-model')
  })

  it('crossover — stale activeModelId yields to a rescuing whisperModel migration (single decision, no double-log)', () => {
    // Caller will persist (= migration branch), so the correction note
    // is intentionally NOT emitted — the migration log subsumes it.
    const result = resolveActiveModelId(TURBO, V3, fakeInstalled([V3]))
    expect(result.activeModelId).toBe(V3)
    expect(result.source).toBe('migrated-from-whisper-model')
    expect(result.correctedFrom).toBeUndefined()
  })

  it('treats undefined activeModelId (older settings shape) the same as null', () => {
    const result = resolveActiveModelId(undefined, V3, fakeInstalled([V3]))
    expect(result.activeModelId).toBe(V3)
    expect(result.source).toBe('migrated-from-whisper-model')
  })

  it('treats undefined whisperModel as no rescue candidate', () => {
    const result = resolveActiveModelId(null, undefined, fakeInstalled([V3]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('kept')
  })

  it('isInstalled is queried with the model id being checked (no off-by-one)', () => {
    const probe = vi.fn().mockReturnValue(true)
    resolveActiveModelId(TURBO, V3, probe)
    // First call decides "is the stored activeModelId on disk?"
    expect(probe).toHaveBeenNthCalledWith(1, TURBO)
    // No second call needed because the first returned true.
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('isInstalled is consulted for whisperModel only when activeModelId is unusable', () => {
    const probe = vi.fn().mockImplementation((id) => id === V3)
    // Stale activeModelId, valid rescue
    const result = resolveActiveModelId(TURBO, V3, probe)
    expect(result.activeModelId).toBe(V3)
    expect(result.source).toBe('migrated-from-whisper-model')
    expect(probe).toHaveBeenNthCalledWith(1, TURBO)
    expect(probe).toHaveBeenNthCalledWith(2, V3)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
