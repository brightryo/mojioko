/**
 * REQ-0194 — high-level project save / load helpers.
 *
 * These wrap the low-level IPC surface (`dialog.ts` re-exports) with
 * store access and the toast/i18n bridge so App.tsx's menu subscribers
 * stay small.  All UI decisions (toasts, confirm dialogs) live one level
 * up in the callers — this module only handles I/O + serialisation.
 */

import { APP_VERSION } from '../../shared/app-info'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import {
  buildProjectFile,
  serializeProjectFile,
  parseProjectFile,
  type ProjectFile,
  type ParseResult,
} from '../../shared/project-file'
import {
  saveFileDialog,
  writeTextFile,
  openProjectDialog,
  readTextFile,
} from './dialog'
import { getGpuToolState } from './gpu-tool'

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export type SaveResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'no-project' | 'cancelled' | 'io-error'; message?: string }

/**
 * Prompt the user with a save dialog and write the current project state
 * to a `.mojioko` file.  Returns a discriminated result the caller can
 * surface via toast.
 *
 * The saved snapshot is taken **at call time** via `useXxxStore.getState()`
 * so a re-render mid-save cannot smuggle a different entry set into the
 * file — the file always reflects what was on screen when the user hit
 * Save.
 */
export async function saveCurrentProject(): Promise<SaveResult> {
  const proj = useProjectStore.getState()
  const settings = useSettingsStore.getState()

  if (!proj.video || proj.videoLoadingState !== 'loaded') {
    return { ok: false, reason: 'no-project' }
  }

  // Default filename — video's basename with the input extension swapped for
  // `.mojioko`.  Falls back to a plain "project" if the video has no
  // extension (unlikely, but keeps the dialog seeded).
  const videoBase = proj.video.path.split(/[\\/]/).pop() ?? 'project'
  const stem = videoBase.replace(/\.[^.]+$/, '') || 'project'
  const defaultName = `${stem}.mojioko`

  const targetPath = await saveFileDialog(
    defaultName,
    settings.defaultProjectDir ?? undefined,
    [{ name: 'MOJIOKO Project', extensions: ['mojioko'] }],
  )
  if (!targetPath) {
    return { ok: false, reason: 'cancelled' }
  }

  // `activeAccelerator` is main-managed state; the renderer settings-store
  // doesn't hold it (fetched via `gpuToolState` IPC).  Ignore fetch
  // failures — 'cpu' is the safe informational fallback for the file.
  const gpu = await getGpuToolState().catch(() => null)
  const device: 'cpu' | 'gpu' = gpu?.activeAccelerator === 'gpu' ? 'gpu' : 'cpu'

  const pf = buildProjectFile({
    appVersion: APP_VERSION,
    video: proj.video,
    transcribedTrackIndex: proj.selectedTrackIndex,
    entries: proj.entries,
    cuts: proj.cuts,
    defaults: proj.defaults,
    // `transcriptionDefaults.whisperModel` is the model that was active at
    // creation time (and stays as long as the user doesn't change the
    // Whisper picker).  This is the informational field described in the
    // REQ — not restored on open.
    whisperModel: proj.defaults.whisperModel,
    device,
  })
  const content = serializeProjectFile(pf)

  try {
    await writeTextFile(targetPath, content)
  } catch (err) {
    return { ok: false, reason: 'io-error', message: String(err) }
  }
  return { ok: true, path: targetPath }
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

export type LoadFileResult =
  | { ok: true; project: ProjectFile; path: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'parse-failed'; parseReason: Extract<ParseResult, { ok: false }>['reason'] }
  | { ok: false; reason: 'io-error'; message: string }

/**
 * Prompt the user with an open dialog and parse the picked `.mojioko`.
 * The identity check (video path + duration + resolution) and font
 * warning are handled by the caller — this function only produces a
 * validated `ProjectFile`.
 */
export async function pickAndParseProjectFile(): Promise<LoadFileResult> {
  const settings = useSettingsStore.getState()
  const targetPath = await openProjectDialog(settings.defaultProjectDir ?? undefined)
  if (!targetPath) return { ok: false, reason: 'cancelled' }

  let raw: string
  try {
    raw = await readTextFile(targetPath)
  } catch (err) {
    return { ok: false, reason: 'io-error', message: String(err) }
  }

  const parsed = parseProjectFile(raw)
  if (!parsed.ok) {
    return { ok: false, reason: 'parse-failed', parseReason: parsed.reason }
  }
  return { ok: true, project: parsed.project, path: targetPath }
}
