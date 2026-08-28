/**
 * REQ-0518 — the ONE table describing the Settings ▸ 一般 folder rows.
 *
 * ## What it ties together
 *
 * Each row is three facts that must never drift apart:
 *
 *   1. the persisted settings key,
 *   2. the OS folder a dialog falls back to when the user has not set one,
 *   3. the i18n key for the label and the placeholder.
 *
 * Before this, (2) did not exist per-row at all: `resolveDialogDir` in
 * `main/ipc/dialog.ts` fell back to `app.getPath('videos')` for EVERY dialog,
 * so a project save, an image export and an SRT import all landed in Videos
 * whatever the row's placeholder claimed.  Adding three more rows by hand
 * would have meant repeating the mapping in the dialog, the settings screen,
 * and every caller — which is the shape this codebase keeps paying for.
 *
 * ## ★ The persisted keys are NOT renamed (REQ-0518 §1-1)
 *
 * `defaultInputDir` / `defaultOutputDir` / `defaultProjectDir` keep their
 * names even though the LABELS change to 動画入力/動画出力/プロジェクト保存.
 * Renaming a settings key silently discards whatever the user had chosen, and
 * the only thing this REQ asked to change is what the row is called.
 */

/** The OS folders a dialog may fall back to. */
export type OsFolder = 'videos' | 'documents' | 'pictures'

/** A row in Settings ▸ 一般 ▸ フォルダ. */
export interface FolderSetting {
  /** Persisted key on `AppSettings`.  NEVER renamed — see the docblock. */
  readonly key: FolderSettingKey
  /** Where a dialog goes when the user has set nothing, or the folder is gone. */
  readonly osFolder: OsFolder
  /** i18n suffix under `settings:general.folders.*` for label + placeholder. */
  readonly i18n: string
}

export type FolderPurpose =
  | 'videoInput'
  | 'videoOutput'
  | 'project'
  | 'image'
  | 'text'
  | 'srtInput'

export type FolderSettingKey =
  | 'defaultInputDir'
  | 'defaultOutputDir'
  | 'defaultProjectDir'
  | 'defaultImageDir'
  | 'defaultTextDir'
  | 'defaultSrtDir'

/**
 * The rows, in the order the settings screen shows them.
 *
 * `-?` mapped so a new `FolderPurpose` fails `tsc` here until it is given a
 * key, a fallback and a label — the same construction `ANIMATION_TYPE_DEFAULTS`
 * and `PRESET_CLAMP_RULES` use.
 */
export const FOLDER_SETTINGS: { readonly [K in FolderPurpose]-?: FolderSetting } = {
  videoInput: { key: 'defaultInputDir', osFolder: 'videos', i18n: 'videoInput' },
  videoOutput: { key: 'defaultOutputDir', osFolder: 'videos', i18n: 'videoOutput' },
  // ★ REQ-0518 — the project default moves Videos → Documents.  It is a
  // FALLBACK only: a user who has picked a folder keeps it, because the
  // fallback is consulted solely when the stored value is null/missing (unset
  // is `null`, written by `settings-store.ts`, and every reader does
  // `?? undefined`).
  project: { key: 'defaultProjectDir', osFolder: 'documents', i18n: 'project' },
  image: { key: 'defaultImageDir', osFolder: 'pictures', i18n: 'image' },
  text: { key: 'defaultTextDir', osFolder: 'documents', i18n: 'text' },
  srtInput: { key: 'defaultSrtDir', osFolder: 'documents', i18n: 'srtInput' },
}

/** The rows in display order — the settings screen renders exactly this. */
export const FOLDER_PURPOSE_ORDER: readonly FolderPurpose[] = [
  'videoInput',
  'videoOutput',
  'project',
  'image',
  'text',
  'srtInput',
]

/**
 * REQ-0518 §1-3 — pick the folder a dialog opens in.
 *
 * The whole "does changing a default eat an existing setting?" question lives
 * here, in four lines with no Electron in sight, so it can be tested for real:
 *
 *   - a folder the user CHOSE and which still exists → that folder.  Changing
 *     a default can never override it, because the fallback is not consulted.
 *   - a folder the user chose that has since vanished (USB, network share) →
 *     the OS fallback, silently.  REQ-0121 decided not to toast, and not to
 *     clear the stored value, so re-attaching the drive restores the setting.
 *   - unset (`null`, which is what `settings-store.ts` writes and what every
 *     reader turns into `undefined`) → the OS fallback.
 *
 * `exists` is injected so the caller supplies `fs.existsSync`; this module
 * stays importable from the renderer and from tests.
 */
export function chooseDialogDir(
  preferred: string | null | undefined,
  osFolderPath: string,
  exists: (p: string) => boolean,
): string {
  if (preferred && exists(preferred)) return preferred
  return osFolderPath
}
