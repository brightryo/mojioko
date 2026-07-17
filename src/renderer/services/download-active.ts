import { Channels } from '../../shared/ipc-channels'
import { useDownloadActiveStore } from '@/stores/download-active-store'
import type { ActiveDownloadInfo } from '../../shared/ipc-contracts'

/**
 * REQ-0241 — hydrate the active-download store at boot and start
 * listening for changes.
 *
 * Runs once from `App.tsx` mount.  The store then stays in sync via
 * the `download:active:changed` broadcast, which fires exactly on
 * DownloadManager acquire / release in the main process.  There is no
 * polling — the broadcast is single-shot per state change, so a
 * subscriber that reads from the store gets the up-to-date snapshot
 * without extra round-trips.
 */
export async function initDownloadActiveStore(): Promise<void> {
  try {
    const r = await window.electronAPI.downloadActiveGet()
    if (r.ok) {
      useDownloadActiveStore.getState().setActive(r.data)
    }
  } catch {
    // Boot-time IPC failure is non-fatal — the store stays at `null`
    // (its initial state) and the UI stays as if no DL is running.
    // The very first DL request will still be gated by the main-side
    // DownloadManager, so worst case the user sees a busy toast the
    // first time they try to run two at once.
  }
  window.electronAPI.subscribeToChannel(Channels.downloadActiveChanged, (payload) => {
    useDownloadActiveStore.getState().setActive(payload as ActiveDownloadInfo | null)
  })
}
