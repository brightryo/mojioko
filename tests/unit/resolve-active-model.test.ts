import { describe, it, expect, vi } from 'vitest'
import { resolveActiveModelId } from '../../src/main/services/resolve-active-model'
import type { WhisperModelId } from '../../src/shared/types'

/**
 * REQ-20260615-077 established the pure reconciler that decides the
 * runtime `activeModelId` from persisted settings + an on-disk
 * installed-check.
 *
 * REQ-0247 removed the previous "migrated-from-whisper-model" branch
 * that used to synthesise an `activeModelId` when settings had a
 * `whisperModel` field naming an installed model.  That branch was
 * the survivor of the DL-completion auto-select cleanup started in
 * REQ-0246: `handleConfirmInstall`'s post-DL `refresh()` runs
 * `buildModelsState` → `resolveActiveModelId`, and a fresh user
 * whose (default) `whisperModel` was 'large-v3' would find the
 * just-downloaded 'large-v3' silently promoted to `activeModelId`
 * (persisted via `saveSettings`) before the settle even landed in
 * the UI.  That's exactly the "installs → 使用中" behaviour REQ-0247
 * targets, and it lived in this file — not in the renderer.
 *
 * Post-REQ-0247 branches:
 *
 *   (a) activeModelId set + files present → keep, no save
 *   (b) activeModelId set + files MISSING → corrected-null (REQ-077),
 *       no save (Option A)
 *   (c) activeModelId null / undefined → keep null (renderer shows
 *       the unselected state; user picks explicitly via "Use this")
 *
 * The `whisperModel` parameter is preserved on the function
 * signature so callers don't need to change; its value has no
 * effect on the result under REQ-0247.
 */

const TURBO: WhisperModelId = 'large-v3-turbo'
const V3: WhisperModelId = 'large-v3'

function fakeInstalled(installedIds: WhisperModelId[]): (id: WhisperModelId) => boolean {
  const set = new Set<WhisperModelId>(installedIds)
  return (id) => set.has(id)
}

describe('REQ-077 / REQ-0247 — resolveActiveModelId', () => {
  it('(a) keeps activeModelId when its files are present on disk', () => {
    const result = resolveActiveModelId(TURBO, V3, fakeInstalled([TURBO]))
    expect(result.activeModelId).toBe(TURBO)
    expect(result.source).toBe('kept')
    expect(result.correctedFrom).toBeUndefined()
  })

  it('(b) reverts activeModelId to null when its files are missing (no whisperModel rescue any more)', () => {
    const result = resolveActiveModelId(TURBO, undefined, fakeInstalled([]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('corrected-null')
    expect(result.correctedFrom).toBe(TURBO)
  })

  it('(b) MSIX scenario — leaked NSIS settings but virtualized models dir is empty', () => {
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

  /**
   * REQ-0247 regression: this scenario is the smoking gun of the
   * bug the REQ targets.  Fresh user, `activeModelId: null`, default
   * `whisperModel: 'large-v3'` (from `burnin-defaults.ts`), just
   * downloaded 'large-v3' → `refresh()` triggers this exact call.
   * Pre-REQ-0247 returned `{ activeModelId: 'large-v3', source:
   * 'migrated-from-whisper-model' }` and the caller persisted it =
   * silent auto-select.  Post-REQ-0247 must return null so the row
   * stays "installed but not active" until the user clicks
   * "Use this".
   */
  it('REQ-0247: activeModelId null + whisperModel installed → still null (was: migrated)', () => {
    const result = resolveActiveModelId(null, V3, fakeInstalled([V3]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('kept')
  })

  it('REQ-0247: crossover — stale activeModelId + installed whisperModel → corrected-null (was: migrated)', () => {
    // Pre-REQ-0247 the whisperModel rescue would fire and set
    // activeModelId=V3.  Now the stale activeModelId still resolves
    // to `corrected-null`; the whisperModel field is ignored.
    const result = resolveActiveModelId(TURBO, V3, fakeInstalled([V3]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('corrected-null')
    expect(result.correctedFrom).toBe(TURBO)
  })

  it('treats undefined activeModelId (older settings shape) the same as null', () => {
    const result = resolveActiveModelId(undefined, V3, fakeInstalled([V3]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('kept')
  })

  it('treats undefined whisperModel as no rescue candidate (nothing changes)', () => {
    const result = resolveActiveModelId(null, undefined, fakeInstalled([V3]))
    expect(result.activeModelId).toBeNull()
    expect(result.source).toBe('kept')
  })

  it('isInstalled is queried with the model id being checked (no off-by-one)', () => {
    const probe = vi.fn().mockReturnValue(true)
    resolveActiveModelId(TURBO, V3, probe)
    expect(probe).toHaveBeenNthCalledWith(1, TURBO)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  /**
   * REQ-0247 — the `whisperModel` param is intentionally unused, so
   * `isInstalled` MUST NOT be consulted for it (pre-REQ-0247 called
   * it a second time for the migration branch).  This test pins the
   * removal — if a future refactor accidentally re-enables the
   * migration by reading whisperModel, this test fires immediately.
   */
  it('REQ-0247: isInstalled is NEVER consulted for whisperModel (migration branch removed)', () => {
    const probe = vi.fn().mockReturnValue(false)
    resolveActiveModelId(null, V3, probe)
    // Only branch that would call probe: Branch 1 for activeModelId.
    // Since activeModelId is null, probe should never be called.
    expect(probe).not.toHaveBeenCalled()
  })

  it('REQ-0247: stale activeModelId consults probe once and stops (no whisperModel fallback probe)', () => {
    const probe = vi.fn().mockReturnValue(false)
    const result = resolveActiveModelId(TURBO, V3, probe)
    expect(result.source).toBe('corrected-null')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenNthCalledWith(1, TURBO)
  })
})
