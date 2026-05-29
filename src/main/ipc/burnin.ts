import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { Channels } from '../../shared/ipc-channels'
import { startBurnin } from '../services/ffmpeg-burnin'
import type { BurninStartRequest } from '../../shared/ipc-contracts'
import log from '../lib/logger'

type OkResult<T> = { ok: true; data: T }
type ErrResult = { ok: false; error: { code: string; message: string } }

const activeControllers = new Map<string, AbortController>()

export function registerBurninHandlers(): void {
  ipcMain.handle(Channels.burninStart, async (event, request: BurninStartRequest): Promise<OkResult<{ channelId: string }> | ErrResult> => {
    const channelId = `burnin:event:${randomUUID()}`
    const ctrl = new AbortController()
    activeControllers.set(channelId, ctrl)

    const startedAt = Date.now()
    log.info(
      `[ipc/burnin] start: encoderSetting=${request.encoderSetting ?? 'auto'} ` +
      `audioMode=${request.audioMode ?? 'simple'} entries=${request.entries.length} ` +
      `output=${request.outputPath} channelId=${channelId}`
    )

    startBurnin(
      request,
      (evt) => {
        if (evt.event === 'completed') {
          const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
          log.info(
            `[ipc/burnin] completed: output=${evt.outputPath} sizeMB=${evt.sizeMB} ` +
            `elapsed=${elapsedSec}s`
          )
        } else if (evt.event === 'failed') {
          log.error(`[ipc/burnin] failed: reason=${evt.error}`)
        }
        if (!event.sender.isDestroyed()) {
          event.sender.send(channelId, evt)
        }
      },
      ctrl.signal
    )
      .catch((err) => {
        if (!ctrl.signal.aborted && !event.sender.isDestroyed()) {
          log.error('[ipc/burnin] error', err)
          event.sender.send(channelId, { event: 'failed', error: String(err) })
        }
      })
      .finally(() => {
        activeControllers.delete(channelId)
      })

    return { ok: true, data: { channelId } }
  })

  ipcMain.handle(Channels.burninCancel, async (_event, channelId: string): Promise<void> => {
    const ctrl = activeControllers.get(channelId)
    if (ctrl) {
      ctrl.abort()
      activeControllers.delete(channelId)
    }
  })
}
