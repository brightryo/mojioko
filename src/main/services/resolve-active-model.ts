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
 * Decision tree (post REQ-0247):
 *
 *   1. `activeModelId` is set in settings AND its files are on disk
 *      → `kept`  (mainstream path).
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
 *      "no model selected" so the footer flips to the unselected
 *      label and `canStart` falls to `false` (avoiding a delayed
 *      sidecar failure mid-transcribe).
 *
 *   3. Otherwise → `kept` returning `null`.  Renderer shows the
 *      unselected state until the user explicitly picks a model
 *      via the "Use this" button.
 *
 * REQ-0247 removed the previous "migrated-from-whisper-model" branch
 * that synthesized an `activeModelId` from
 * `settings.transcriptionDefaults.whisperModel` when a matching model
 * became installed.  The intent of that branch — surfacing the
 * user's stated model preference on first launch after upgrade —
 * turned out to also fire on every fresh DL: a new user's
 * `whisperModel` default is `'large-v3'` (`burnin-defaults.ts:41`)
 * and downloading `large-v3` triggered the migration and silently
 * activated it, mid-DL-completion refresh.  That violated the
 * post-REQ-0244/0245/0246 rule "selection changes only on user
 * explicit action" (see SPECIFICATION.md §24.8.3).  Legacy
 * pre-v1.3.0 upgraders now see "no model selected" once and click
 * "Use this" — consistent with the strict explicit-selection rule
 * and consistent with what a fresh install shows.
 *
 * The `settingsWhisperModel` parameter is kept (unused) so callers
 * do not need to be changed and future re-additions of a
 * whisperModel-based signal can plug back in without churn.
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
  /**
   * Which decision branch fired — drives caller-side logging.
   * REQ-0247 removed `'migrated-from-whisper-model'` from the union
   * so the caller-side branch that persisted the migration to
   * `settings.json` also becomes unreachable.
   */
  source: 'kept' | 'corrected-null'
  /**
   * Populated only when `source === 'corrected-null'`.  The
   * `settingsActiveModelId` value the caller passed in — surfaced so the
   * caller can log it without re-reading settings.
   */
  correctedFrom?: WhisperModelId
}

export function resolveActiveModelId(
  settingsActiveModelId: WhisperModelId | null | undefined,
  // REQ-0247 — parameter intentionally unused.  See jsdoc above for
  // the removal rationale.  The signature is preserved so callers
  // (`buildModelsState`) do not need to change.
  _settingsWhisperModel: WhisperModelId | null | undefined,
  isInstalled: (modelId: WhisperModelId) => boolean,
): ResolveActiveModelIdResult {
  // Branch 1 & 2: settings has an activeModelId
  if (settingsActiveModelId !== null && settingsActiveModelId !== undefined) {
    if (isInstalled(settingsActiveModelId)) {
      return { activeModelId: settingsActiveModelId, source: 'kept' }
    }
    // Stale: files missing on disk.  REQ-0247 dropped the
    // whisperModel-rescue fallback that used to try to promote a
    // legacy preference into the active slot — the auto-select was
    // firing on fresh downloads too (see file-level jsdoc).
    return {
      activeModelId: null,
      source: 'corrected-null',
      correctedFrom: settingsActiveModelId,
    }
  }

  // Branch 3: no activeModelId.  Renderer shows the unselected state.
  // REQ-0247 removed the legacy whisperModel migration here.
  return { activeModelId: null, source: 'kept' }
}
