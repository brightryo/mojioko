import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { getSettingsPath, getAppDataPath } from '../lib/paths'
import { getModelsDir } from '../lib/paths'
import { BURNIN_DEFAULTS } from '../../shared/burnin-defaults'
import { DEFAULT_LANGUAGE, type SupportedLanguage } from '../../shared/app-info'
import { TRANSCRIPTION_DEFAULTS } from '../../shared/constants'
import { migrateDeprecatedModelIds } from './migrate-model-settings'
import type { AppSettings } from '../../shared/types'
import {
  classifySettingsFile,
  type SettingsQuarantineNotice,
  type SettingsQuarantineReason,
} from '../ipc/settings-shape'
import { detectOsLanguage } from '../lib/os-language'
import log from '../lib/logger'
import { writeFileAtomic } from '../lib/atomic-write'

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

/**
 * REQ-0542 — the one notice this launch has to deliver, or null.
 *
 * Module-level because `loadSettings` runs many times per launch (every
 * `mutateSettings` starts with one) while the user must be told once. It is
 * SET by the quarantine path and CLEARED by whoever takes it, so the second
 * reader gets nothing.
 *
 * Headless (CLI / MCP) simply never takes it: there is no window to show a
 * dialog in, the quarantine and its `log.warn` still happen, and the exit code
 * is untouched — a settings file we could not read is not a reason to fail a
 * burn that does not depend on it.
 */
let pendingQuarantineNotice: SettingsQuarantineNotice | null = null

/** Read the startup notice and clear it, so it is shown exactly once. */
export function takeSettingsQuarantineNotice(): SettingsQuarantineNotice | null {
  const notice = pendingQuarantineNotice
  pendingQuarantineNotice = null
  return notice
}

/** Test seam: forget any pending notice (each test starts from silence). */
export function __resetSettingsQuarantineNoticeForTests(): void {
  pendingQuarantineNotice = null
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
    // REQ-0542 — is this file even ours?  A previous iteration of MOJIOKO uses
    // the same %APPDATA% folder and writes its own format WITH `version: 1`, so
    // the version check below cannot tell the difference.  Move it aside rather
    // than spreading its keys over the defaults and starting up looking like a
    // fresh install — that is what made RES-0540 §5 invisible for a whole day.
    const shape = classifySettingsFile(parsed)
    if (shape.shape === 'foreign') {
      log.warn(
        `[settings] settings.json is not in this app's format ` +
        `(known keys ${shape.knownKeys}, unknown ${shape.unknownKeys}` +
        `${shape.sampleUnknown.length ? `: ${shape.sampleUnknown.join(', ')}` : ''}). ` +
        `Quarantining it and starting from defaults.`,
      )
      await quarantineSettingsFile(settingsPath, 'foreign-format')
      return buildDefaults(osLanguage)
    }
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
    // Unreadable file — move it aside and start from defaults.
    //
    // REQ-0542: this used to THROW `SettingsCorruptError`, which made
    // `settings:load` reply `ok: false`; App.tsx returns early on that, so the
    // user was told nothing and the app ran on the renderer store's built-in
    // defaults.  Nothing ever consumed the error — no branch, no test — so the
    // two unusable-file cases now behave identically: quarantine, defaults, and
    // one notice.  One behaviour, one code path.
    log.error('[settings] settings.json could not be read, resetting', err)
    await quarantineSettingsFile(settingsPath, 'unreadable')
    return buildDefaults(osLanguage)
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const settingsPath = getSettingsPath()
  await fs.mkdir(dirname(settingsPath), { recursive: true })
  await fs.mkdir(getModelsDir(), { recursive: true })
  await fs.mkdir(getAppDataPath(), { recursive: true })
  // REQ-0545 §1 — atomic, for the same reason the project file is: a partial
  // write here loses every preference the user has set.
  await writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2))
}

/** `YYYYMMDD-HHMMSS` in local time — the name is for a human reading a folder. */
function quarantineStamp(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
    + `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/**
 * REQ-0542 — move the unusable file aside and remember to tell the user.
 *
 * RENAME, never delete or overwrite: the file is the only copy of settings we
 * could not read, and it may be the only copy of something the user cares
 * about. A timestamped name means a second occurrence does not clobber the
 * first — and if the other program keeps rewriting the file, one quarantine per
 * launch is the intended (and honest) outcome.
 *
 * The notice is set only when the rename SUCCEEDS. Telling the user "we moved
 * it to X" when nothing was moved would send them looking for a file that is
 * not there.
 */
async function quarantineSettingsFile(
  settingsPath: string,
  reason: SettingsQuarantineReason,
): Promise<void> {
  const quarantinedPath = join(
    dirname(settingsPath),
    `settings.json.quarantined-${quarantineStamp(new Date())}`,
  )
  try {
    await fs.rename(settingsPath, quarantinedPath)
  } catch (err) {
    // A concurrent load may already have moved it; either way there is nothing
    // left to quarantine and nothing truthful to report.
    log.warn('[settings] could not quarantine settings.json', err)
    return
  }
  log.warn(`[settings] moved to ${quarantinedPath} (${reason})`)
  pendingQuarantineNotice = { reason, quarantinedPath }
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
