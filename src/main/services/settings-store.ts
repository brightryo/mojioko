import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { getSettingsPath, getAppDataPath } from '../lib/paths'
import { getModelsDir } from '../lib/paths'
import { BURNIN_DEFAULTS } from '../../shared/burnin-defaults'
import { DEFAULT_LANGUAGE, type SupportedLanguage } from '../../shared/app-info'
import { TRANSCRIPTION_DEFAULTS } from '../../shared/constants'
import { migrateDeprecatedModelIds } from './migrate-model-settings'
import type { AppSettings } from '../../shared/types'
import { SettingsCorruptError } from '../../shared/errors'
import { detectOsLanguage } from '../lib/os-language'
import log from '../lib/logger'

// REQ-20260615-065 S-4 — re-export so existing callers that imported
// the migration from settings-store keep working without a path
// change; the implementation lives in `./migrate-model-settings`
// (no electron / logger deps) so vitest can exercise it directly.
export { migrateDeprecatedModelIds }

const CURRENT_VERSION = 1

/**
 * REQ-0101 — `language` is now injectable so first-launch defaults can
 * carry the OS-detected UI language.  Callers that only want the static
 * defaults (existing behaviour) pass no argument and get `DEFAULT_LANGUAGE`.
 * The no-saved-language branches in `loadSettings` pass the detected
 * value; every other call site remains a no-op.
 */
function buildDefaults(language?: SupportedLanguage): AppSettings {
  return {
    version: 1,
    language: language ?? DEFAULT_LANGUAGE,
    // REQ-20260615-026: app-wide theme defaults to dark.  When older
    // settings.json files (pre-026) hydrate they fall through this default
    // via the spread on load.
    theme: 'dark',
    // REQ-20260615-029: base neutral palette defaults to 'neutral'.
    baseColor: 'neutral',
    transcriptionDefaults: {
      fontSizePx: BURNIN_DEFAULTS.fontSizePx,
      textColorHex: BURNIN_DEFAULTS.textColorHex,
      outlineColorHex: BURNIN_DEFAULTS.outlineColorHex,
      outlineThicknessPx: BURNIN_DEFAULTS.outlineThicknessPx,
      whisperModel: BURNIN_DEFAULTS.whisperModel
    },
    transcriptionAdvanced: { ...TRANSCRIPTION_DEFAULTS },
    autoLineBreak: true,
    burnin: {
      horizontalPosition: BURNIN_DEFAULTS.horizontalPosition,
      verticalPosition: BURNIN_DEFAULTS.verticalPosition,
      verticalMarginPx: BURNIN_DEFAULTS.verticalMarginPx
    },
    encoder: BURNIN_DEFAULTS.encoder,
    audioMode: BURNIN_DEFAULTS.audioMode,
    defaultAudioTrackIndex: BURNIN_DEFAULTS.defaultAudioTrackIndex,
    fadeDurationSec: BURNIN_DEFAULTS.fadeDurationSec,
    subtitleBackground: { ...BURNIN_DEFAULTS.subtitleBackground },
    activeModelId: null,
    lastInputDir: null,
    lastOutputDir: null,
    // REQ-0121 — user-preferred fixed default folders (Settings > General).
    // `null` = fall back to the OS Videos folder in the dialog handler.
    defaultInputDir: null,
    defaultOutputDir: null,
    // REQ-0194 — same shape as the REQ-0121 input/output folder defaults;
    // `null` = OS Videos fallback in the dialog handler.
    defaultProjectDir: null,
    // REQ-0518 — unset is `null` for all six folder rows; the OS fallback is
    // applied at dialog-open (`main/ipc/dialog.ts`), never written here, so a
    // user who has chosen a folder keeps it when a default changes.
    defaultImageDir: null,
    defaultTextDir: null,
    defaultSrtDir: null,
    // REQ-0150 — default the accelerator to CPU.  Every fresh install
    // and every settings.json older than v1.3.3 lands on CPU which
    // matches the pre-REQ-0150 behaviour (no GPU tools bundled = no
    // GPU env var injected).  Users opt in via the 2-card picker
    // after downloading the GPU tools.
    activeAccelerator: 'cpu'
  }
}

