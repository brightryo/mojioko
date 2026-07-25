import type { AppSettings } from '../../shared/types'

/**
 * Pure merge used by the `settings:save` handler.  Kept in its own file
 * (no electron / logger / fs imports) so `tests/unit/settings-save-
 * merge.test.ts` can exercise it directly without a vitest electron stub.
 *
 * `incoming` is the renderer's `AppSettings` payload — it always
 * TypeScript-satisfies `AppSettings`, but several fields the main
 * process owns exclusively are left `null` / `undefined` because the
 * renderer's Zustand store either sends the sentinel (`activeModelId`,
 * `lastInputDir`, `lastOutputDir` — reset each save) or does not track
 * the field at all (`activeAccelerator`, which is written exclusively
 * via the `gpu-tool:select` IPC).  For those main-managed fields we
 * fall back to the on-disk value in `existing` so `settingsSave` never
 * overwrites a good value with `null` / `undefined`.
 *
 * REQ-0157 — before this merge preserved `activeAccelerator`, the very
 * first debounced auto-save fired ~500 ms after startup hydrate (the
 * Zustand `set()` inside `hydrate()` triggers the App.tsx subscribe
 * → save timer) and silently wiped the field from settings.json because
 * the renderer's payload has no such key.  On the next launch
 * `loadSettings` fell back to the `'cpu'` default, `getEffectiveGpuToolDir()`
 * returned null, and the sidecar was spawned without
 * `MOJIOKO_GPU_TOOL_DIR` — which broke both the "DL → auto-select GPU"
 * flow and the "GPU choice survives a restart" flow and produced the
 * cublas-not-found error on the first transcribe attempt.
 *
 * REQ-0158 — the same class of bug applied to `defaultInputDir` and
 * `defaultOutputDir` (the Settings dialog's user-preferred fixed
 * folders, REQ-0121).  These have a subtly different semantics from
 * the REQ-0157 field: `null` is a valid "user cleared via the ×
 * button" state distinct from "renderer did not send this key."
 * A plain `?? existing` fallback collapses those two cases and eats
 * legitimate clears.  We therefore use `'key' in incoming` — present
 * (including `null`) → respect the payload, absent → preserve
 * `existing`.  Paired with the App.tsx change that now includes both
 * fields in the debounced-save payload, this makes both "set to a
 * folder" and "clear to null" survive a restart.
 *
 * REQ-0279 — same class of bug applied to `fontSetInstalledVersion`.
 * The field is written exclusively by main (via the `fontList:recordSetVersion`
 * IPC that fires at the end of a successful bulk font download); the
 * renderer's debounced-save payload has NEVER carried it.  Without a
 * fallback here, any store change that scheduled a debounced save
 * BEFORE recordSetVersion — and fired AFTER — silently wiped the
 * version stamp back to `undefined`, and `deriveFontStatus` then
 * reported every non-bundled font as `not-installed` in the very next
 * `fontList` call.  Users saw "batch DL completed but inspector shows
 * only the default font" and were forced to re-run the batch a second
 * time (which usually worked because no fresh store change had
 * scheduled a debounce that would fire between the 2nd DL and refresh).
 * `'key' in incoming` semantics (not `?? existing`) so a hypothetical
 * future "renderer clears the version to force a re-download" flow
 * would still round-trip — even though no such flow exists today.
 *
 * Step-3-only UI state (`burnin`, `subtitleBackground`, `audioMode`)
 * is stripped from the result — the renderer treats those as
 * session-only and resets them on Step 1 navigation.
 */
export function mergeSettingsForSave(
  incoming: AppSettings,
  existing: AppSettings,
): AppSettings {
  const merged: AppSettings = {
    ...incoming,
    activeModelId:     incoming.activeModelId     ?? existing.activeModelId,
    lastInputDir:      incoming.lastInputDir      ?? existing.lastInputDir,
    lastOutputDir:     incoming.lastOutputDir     ?? existing.lastOutputDir,
    activeAccelerator: incoming.activeAccelerator ?? existing.activeAccelerator,
    defaultInputDir:   'defaultInputDir'  in incoming ? incoming.defaultInputDir  : existing.defaultInputDir,
    defaultOutputDir:  'defaultOutputDir' in incoming ? incoming.defaultOutputDir : existing.defaultOutputDir,
    // REQ-0194 — same `'key' in incoming` semantics as REQ-0158.
    defaultProjectDir: 'defaultProjectDir' in incoming ? incoming.defaultProjectDir : existing.defaultProjectDir,
    // REQ-0279 — see the docblock above.  Same `'key' in incoming`
    // semantics as REQ-0158/REQ-0194.  Today the renderer never sends
    // this key, so this line always falls through to `existing` and
    // preserves whatever value the `recordSetVersion` IPC last wrote.
    fontSetInstalledVersion:
      'fontSetInstalledVersion' in incoming
        ? incoming.fontSetInstalledVersion
        : existing.fontSetInstalledVersion,
  }
  delete merged.burnin
  delete merged.subtitleBackground
  delete merged.audioMode
  return merged
}
