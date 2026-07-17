import { create } from 'zustand'
import type { ActiveDownloadInfo } from '../../shared/ipc-contracts'

/**
 * REQ-0241 — mirror of the main-side DownloadManager slot.
 *
 * Hydrated at boot by `initDownloadActiveStore()` (see
 * `services/download-active.ts`) which fetches the current snapshot
 * and subscribes to the `download:active:changed` broadcast for live
 * updates.  Components use `useDownloadActiveStore` to disable their
 * "Download / Install" buttons whenever any DL — model, GPU tool, or
 * font — is in flight, so the user cannot start a second one on top of
 * it (see REQ-0241 §2.2 — "UI 入口封じ").
 *
 * `active === null` means idle.  When non-null the shape is the same
 * as the wire contract: `kind` picks the icon / label copy, `label` is
 * the human-visible name (e.g. "large-v3", "cuda-v1", "Delius").
 */
interface DownloadActiveStore {
  active: ActiveDownloadInfo | null
  setActive: (next: ActiveDownloadInfo | null) => void
}

export const useDownloadActiveStore = create<DownloadActiveStore>((set) => ({
  active: null,
  setActive: (next) => set({ active: next }),
}))

/**
 * REQ-0241 convenience selector — returns whether *another* kind is
 * currently downloading.  When the caller is `null` (component doesn't
 * declare its own kind) any active download counts.  When the caller
 * passes its own `kind`, an active DL of the same kind is treated as
 * "our own progress" and does NOT disable the caller's controls —
 * each manager keeps its own in-place progress UI.
 */
export function isOtherDownloadActive(
  active: ActiveDownloadInfo | null,
  myKind: ActiveDownloadInfo['kind'] | null,
): boolean {
  if (!active) return false
  if (myKind === null) return true
  return active.kind !== myKind
}
