/// <reference types="vite/client" />

import type { VideoInfo, AppSettings, WhisperModelId, ModelsState } from '../shared/types'
import type { FontsState, FontId } from '../shared/fonts'
import type { TranscriptionStartRequest, BurninStartRequest, ModelCheckResult, BuildInfo, EncoderDetectionResult, ExportFrameRequest, ExportFrameResult } from '../shared/ipc-contracts'

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
      menuSetLanguage: (lang: string) => void
      menuSetTranscribing: (val: boolean) => void

      openVideoDialog: (defaultDir?: string) => Promise<string | null>
      saveFileDialog: (
        defaultName: string,
        defaultDir?: string,
        filters?: { name: string; extensions: string[] }[]
      ) => Promise<string | null>

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

      fontList: () => Promise<IpcResult<FontsState>>
      fontDownload: (fontId: FontId) => Promise<IpcResult<{ channelId: string }>>
      fontDownloadCancel: (channelId: string) => Promise<void>
      fontUninstall: (fontId: FontId) => Promise<IpcResult<FontsState>>
      fontSetActive: (fontId: FontId) => Promise<IpcResult<FontsState>>
      fontReadOfl: (fontId: FontId) => Promise<IpcResult<string>>
      fontReadBytes: (fontId: FontId) => Promise<IpcResult<ArrayBuffer>>

      burninStart: (opts: BurninStartRequest) => Promise<IpcResult<{ channelId: string }>>
      burninCancel: (channelId: string) => Promise<void>

      settingsLoad: () => Promise<IpcResult<AppSettings>>
      settingsSave: (settings: AppSettings) => Promise<IpcResult<null>>

      shellOpenPath: (path: string) => Promise<void>
      shellShowInFolder: (path: string) => Promise<void>
      shellOpenExternal: (url: string) => Promise<void>
      shellOpenModelsFolder: () => Promise<void>
      shellOpenThirdPartyLicensesFolder: () => Promise<void>
      shellWriteTextFile: (filePath: string, content: string) => Promise<void>
      shellFileExists: (filePath: string) => Promise<boolean>

      subscribeToChannel: (channelId: string, cb: (payload: unknown) => void) => () => void
    }
  }
}

export {}
