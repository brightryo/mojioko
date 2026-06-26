import type { WhisperModelId } from '../../shared/types'

/**
 * Decide which Whisper model the app should treat as "active" given the
 * persisted settings AND the actual model files present on disk.
 *
 * Pure (no electron / fs / logger imports) so vitest can exercise every
 * branch in `tests/unit/resolve-active-model.test.ts` without main-process
 * scaffolding.  Callers (`buildModelsState` in `ipc/transcription.ts`)
 * thread the disk-existence check in as a callback so this module stays
 * fs-agnostic.
 *
 * Decision tree:
 *
 *   1. `activeModelId` is set in settings AND its files are on disk
 *      → `kept`  (mainstream path, no behavior change vs v1.3.1).
 *
 *   2. `activeModelId` is set in settings but its files are NOT on disk
 *      → **`corrected-null`** (REQ-20260615-077).  Surfaces in two
 *      real-world scenarios:
 *        (a) MSIX install where the OS AppData merge surfaces an
 *            NSIS install's `settings.json` (`activeModelId='large-v3-
 *            turbo'`) into the MSIX app, but the MSIX virtualized
 *            `models/` is empty.
 *        (b) NSIS user who deleted model files via Explorer rather
 *            than the in-app uninstall button — same desync.
 *      Returning `null` here lets the renderer treat the install as
 *      "no model selected" so REQ-072 auto-opens the Whisper accordion,
 *      the footer flips to the unselected label, and `canStart` falls
 *      to `false` (avoiding a delayed sidecar failure mid-transcribe).
 *
 *   3. `activeModelId` is null/missing AND `settings.transcriptionDefaults
 *      .whisperModel` names a model whose files ARE on disk
 *      → `migrated-from-whisper-model`.  Pre-existing behavior dating
 *      to v1.3.0: synthesizes an `activeModelId` for users on settings
 *      versions that pre-date the field.  Caller persists the resolved
 *      value back to settings.json so subsequent boots skip the
 *      synthesis (mainstream NSIS happy path on a fresh install of a
 *      new model).
 *
 *   4. None of the above → `kept` returning `null`.  No persistence;
 *      no log line; the renderer shows the unselected state.
 *
 * REQ-20260615-077 Option A — when the result is `corrected-null` the
 * caller MUST NOT persist the corrected value.  Rationale: in the MSIX
 * + NSIS coexistence environment, the NSIS install's `settings.json`
 * leaks into the MSIX app via AppData merge; persisting from the MSIX
 * side would clobber the NSIS install's `activeModelId` with `null` on
 * disk.  The log line firing each launch is the accepted cost.
 */
export interface ResolveActiveModelIdResult {
  /** The resolved value to return to the renderer. */
  activeModelId: WhisperModelId | null
  /** Which decision branch fired — drives caller-side logging + saving. */
  source: 'kept' | 'corrected-null' | 'migrated-from-whisper-model'
  /**
   * Populated only when `source === 'corrected-null'`.  The
   * `settingsActiveModelId` value the caller passed in — surfaced so the
   * caller can log it without re-reading settings.
   */
  correctedFrom?: WhisperModelId
}

export function resolveActiveModelId(
  settingsActiveModelId: WhisperModelId | null | undefined,
  settingsWhisperModel: WhisperModelId | null | undefined,
  isInstalled: (modelId: WhisperModelId) => boolean,
): ResolveActiveModelIdResult {
  // Branch 1 & 2: settings has an activeModelId
  if (settingsActiveModelId !== null && settingsActiveModelId !== undefined) {
    if (isInstalled(settingsActiveModelId)) {
      return { activeModelId: settingsActiveModelId, source: 'kept' }
    }
    // Stale: files missing on disk.  Fall through to the migration
    // branch in case the legacy `whisperModel` field points at a model
    // that IS installed.
    const correctedFrom = settingsActiveModelId
    if (settingsWhisperModel !== null && settingsWhisperModel !== undefined) {
      if (isInstalled(settingsWhisperModel)) {
        // Stale activeModelId, but whisperModel rescues us.  Treat as
        // a fresh migration so the caller persists.  No log line for
        // the correction — the migration log subsumes it.
        return {
          activeModelId: settingsWhisperModel,
          source: 'migrated-from-whisper-model',
        }
      }
    }
    return {
      activeModelId: null,
      source: 'corrected-null',
      correctedFrom,
    }
  }

  // Branch 3: no activeModelId — try the legacy whisperModel migration.
  if (settingsWhisperModel !== null && settingsWhisperModel !== undefined) {
    if (isInstalled(settingsWhisperModel)) {
      return {
        activeModelId: settingsWhisperModel,
        source: 'migrated-from-whisper-model',
      }
    }
  }

  // Branch 4: nothing usable on disk.  Renderer shows the unselected state.
  return { activeModelId: null, source: 'kept' }
}
