/**
 * REQ-0500 §3-2 — report how the translation sidecar WOULD resolve, without
 * spawning it.
 *
 * ## Why this exists
 *
 * `status` reported `translation: { activeId, installed }` and `tools` reported
 * a hard-coded `translator: 'venv-required'`.  Neither says anything about
 * whether translation can actually run, and the hard-coded string became wrong
 * at REQ-0494 (translation now ships inside the transcriber's PyInstaller
 * bundle).  REQ-0493 shipped a packaged build where the model was installed,
 * `status` looked completely healthy, and every translate failed with
 * `PYTHON_MISSING`.
 *
 * The fix is not "add a field" but "derive the field from the execution path":
 * this calls the SAME pure resolver `translation-sidecar.ts` calls, so the
 * reported mode cannot drift from what a real `translate` will do.
 */
import { app } from 'electron'
import { getPythonExecutable, getTranscriberExePath, getTranslateSidecarPath } from '../lib/paths'
import { pickTranslateSpawn } from '../services/translate-spawn'

export interface TranslationRuntime {
  /** How a translate call would spawn: the bundled exe, `.venv` python, or neither. */
  mode: 'bundled-exe' | 'venv' | 'unavailable'
  exePath: string | null
  /**
   * Whether ctranslate2 / sentencepiece actually import.
   *
   * Always `null` here — proving it means spawning Python (seconds), and
   * `status` is documented as the agent's cheap first move.  `null` means
   * "not checked", never "ok"; the authoritative check is the
   * `verify:translate-packaged` gate.
   */
  selftest: null
}

export function resolveTranslationRuntime(): TranslationRuntime {
  try {
    const r = pickTranslateSpawn({
      isPackaged: app.isPackaged,
      bundledExe: getTranscriberExePath(),
      pythonExe: getPythonExecutable(),
      translateScript: getTranslateSidecarPath(),
    })
    return { mode: r.mode === 'bundled' ? 'bundled-exe' : 'venv', exePath: r.exe, selftest: null }
  } catch {
    // `pickTranslateSpawn` throws PYTHON_MISSING when neither route exists.
    return { mode: 'unavailable', exePath: null, selftest: null }
  }
}
