import { promises as fs } from 'fs'
import { join, dirname } from 'path'
import { getSettingsPath, getAppDataPath } from '../lib/paths'
import { getModelsDir } from '../lib/paths'
import { BURNIN_DEFAULTS } from '../../shared/burnin-defaults'
import { DEFAULT_LANGUAGE } from '../../shared/app-info'
import { TRANSCRIPTION_DEFAULTS } from '../../shared/constants'
import { migrateDeprecatedModelIds } from './migrate-model-settings'
import type { AppSettings } from '../../shared/types'
import { SettingsCorruptError } from '../../shared/errors'
import log from '../lib/logger'

// REQ-20260615-065 S-4 — re-export so existing callers that imported
// the migration from settings-store keep working without a path
// change; the implementation lives in `./migrate-model-settings`
// (no electron / logger deps) so vitest can exercise it directly.
export { migrateDeprecatedModelIds }

const CURRENT_VERSION = 1

function buildDefaults(): AppSettings {
  return {
    version: 1,
    language: DEFAULT_LANGUAGE,
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
    defaultOutputDir: null
  }
}

export async function loadSettings(): Promise<AppSettings> {
  const settingsPath = getSettingsPath()
  try {
    const raw = await fs.readFile(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw) as AppSettings
    if (parsed.version !== CURRENT_VERSION) {
      log.warn('[settings] version mismatch, resetting to defaults')
      return buildDefaults()
    }
    const hydrated = { ...buildDefaults(), ...parsed }
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
      try {
        await saveSettings(migrated)
      } catch (writeErr) {
        log.warn('[settings] REQ-065 S-4 migrated settings could not be persisted', writeErr)
      }
    }
    return migrated
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return buildDefaults()
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
