import { ipcMain, dialog, BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { app } from 'electron'
import { join } from 'path'

export function registerDialogHandlers(): void {
  ipcMain.handle(Channels.dialogOpenVideo, async (event, defaultDir?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = defaultDir ?? join(app.getPath('videos'))
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Open Input File',
      defaultPath,
      // REQ-028: audio inputs (mp3 / wav / m4a / aac / flac / ogg) are now
      // first-class.  Media filter lists everything; Video / Audio sub-filters
      // let the user narrow down.  ffprobe still has the final say (extension
      // is UX only — the mode decision happens by content inspection).
      filters: [
        { name: 'Media files', extensions: ['mp4', 'mkv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] },
        { name: 'Video',       extensions: ['mp4', 'mkv', 'mov', 'avi'] },
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
      const defaultPath = defaultDir
        ? join(defaultDir, defaultName)
        : join(app.getPath('videos'), defaultName)
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
}
