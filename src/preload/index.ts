import { contextBridge, ipcRenderer } from 'electron'
import { Channels } from '../shared/ipc-channels'
import type { VideoInfo, AppSettings, SettingsLoadResult, WhisperModelId, ModelsState } from '../shared/types'
import type { FontsState, FontId } from '../shared/fonts'
import type { GpuToolState } from '../shared/gpu-tool'
import type { TranslationToolId, TranslationToolsState } from '../shared/translation-tools'
import type { TranslateResult } from '../shared/translation'
import type { McpLaunchSpec, McpExportResult } from '../shared/mcp'
import type { TranscriptionStartRequest, BurninStartRequest, ModelCheckResult, BuildInfo, EncoderDetectionResult, ExportFrameRequest, ExportFrameResult, ActiveDownloadInfo } from '../shared/ipc-contracts'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }
type IpcResult<T> = OkResult<T> | ErrResult

const electronAPI = {
  // App
  getVersion: (): Promise<string> => ipcRenderer.invoke(Channels.appGetVersion),
  getResourcesPath: (): Promise<string> => ipcRenderer.invoke(Channels.appGetResourcesPath),
  getBuildInfo: (): Promise<BuildInfo> => ipcRenderer.invoke(Channels.appGetBuildInfo),
  detectEncoders: (): Promise<EncoderDetectionResult> => ipcRenderer.invoke(Channels.appDetectEncoders),
  /** REQ-088 — true for MSIX/AppX (store) builds, false for NSIS. */
  isMsix: (): Promise<boolean> => ipcRenderer.invoke(Channels.appIsMsix),
  /** REQ-0449 §4 — absolute path of the CLI executable (MOJIOKO.exe). */
  getCliPath: (): Promise<string> => ipcRenderer.invoke(Channels.appGetCliPath),
  /** REQ-0452 — the dev/packaged-correct MCP launch spec (command/args). */
  getMcpLaunchSpec: (): Promise<McpLaunchSpec> => ipcRenderer.invoke(Channels.appGetMcpLaunchSpec),
  /** REQ-0451/0452 — write a .mcpb bundle to `targetPath`; resolves an export result. */
  exportMcpBundle: (targetPath: string): Promise<McpExportResult> =>
    ipcRenderer.invoke(Channels.appExportMcpBundle, targetPath),
  /**
   * REQ-0258 — read the MOJIOKO EULA text for the current UI language.
   * Rejects with `EULA_NOT_FOUND` if the extraResources bundling is
   * missing (dev / broken package).
   */
  readEula: (lang: 'ja' | 'en'): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(Channels.appReadEula, lang),
  menuSetLanguage: (lang: string): void => ipcRenderer.send(Channels.menuSetLanguage, lang),
  menuSetTranscribing: (val: boolean): void => ipcRenderer.send(Channels.menuSetTranscribing, val),

  // Dialog
  openVideoDialog: (defaultDir?: string): Promise<string | null> =>
    ipcRenderer.invoke(Channels.dialogOpenVideo, defaultDir),
  saveFileDialog: (
    defaultName: string,
    defaultDir?: string,
    filters?: { name: string; extensions: string[] }[],
    // REQ-0518 — the OS folder to fall back to when `defaultDir` is unset or
    // gone.  The save dialog serves every "produce a file" flow, so the
    // fallback belongs to the CALLER's row, not to the handler.
    fallbackOsFolder?: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke(Channels.dialogSaveFile, defaultName, defaultDir, filters, fallbackOsFolder),
  // REQ-0121 — folder picker used by Settings > General.
  openDirectoryDialog: (defaultDir?: string, fallbackOsFolder?: string): Promise<string | null> =>
    ipcRenderer.invoke(Channels.dialogOpenDir, defaultDir, fallbackOsFolder),
  // REQ-0194 — .mojioko project file open dialog.
  openProjectDialog: (defaultDir?: string): Promise<string | null> =>
    ipcRenderer.invoke(Channels.dialogOpenProject, defaultDir),
  // REQ-0223 — .srt file open dialog for the step2 import flow.
  openSrtDialog: (defaultDir?: string): Promise<string | null> =>
    ipcRenderer.invoke(Channels.dialogOpenSrt, defaultDir),

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

  // Translation tools (REQ-0405 — Phase 1: list / download / uninstall / setActive)
  translationToolList: (): Promise<IpcResult<TranslationToolsState>> =>
    ipcRenderer.invoke(Channels.translationToolList),
  translationToolDownload: (toolId: TranslationToolId): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.translationToolDownload, toolId),
  translationToolDownloadCancel: (channelId: string): Promise<void> =>
    ipcRenderer.invoke(`${Channels.translationToolDownload}:cancel`, channelId),
  translationToolUninstall: (toolId: TranslationToolId): Promise<IpcResult<TranslationToolsState>> =>
    ipcRenderer.invoke(Channels.translationToolUninstall, toolId),
  translationToolSetActive: (toolId: TranslationToolId | null): Promise<IpcResult<TranslationToolsState>> =>
    ipcRenderer.invoke(Channels.translationToolSetActive, toolId),
  // REQ-0410 — one-shot translate for the inspector auto-translate prototype.
  translationTranslate: (text: string, target: string): Promise<IpcResult<TranslateResult>> =>
    ipcRenderer.invoke(Channels.translationTranslate, text, target),
  translationTranslateBatch: (
    texts: string[],
    target: string,
  ): Promise<IpcResult<{ texts: string[]; loadMs: number; translateMs: number }>> =>
    ipcRenderer.invoke(Channels.translationTranslateBatch, texts, target),
  translationPreload: (): Promise<IpcResult<{ loadMs: number }>> =>
    ipcRenderer.invoke(Channels.translationPreload),

  // Fonts
  fontList: (): Promise<IpcResult<FontsState>> =>
    ipcRenderer.invoke(Channels.fontList),
  fontDownload: (fontId: FontId): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.fontDownload, fontId),
  fontDownloadCancel: (channelId: string): Promise<void> =>
    ipcRenderer.invoke(`${Channels.fontDownload}:cancel`, channelId),
  fontUninstall: (fontId: FontId): Promise<IpcResult<FontsState>> =>
    ipcRenderer.invoke(Channels.fontUninstall, fontId),
  // REQ-0281 §4 — batch DL cancel cleanup + "Uninstall all" button.
  fontUninstallAll: (): Promise<IpcResult<FontsState & { removedIds: FontId[] }>> =>
    ipcRenderer.invoke(Channels.fontUninstallAll),
  fontSetActive: (fontId: FontId): Promise<IpcResult<FontsState>> =>
    ipcRenderer.invoke(Channels.fontSetActive, fontId),
  fontReadOfl: (fontId: FontId): Promise<IpcResult<string>> =>
    ipcRenderer.invoke(Channels.fontReadOfl, fontId),
  fontReadBytes: (fontId: FontId): Promise<IpcResult<ArrayBuffer>> =>
    ipcRenderer.invoke(Channels.fontReadBytes, fontId),
  // REQ-0275 §3 — persist current FONT_SET_VERSION after bulk DL success.
  fontRecordSetVersion: (): Promise<IpcResult<{ version: number }>> =>
    ipcRenderer.invoke(`${Channels.fontList}:recordSetVersion`),

  // GPU acceleration tools (REQ-0149)
  gpuToolState: (): Promise<IpcResult<GpuToolState>> =>
    ipcRenderer.invoke(Channels.gpuToolState),
  gpuToolDownload: (): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.gpuToolDownload),
  gpuToolDownloadCancel: (channelId: string): Promise<void> =>
    ipcRenderer.invoke(`${Channels.gpuToolDownload}:cancel`, channelId),
  gpuToolDelete: (): Promise<IpcResult<GpuToolState>> =>
    ipcRenderer.invoke(Channels.gpuToolDelete),
  gpuToolSelect: (choice: 'cpu' | 'gpu'): Promise<IpcResult<GpuToolState>> =>
    ipcRenderer.invoke(Channels.gpuToolSelect, choice),

  // REQ-0245 — hydrate the renderer's mirror of main's active-DL
  // slot array on boot / after component remounts.  Live updates
  // arrive on `Channels.downloadActiveChanged` via subscribeToChannel.
  downloadActiveGet: (): Promise<IpcResult<ActiveDownloadInfo[]>> =>
    ipcRenderer.invoke(Channels.downloadActiveGet),

  // Burnin
  burninStart: (opts: BurninStartRequest): Promise<IpcResult<{ channelId: string }>> =>
    ipcRenderer.invoke(Channels.burninStart, opts),
  burninCancel: (channelId: string): Promise<void> =>
    ipcRenderer.invoke(Channels.burninCancel, channelId),

  // Settings
  settingsLoad: (): Promise<IpcResult<SettingsLoadResult>> =>
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
  shellOpenTranslationToolsFolder: (): Promise<void> =>
    ipcRenderer.invoke(Channels.shellOpenTranslationToolsFolder),
  shellOpenThirdPartyLicensesFolder: (): Promise<void> =>
    ipcRenderer.invoke(Channels.shellOpenThirdPartyLicensesFolder),
  shellWriteTextFile: (filePath: string, content: string): Promise<void> =>
    ipcRenderer.invoke(Channels.shellWriteTextFile, filePath, content),
  shellFileExists: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke(Channels.shellFileExists, filePath),
  // REQ-0194 — read `.mojioko` project files back as UTF-8 strings.
  shellReadTextFile: (filePath: string): Promise<string> =>
    ipcRenderer.invoke(Channels.shellReadTextFile, filePath),

  // REQ-0546 — the renderer's answer to a close request: 'discard' lets the
  // quit proceed, 'cancel' keeps the app open.
  sendCloseDecision: (decision: 'discard' | 'cancel'): Promise<void> =>
    ipcRenderer.invoke(Channels.appCloseDecision, decision),

  // Streaming event subscriptions
  subscribeToChannel: (channelId: string, cb: (payload: unknown) => void): (() => void) => {
    const handler = (_: Electron.IpcRendererEvent, payload: unknown) => cb(payload)
    ipcRenderer.on(channelId, handler)
    return () => ipcRenderer.removeListener(channelId, handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
