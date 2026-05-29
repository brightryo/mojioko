import type { VideoInfo, IpcResult } from '../../shared/types'

export async function probeVideo(filePath: string): Promise<IpcResult<VideoInfo>> {
  return window.electronAPI.videoProbe(filePath)
}

export async function extractThumbnail(filePath: string, timeSec: number): Promise<IpcResult<string>> {
  return window.electronAPI.videoExtractThumbnail(filePath, timeSec)
}

export async function extractFrameForPreview(filePath: string, timeSec: number): Promise<IpcResult<string>> {
  return window.electronAPI.videoExtractFrameForPreview(filePath, timeSec)
}
