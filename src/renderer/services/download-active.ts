import { Channels } from '../../shared/ipc-channels'
import { useDownloadActiveStore } from '@/stores/download-active-store'
import type { ActiveDownloadInfo } from '../../shared/ipc-contracts'

/**
 * REQ-0245 — hydrate the active-download store at boot and start
 * listening for broadcast updates.
 *
 * Called once from `App.tsx` on mount.  The store then stays in sync
 * with main via the `download:active:changed` broadcast, which the
 * DownloadManager fires on every acquire / release.  Boot hydration
 * (`downloadActiveGet`) is what makes component remounts safe —
 * closing and reopening the settings drawer while a DL is running
 * will find the store already populated, so per-row buttons render
 * as "Downloading" from the first paint instead of briefly flashing
 * "Download".
 *
 * Boot IPC failure is non-fatal: the store starts empty and the
 * next real acquire/release will populate it via the broadcast.
 */
export async function initDownloadActiveStore(): Promise<void> {
  try {
    const r = await window.electronAPI.downloadActiveGet()
    if (r.ok) {
      useDownloadActiveStore.getState().setActive(r.data)
    }
  } catch {
    // Non-fatal — main-side DownloadManager still enforces slot
    // uniqueness on its own, and the broadcast will backfill the
    // store on the next real state change.
  }
  window.electronAPI.subscribeToChannel(Channels.downloadActiveChanged, (payload) => {
    useDownloadActiveStore.getState().setActive(payload as ActiveDownloadInfo[])
  })
}
