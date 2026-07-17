import { EventEmitter } from 'events'
import { BrowserWindow } from 'electron'
import { Channels } from '../../shared/ipc-channels'
import log from '../lib/logger'

/**
 * REQ-0241 — global single-slot mutex for every download the app initiates.
 *
 * Motivation: model / GPU-tool / font downloads each had their own per-type
 * `activeDownloads` map with no cross-type coordination.  Starting a model
 * download while another was in flight, or kicking off a GPU-tool fetch on
 * top of a model download, could produce `EPERM` on shared paths, stream
 * lifecycle errors ("Cannot call end after a stream was destroyed") and
 * non-monotonic progress bars.  The manager forces one active download
 * across all three kinds by handing out a token that owns the
 * `AbortController` and the release hook; contending callers get a
 * `busy` result they can turn into a UI-side "another download is in
 * progress" affordance.
 */

export type DownloadKind = 'model' | 'gpu-tool' | 'font'

export interface ActiveDownloadInfo {
  kind: DownloadKind
  /** Human-visible name shown in tooltips / toasts (e.g. "large-v3"). */
  label: string
  startedAt: number
}

export interface DownloadToken {
  kind: DownloadKind
  label: string
  signal: AbortSignal
  /** Idempotent; only releases if this token still owns the slot. */
  release(): void
  /** Aborts the signal then releases.  Idempotent. */
  cancel(): void
}

export type AcquireResult =
  | DownloadToken
  | { busy: true; active: ActiveDownloadInfo }

interface ActiveSlot extends ActiveDownloadInfo {
  controller: AbortController
  released: boolean
}

class DownloadManager extends EventEmitter {
  private active: ActiveSlot | null = null

  acquire(kind: DownloadKind, label: string): AcquireResult {
    if (this.active) {
      return { busy: true, active: this.snapshot()! }
    }
    const controller = new AbortController()
    const slot: ActiveSlot = {
      kind,
      label,
      startedAt: Date.now(),
      controller,
      released: false,
    }
    this.active = slot
    log.info(`[download-manager] acquired kind=${kind} label=${label}`)
    this.emitChanged()

    const release = (): void => {
      if (slot.released) return
      // Guard against a stale release call after another download has
      // already claimed the slot.  Compare the controller (identity) so a
      // reused-label doesn't false-positive.
      if (this.active?.controller !== controller) {
        slot.released = true
        return
      }
      slot.released = true
      this.active = null
      log.info(`[download-manager] released kind=${kind} label=${label}`)
      this.emitChanged()
    }
    const cancel = (): void => {
      if (!slot.released) {
        controller.abort()
      }
      release()
    }
    return { kind, label, signal: controller.signal, release, cancel }
  }

  snapshot(): ActiveDownloadInfo | null {
    if (!this.active) return null
    return {
      kind: this.active.kind,
      label: this.active.label,
      startedAt: this.active.startedAt,
    }
  }

  /**
   * Reset the manager to an empty state.  Test-only escape hatch — never
   * called from production code (there is a single process-wide instance).
   */
  _resetForTests(): void {
    if (this.active) {
      this.active.controller.abort()
      this.active = null
      this.emit('changed', null)
    }
  }

  private emitChanged(): void {
    const snap = this.snapshot()
    this.emit('changed', snap)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(Channels.downloadActiveChanged, snap)
      }
    }
  }
}

export const downloadManager = new DownloadManager()
