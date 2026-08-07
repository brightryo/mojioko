/// <reference types="vite/client" />

import type { VideoInfo, AppSettings, WhisperModelId, ModelsState } from '../shared/types'
import type { FontsState, FontId } from '../shared/fonts'
import type { GpuToolState } from '../shared/gpu-tool'
import type { TranslationToolId, TranslationToolsState } from '../shared/translation-tools'
import type { TranslateResult } from '../shared/translation'
import type { TranscriptionStartRequest, BurninStartRequest, ModelCheckResult, BuildInfo, EncoderDetectionResult, ExportFrameRequest, ExportFrameResult, ActiveDownloadInfo } from '../shared/ipc-contracts'

type IpcOk<T> = { ok: true; data: T }
type IpcErr = { ok: false; error: { code: string; message: string } }
type IpcResult<T> = IpcOk<T> | IpcErr

declare global {
  interface Window {
    electronAPI: {
      getVersion: () => Promise<string>
      getResourcesPath: () => Promise<string>
      getBuildInfo: () => Promise<BuildInfo>
      detectEncoders: () => Promise<EncoderDetectionResult>
      isMsix: () => Promise<boolean>
      getCliPath: () => Promise<string>
      exportMcpBundle: (targetPath: string) => Promise<string>
      // REQ-0258 — read the MOJIOKO EULA text for the current UI language.
      readEula: (lang: 'ja' | 'en') => Promise<IpcResult<string>>
      menuSetLanguage: (lang: string) => void
      menuSetTranscribing: (val: boolean) => void

      openVideoDialog: (defaultDir?: string) => Promise<string | null>
      saveFileDialog: (
        defaultName: string,
        defaultDir?: string,
        filters?: { name: string; extensions: string[] }[]
      ) => Promise<string | null>
      // REQ-0121 — folder picker used by Settings > General.
      openDirectoryDialog: (defaultDir?: string) => Promise<string | null>
      // REQ-0194 — `.mojioko` project file open dialog.
      openProjectDialog: (defaultDir?: string) => Promise<string | null>
      // REQ-0223 — `.srt` file open dialog for the step2 import flow.
      openSrtDialog: (defaultDir?: string) => Promise<string | null>

      videoProbe: (path: string) => Promise<IpcResult<VideoInfo>>
      videoExtractThumbnail: (path: string, atSec: number) => Promise<IpcResult<string>>
      videoExtractFrameForPreview: (path: string, atSec: number) => Promise<IpcResult<string>>
      videoExportFrame: (req: ExportFrameRequest) => Promise<IpcResult<ExportFrameResult>>

      transcriptionCheckModel: (modelId: string) => Promise<IpcResult<ModelCheckResult>>
      transcriptionStart: (opts: TranscriptionStartRequest) => Promise<IpcResult<{ channelId: string }>>
      transcriptionCancel: () => Promise<void>
      transcriptionDownloadModel: (modelId: string) => Promise<IpcResult<{ channelId: string }>>
      transcriptionDownloadModelCancel: (channelId: string) => Promise<void>
      transcriptionListModels: () => Promise<IpcResult<ModelsState>>
      transcriptionUninstallModel: (modelId: WhisperModelId) => Promise<IpcResult<ModelsState>>
      transcriptionSetActiveModel: (modelId: WhisperModelId) => Promise<IpcResult<ModelsState>>
      translationToolList: () => Promise<IpcResult<TranslationToolsState>>
      translationToolDownload: (toolId: TranslationToolId) => Promise<IpcResult<{ channelId: string }>>
      translationToolDownloadCancel: (channelId: string) => Promise<void>
      translationToolUninstall: (toolId: TranslationToolId) => Promise<IpcResult<TranslationToolsState>>
      translationToolSetActive: (toolId: TranslationToolId | null) => Promise<IpcResult<TranslationToolsState>>
      translationTranslate: (text: string, target: string) => Promise<IpcResult<TranslateResult>>
      translationTranslateBatch: (
        texts: string[],
        target: string,
      ) => Promise<IpcResult<{ texts: string[]; loadMs: number; translateMs: number }>>
      translationPreload: () => Promise<IpcResult<{ loadMs: number }>>

      fontList: () => Promise<IpcResult<FontsState>>
      fontDownload: (fontId: FontId) => Promise<IpcResult<{ channelId: string }>>
      fontDownloadCancel: (channelId: string) => Promise<void>
      fontUninstall: (fontId: FontId) => Promise<IpcResult<FontsState>>
      // REQ-0281 §4 — batch DL cancel cleanup + user-triggered "uninstall all".
      fontUninstallAll: () => Promise<IpcResult<FontsState & { removedIds: FontId[] }>>
      fontSetActive: (fontId: FontId) => Promise<IpcResult<FontsState>>
      fontReadOfl: (fontId: FontId) => Promise<IpcResult<string>>
      fontReadBytes: (fontId: FontId) => Promise<IpcResult<ArrayBuffer>>
      // REQ-0275 §3 — persist FONT_SET_VERSION after bulk-DL success.
      fontRecordSetVersion: () => Promise<IpcResult<{ version: number }>>

      // REQ-0149 — GPU acceleration tools.
      gpuToolState: () => Promise<IpcResult<GpuToolState>>
      gpuToolDownload: () => Promise<IpcResult<{ channelId: string }>>
      gpuToolDownloadCancel: (channelId: string) => Promise<void>
      gpuToolDelete: () => Promise<IpcResult<GpuToolState>>
      gpuToolSelect: (choice: 'cpu' | 'gpu') => Promise<IpcResult<GpuToolState>>

      // REQ-0245 — active-download slot array snapshot for hydration.
      downloadActiveGet: () => Promise<IpcResult<ActiveDownloadInfo[]>>

      burninStart: (opts: BurninStartRequest) => Promise<IpcResult<{ channelId: string }>>
      burninCancel: (channelId: string) => Promise<void>

      settingsLoad: () => Promise<IpcResult<AppSettings>>
      settingsSave: (settings: AppSettings) => Promise<IpcResult<null>>

      shellOpenPath: (path: string) => Promise<void>
      shellShowInFolder: (path: string) => Promise<void>
      shellOpenExternal: (url: string) => Promise<void>
      shellOpenModelsFolder: () => Promise<void>
      shellOpenTranslationToolsFolder: () => Promise<void>
      shellOpenThirdPartyLicensesFolder: () => Promise<void>
      shellWriteTextFile: (filePath: string, content: string) => Promise<void>
      shellFileExists: (filePath: string) => Promise<boolean>
      // REQ-0194 — read `.mojioko` project files back as UTF-8 strings.
      shellReadTextFile: (filePath: string) => Promise<string>

      subscribeToChannel: (channelId: string, cb: (payload: unknown) => void) => () => void
    }
  }
}

export {}
