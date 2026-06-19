import { contextBridge, ipcRenderer } from 'electron'
import { Channels } from '../shared/ipc-channels'
import type { VideoInfo, AppSettings, WhisperModelId, ModelsState } from '../shared/types'
import type { FontsState, FontId } from '../shared/fonts'
import type { TranscriptionStartRequest, BurninStartRequest, ModelCheckResult, BuildInfo, EncoderDetectionResult, ExportFrameRequest, ExportFrameResult } from '../shared/ipc-contracts'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }
type IpcResult<T> = OkResult<T> | ErrResult

const electronAPI = {
  // App
  getVersion: (): Promise<string> => ipcRenderer.invoke(Channels.appGetVersion),
  getResourcesPath: (): Promise<string> => ipcRenderer.invoke(Channels.appGetResourcesPath),
  getBuildInfo: (): Promise<BuildInfo> => ipcRenderer.invoke(Channels.appGetBuildInfo),
  detectEncoders: (): Promise<EncoderDetectionResult> => ipcRenderer.invoke(Channels.appDetectEncoders),
  menuSetLanguage: (lang: string): void => ipcRenderer.send(Channels.menuSetLanguage, lang),
  menuSetTranscribing: (val: boolean): void => ipcRenderer.send(Channels.menuSetTranscribing, val),

  // Dialog
  openVideoDialog: (defaultDir?: string): Promise<string | null> =>
    ipcRenderer.invoke(Channels.dialogOpenVideo, defaultDir),
  saveFileDialog: (
    defaultName: string,
    defaultDir?: string,
    filters?: { name: string; extensions: string[] }[]
  ): Promise<string | null> =>
    ipcRenderer.invoke(Channels.dialogSaveFile, defaultName, defaultDir, filters),

  // Video
  videoProbe: (path: string): Promise<IpcResult<VideoInfo>> =>
    ipcRenderer.invoke(Channels.videoProbe, path),
  videoExtractThumbnail: (path: string, atSec: number): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(Channels.videoExtractThumbnail, path, atSec),
  videoExtractFrameForPreview: (path: string, atSec: number): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(Channels.videoExtractFrameForPreview, path, atSec),
  videoExportFrame: (req: ExportFrameRequest): Promise<IpcResult<ExportFrameResult>> =>
    ipcRenderer.invoke(Channels.videoExportFrame, req),

  // Transcription
  transcriptionCheckModel: (modelId: string): Promise<IpcResult<ModelCheckResult>> =>
    ipcRenderer.invoke(Channels.transcriptionCheckModel, modelId),
  transcriptionStart: (opts: TranscriptionStartRequest): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.transcriptionStart, opts),
  transcriptionCancel: (): Promise<void> =>
    ipcRenderer.invoke(Channels.transcriptionCancel),
  transcriptionDownloadModel: (modelId: string): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.transcriptionDownloadModel, modelId),
  transcriptionDownloadModelCancel: (channelId: string): Promise<void> =>
    ipcRenderer.invoke(`${Channels.transcriptionDownloadModel}:cancel`, channelId),
  transcriptionListModels: (): Promise<IpcResult<ModelsState>> =>
    ipcRenderer.invoke(Channels.transcriptionListModels),
  transcriptionUninstallModel: (modelId: WhisperModelId): Promise<IpcResult<ModelsState>> =>
    ipcRenderer.invoke(Channels.transcriptionUninstallModel, modelId),
  transcriptionSetActiveModel: (modelId: WhisperModelId): Promise<IpcResult<ModelsState>> =>
    ipcRenderer.invoke(Channels.transcriptionSetActiveModel, modelId),

  // Fonts
  fontList: (): Promise<IpcResult<FontsState>> =>
    ipcRenderer.invoke(Channels.fontList),
  fontDownload: (fontId: FontId): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.fontDownload, fontId),
  fontDownloadCancel: (channelId: string): Promise<void> =>
    ipcRenderer.invoke(`${Channels.fontDownload}:cancel`, channelId),
  fontUninstall: (fontId: FontId): Promise<IpcResult<FontsState>> =>
    ipcRenderer.invoke(Channels.fontUninstall, fontId),
  fontSetActive: (fontId: FontId): Promise<IpcResult<FontsState>> =>
    ipcRenderer.invoke(Channels.fontSetActive, fontId),
  fontReadOfl: (fontId: FontId): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(Channels.fontReadOfl, fontId),
  fontReadBytes: (fontId: FontId): Promise<IpcResult<ArrayBuffer>> =>
    ipcRenderer.invoke(Channels.fontReadBytes, fontId),

  // Burnin
  burninStart: (opts: BurninStartRequest): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.burninStart, opts),
  burninCancel: (channelId: string): Promise<void> =>
    ipcRenderer.invoke(Channels.burninCancel, channelId),

  // Settings
  settingsLoad: (): Promise<IpcResult<AppSettings>> =>
    ipcRenderer.invoke(Channels.settingsLoad),
  settingsSave: (settings: AppSettings): Promise<IpcResult<null>> =>
    ipcRenderer.invoke(Channels.settingsSave, settings),

  // Shell
  shellOpenPath: (path: string): Promise<void> =>
    ipcRenderer.invoke(Channels.shellOpenPath, path),
  shellShowInFolder: (path: string): Promise<void> =>
    ipcRenderer.invoke(Channels.shellShowInFolder, path),
  shellOpenExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(Channels.shellOpenExternal, url),
  shellOpenModelsFolder: (): Promise<void> =>
    ipcRenderer.invoke(Channels.shellOpenModelsFolder),
  shellOpenThirdPartyLicensesFolder: (): Promise<void> =>
    ipcRenderer.invoke(Channels.shellOpenThirdPartyLicensesFolder),
  shellWriteTextFile: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke(Channels.shellWriteTextFile, filePath, content),
  shellFileExists: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(Channels.shellFileExists, filePath),

  // Streaming event subscriptions
  subscribeToChannel: (channelId: string, cb: (payload: unknown) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channelId, handler)
    return () => ipcRenderer.removeListener(channelId, handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