export async function loadSettings(): Promise<AppSettings> {
  const settingsPath = getSettingsPath()
  // REQ-0101 — the "no saved language" branches (file missing, version
  // reset, or a settings.json that predates the language field) use this
  // to seed the initial UI language from the OS.  Reading here (not per
  // branch) keeps the ordering simple and the call is cheap.
  const osLanguage = detectOsLanguage()
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as AppSettings
    if (parsed.version !== CURRENT_VERSION) {
      log.warn('[settings] version mismatch, resetting to defaults')
      return buildDefaults(osLanguage)
    }
    const hydrated = { ...buildDefaults(osLanguage), ...parsed }
    // REQ-20260615-065 S-4 — migrate deprecated model IDs.  Pure
    // function; returns the same reference when nothing changed,
    // a new object when at least one field migrated.
    const migrated = migrateDeprecatedModelIds(hydrated)
    if (migrated !== hydrated) {
      log.info(
        `[settings] REQ-065 S-4 migrated model selection: ` +
        `activeModelId ${hydrated.activeModelId} -> ${migrated.activeModelId}, ` +
        `whisperModel ${hydrated.transcriptionDefaults.whisperModel} -> ${migrated.transcriptionDefaults.whisperModel}`
      )
      // Best-effort persist so the migration log line does not fire on
      // every subsequent launch.  A write failure is non-fatal — the
      // migrated value is still returned in memory.
      //
      // REQ-0319 §1 — deliberately NOT wrapped in `mutateSettings`.  This runs
      // INSIDE `loadSettings`, which `mutateSettings` itself calls, so wrapping
      // it would re-enter the chain and deadlock.  It is nonetheless covered
      // whenever it is reached through `mutateSettings` (the common case: every
      // handler now loads via the lock).  A bare `loadSettings` on a read-only
      // path can still race, but the write is idempotent — it persists the same
      // migrated value every time — so a lost update here costs one extra log
      // line on the next launch, not data.
      try {
        await saveSettings(migrated)
      } catch (writeErr) {
        log.warn('[settings] REQ-065 S-4 migrated settings could not be persisted', writeErr)
      }
    }
    return migrated
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return buildDefaults(osLanguage)
    }
    // Corrupt file — move it and return defaults
    log.error('[settings] corrupt settings.json, resetting', err)
    await recoverCorruptFile(settingsPath)
    throw new SettingsCorruptError('settings.json was corrupt; reset to defaults')
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const settingsPath = getSettingsPath()
  await fs.mkdir(dirname(settingsPath), { recursive: true })
  await fs.mkdir(getModelsDir(), { recursive: true })
  await fs.mkdir(getAppDataPath(), { recursive: true })
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8')
}

async function recoverCorruptFile(settingsPath: string): Promise<void> {
  try {
    const backupPath = join(
      dirname(settingsPath),
      `settings.corrupt.${Date.now()}.json`
    )
    await fs.rename(settingsPath, backupPath)
  } catch {
    // ignore rename failure
  }
}

/**
 * REQ-0319 §1 — serialised read-modify-write for settings.json.
 *
 * Every settings write in main is a `loadSettings -> mutate -> saveSettings`
 * cycle, and `saveSettings` is a bare `fs.writeFile` with no locking.  The nine
 * call sites are independent async IPC handlers, so two of them can interleave
 * on the event loop:
 *
 *     A load -> B load -> A save -> B save      (A's write is lost)
 *
 * Reachable in practice, not theoretically: startup `migrateDeprecatedModelIds`
 * racing the hydrate-triggered debounced save; `recordSetVersion` at the end of
 * a bulk font download racing a settings change made during it; `setActiveModel`
 * racing a save.  This is a lost update inside main, independent of whether the
 * renderer's store is stale (that was a separate class of bug — REQ-0315 §3/§4).
 *
 * Locking `saveSettings` alone would NOT fix it: the read sits outside the lock,
 * so both callers would still start from the same stale snapshot.  The whole
 * cycle has to be inside.
 *
 * Chaining rather than a mutex flag keeps it simple and starvation-free: each
 * call queues behind the previous one, in call order.  A rejected link must not
 * poison the chain, so the tail swallows both outcomes while the caller still
 * sees the original rejection.
 */
export interface SettingsMutation<T> {
  /** The exact object to persist.  May be `current` mutated in place, or a
   *  replacement (the merge path rebuilds the object and drops session keys). */
  save: AppSettings
  /** Whatever the caller wants back out of the critical section. */
  value: T
}

let settingsWriteChain: Promise<unknown> = Promise.resolve()

export function mutateSettings<T>(
  mutate: (current: AppSettings) => SettingsMutation<T> | Promise<SettingsMutation<T>>,
): Promise<T> {
  const run = settingsWriteChain.then(async () => {
    const current = await loadSettings()
    const { save, value } = await mutate(current)
    await saveSettings(save)
    return value
  })
  // Keep the queue alive regardless of this link's outcome; the caller still
  // gets the real rejection from `run`.
  settingsWriteChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
