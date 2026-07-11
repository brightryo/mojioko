import { ipcMain, dialog, BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * REQ-0121 — lazy existence check for user-preferred default folders.
 * The Settings > General folder paths are NOT validated at load time (a
 * USB / network drive that is temporarily disconnected should not clobber
 * the setting).  Instead we validate at dialog-open and silently fall
 * back to the OS Videos folder when the folder has vanished — no toast,
 * per REQ-0121 §触らない/注意.
 */
function resolveDialogDir(preferred: string | undefined): string {
  if (preferred && existsSync(preferred)) return preferred
  return app.getPath('videos')
}

export function registerDialogHandlers(): void {
  ipcMain.handle(Channels.dialogOpenVideo, async (event, defaultDir?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = resolveDialogDir(defaultDir)
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
      filters: [
        { name: 'Media files', extensions: ['mp4', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
        { name: 'Video',       extensions: ['mp4', 'mkv'] },
        { name: 'Audio',       extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
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
      filters?: Electron.FileFilter[]
    ): Promise<string | null> => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const defaultPath = join(resolveDialogDir(defaultDir), defaultName)
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
  ipcMain.handle(Channels.dialogOpenDir, async (event, defaultDir?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = resolveDialogDir(defaultDir)
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
    const defaultPath = resolveDialogDir(defaultDir)
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
}
