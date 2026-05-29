import { ipcMain, dialog, BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { app } from 'electron'
import { join } from 'path'

export function registerDialogHandlers(): void {
  ipcMain.handle(Channels.dialogOpenVideo, async (event, defaultDir?: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const defaultPath = defaultDir ?? join(app.getPath('videos'))
    const result = await dialog.showOpenDialog(win ?? BrowserWindow.getFocusedWindow()!, {
      title: 'Open Video',
      defaultPath,
      filters: [
        { name: 'Video files', extensions: ['mkv', 'mp4', 'mov', 'avi'] },
        { name: 'All files', extensions: ['*'] }
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
