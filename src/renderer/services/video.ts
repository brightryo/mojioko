import type { VideoInfo, IpcResult } from '../../shared/types'

export async function probeVideo(filePath: string): Promise<IpcResult<VideoInfo>> {
  return window.electronAPI.videoProbe(filePath)
}

export async function extractThumbnail(filePath: string, timeSec: number): Promise<IpcResult<string>> {
  return window.electronAPI.videoExtractThumbnail(filePath, timeSec)
}

/**
 * @deprecated Unused since Step 3's live-preview was retired (responsibility
 * moved to Step 2 — Step 3 is now "render settings & execute" only).  The
 * function, its IPC wrapper, and the main-process handler are intentionally
 * left in place so this branch's diff stays focused on the Step 3 redesign;
 * scheduled for removal during the next IPC-surface cleanup pass.
 */
export async function extractFrameForPreview(filePath: string, timeSec: number): Promise<IpcResult<string>> {
  return window.electronAPI.videoExtractFrameForPreview(filePath, timeSec)
}
