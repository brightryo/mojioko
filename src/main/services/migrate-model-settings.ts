import type { AppSettings } from '../../shared/types'

/**
 * REQ-20260615-065 S-4 — pure migration step run during settings
 * hydrate.  Pre-v1.3.0 IDs `'small'` / `'medium'` are reassigned to
 * the new default `'large-v3-turbo'`; the v1.3.0 ship models pass
 * through unchanged; any other non-null ID (= corrupted / future-
 * write-from-older-version / hand-edited junk) is dropped to `null`
 * so the renderer falls back to the picker instead of trying to
 * load something that doesn't exist.  No toast / no UI prompt —
 * the REQ explicitly forbids surfacing the migration per row.
 *
 * Lives in its own module (no electron / logger imports) so vitest
 * can exercise every branch in `tests/unit/migrate-deprecated-model.test.ts`
 * without dragging in the main-process environment.
 *
 * Pure on the input `settings` object: returns the SAME reference
 * when no field migrates, or a NEW object with the migrated values
 * when at least one field changed.  Callers compare by `===` to
 * decide whether to persist back to disk.
 */
const DEPRECATED_MODEL_IDS = new Set(['small', 'medium'])
const KNOWN_V130_MODEL_IDS = new Set(['large-v3', 'large-v3-turbo'])

export function migrateDeprecatedModelIds(settings: AppSettings): AppSettings {
  let activeModelId = settings.activeModelId
  let whisperModel = settings.transcriptionDefaults.whisperModel

  if (activeModelId !== null && DEPRECATED_MODEL_IDS.has(activeModelId)) {
    activeModelId = 'large-v3-turbo'
  } else if (activeModelId !== null && !KNOWN_V130_MODEL_IDS.has(activeModelId)) {
    activeModelId = null
  }

  if (DEPRECATED_MODEL_IDS.has(whisperModel)) {
    whisperModel = 'large-v3-turbo'
  }

  if (
    activeModelId === settings.activeModelId &&
    whisperModel === settings.transcriptionDefaults.whisperModel
  ) {
    return settings
  }

  return {
    ...settings,
    activeModelId,
    transcriptionDefaults: { ...settings.transcriptionDefaults, whisperModel },
  }
}
