import { ipcMain } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import { probeVideo, extractThumbnail } from '../services/ffprobe'
import { exportFrame } from '../services/frame-exporter'
import { allowVideoPath } from '../lib/video-protocol'
import type { VideoInfo } from '../../shared/types'
import type { ExportFrameRequest, ExportFrameResult } from '../../shared/ipc-contracts'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

function toErr(err: unknown): ErrResult {
  const e = err as Error & { code?: string }
  return { ok: false, error: { code: e.code ?? 'VIDEO_ERROR', message: e.message } }
}

export function registerVideoHandlers(): void {
  ipcMain.handle(Channels.videoProbe, async (_event, path: string): Promise<OkResult<VideoInfo> | ErrResult> => {
    try {
      const data = await probeVideo(path)
      // Probe success → renderer is now allowed to stream this file through
      // mojioko-media://.  Adds the canonical realpath to the allowlist so
      // the protocol handler accepts subsequent <video src=...> requests.
      allowVideoPath(path)
      return { ok: true, data }
    } catch (err) {
      log.error('[ipc/video] probe error', err)
      return toErr(err)
    }
  })

  ipcMain.handle(Channels.videoExtractThumbnail, async (_event, path: string, atSec: number): Promise<OkResult<string> | ErrResult> => {
    try {
      const data = await extractThumbnail(path, atSec)
      return { ok: true, data }
    } catch (err) {
      log.error('[ipc/video] thumbnail error', err)
      return toErr(err)
    }
  })

  // TODO: remove with the next IPC-surface cleanup pass.  Originally fed
  // Step 3's live preview; Step 3 was redesigned to be "render settings &
  // execute" only, so this handler currently has no renderer-side caller.
  // Left wired up to keep this branch's diff focused on the redesign.
  ipcMain.handle(Channels.videoExtractFrameForPreview, async (_event, path: string, atSec: number): Promise<OkResult<string> | ErrResult> => {
    try {
      const data = await extractThumbnail(path, atSec)
      return { ok: true, data }
    } catch (err) {
      log.error('[ipc/video] frame error', err)
      return toErr(err)
    }
  })

  // REQ-20260615-021: save the current preview frame (with or without
  // subtitles) to disk at the source video's resolution.
  ipcMain.handle(Channels.videoExportFrame, async (_event, req: ExportFrameRequest): Promise<OkResult<ExportFrameResult> | ErrResult> => {
    try {
      const data = await exportFrame(req)
      return { ok: true, data }
    } catch (err) {
      log.error('[ipc/video] exportFrame error', err)
      return toErr(err)
    }
  })
}
