import { ipcMain, dialog, BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import {
  SUPPORTED_MEDIA_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
  SUPPORTED_AUDIO_EXTENSIONS,
} from '../../shared/constants'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { chooseDialogDir, FOLDER_SETTINGS, type OsFolder } from '../../shared/folder-settings'

/**
 * REQ-0121 — lazy existence check for user-preferred default folders.
 * The Settings > General folder paths are NOT validated at load time (a
 * USB / network drive that is temporarily disconnected should not clobber
 * the setting).  Instead we validate at dialog-open and silently fall
 * back to an OS folder when the folder has vanished — no toast,
 * per REQ-0121 §触らない/注意.
 *
 * ★ REQ-0518 §1-4 — the fallback is PER DIALOG now.
 *
 * It used to be `app.getPath('videos')` for every one of the five handlers,
 * so a project save, an image export and an SRT import all opened in Videos
 * no matter what the settings row promised.  The caller now names the OS
 * folder its row falls back to; the mapping lives in
 * `shared/folder-settings.ts` so the settings screen and the dialog cannot
 * disagree about it.
 *
 * `app.getPath` throws for a folder the OS cannot resolve (it is documented
 * to throw when the name has no path), which on a machine with a redirected
 * or missing shell folder would take down the dialog rather than open it
 * somewhere sensible.  So it is guarded, and degrades home → cwd.
 */
function osFolderPath(kind: OsFolder): string {
  try {
    return app.getPath(kind)
  } catch {
    try {
      return app.getPath('home')
    } catch {
      return process.cwd()
    }
  }
}

function resolveDialogDir(preferred: string | undefined, fallback: OsFolder = 'videos'): string {
  // The decision itself is in `shared/folder-settings.ts` so it is testable
  // without Electron — see `chooseDialogDir`.  This function only supplies the
  // two things that need the main process: the resolved OS path and `fs`.
  return chooseDialogDir(preferred, osFolderPath(fallback), existsSync)
}

export function registerDialogHandlers(): void {
  ipcMain.handle(Channels.dialogOpenVideo, async (event, defaultDir?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = resolveDialogDir(defaultDir, 'videos')
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Open Input File',
      defaultPath,
      // REQ-028: audio inputs (mp3 / wav / m4a / aac / flac / ogg) are now
      // first-class.  Media filter lists everything; Video / Audio sub-filters
      // let the user narrow down.  ffprobe still has the final say (extension
      // is UX only — the mode decision happens by content inspection).
      // REQ-030: extension lists must reflect what the backend can
      // actually process.  The Video sub-filter previously included
      // mov / avi as a vestige from an earlier list — those are NOT in
      // ffprobe's read path expectations here so they were misleading
      // users.  Aligned to REQ-028 §2-2's confirmed-safe set: video =
      // mp4 / mkv, audio = mp3 / wav / m4a / aac / flac / ogg.
      // REQ-0423 — extension lists sourced from shared/constants so the
      // drag-&-drop validation in step1 and this picker filter never drift.
      filters: [
        { name: 'Media files', extensions: [...SUPPORTED_MEDIA_EXTENSIONS] },
        { name: 'Video',       extensions: [...SUPPORTED_VIDEO_EXTENSIONS] },
        { name: 'Audio',       extensions: [...SUPPORTED_AUDIO_EXTENSIONS] },
        { name: 'All files',   extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(
    Channels.dialogSaveFile,
    async (
      event,
      defaultName: string,
      defaultDir?: string,
      filters?: Electron.FileFilter[],
      // REQ-0518 §1-4 — the save dialog is the one shared by every "produce a
      // file" flow, so the OS fallback cannot be fixed here: the caller names
      // it from `FOLDER_SETTINGS`.  Defaults to `videos`, which is what every
      // caller got before this REQ.
      fallback: OsFolder = 'videos',
    ): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const defaultPath = join(resolveDialogDir(defaultDir, fallback), defaultName)
      const resolvedFilters: Electron.FileFilter[] = filters ?? [
        { name: 'Video files', extensions: ['mp4', 'mkv'] },
        { name: 'Text files', extensions: ['txt'] },
        { name: 'All files', extensions: ['*'] }
      ]
      const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
        title: 'Save As',
        defaultPath,
        filters: resolvedFilters
      })
      return result.canceled ? null : result.filePath ?? null
    }
  )

  /**
   * REQ-0121 — folder picker for Settings > General.  Same permission
   * surface as the existing `showOpenDialog` calls above; no extra
   * capabilities are granted.
   */
  ipcMain.handle(Channels.dialogOpenDir, async (event, defaultDir?: string, fallback: OsFolder = 'videos'): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    // REQ-0518 — the picker for a settings row opens at that row's own
    // fallback, so "choose a folder" for プロジェクト保存 starts in Documents
    // rather than Videos.
    const defaultPath = resolveDialogDir(defaultDir, fallback)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Select folder',
      defaultPath,
      properties: ['openDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /**
   * REQ-0194 — project file open dialog.  Same permission surface as the
   * other open dialogs; filter narrowed to the `.mojioko` extension.
   */
  ipcMain.handle(Channels.dialogOpenProject, async (event, defaultDir?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = resolveDialogDir(defaultDir, FOLDER_SETTINGS.project.osFolder)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Open Project',
      defaultPath,
      filters: [
        { name: 'MOJIOKO Project', extensions: ['mojioko'] },
        { name: 'All files',       extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /**
   * REQ-0223 — SRT open dialog for the step2 import flow.  Same
   * permission surface / defaultDir resolution as `dialogOpenProject`;
   * only the extension filter differs.
   */
  ipcMain.handle(Channels.dialogOpenSrt, async (event, defaultDir?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = resolveDialogDir(defaultDir, FOLDER_SETTINGS.srtInput.osFolder)
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Import SRT',
      defaultPath,
      filters: [
        { name: 'SRT Subtitle', extensions: ['srt'] },
        { name: 'All files',    extensions: ['*'] },
      ],
      properties: ['openFile'],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
}
