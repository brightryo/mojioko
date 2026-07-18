import { create } from 'zustand'
import type { ActiveDownloadInfo, DownloadKind } from '../../shared/ipc-contracts'

/**
 * REQ-0245 — mirror of main's DownloadManager active-slot array.
 *
 * REQ-0244 removed the earlier (REQ-0241) single-slot mirror as
 * "dead weight" — but that removal broke UI state sync under
 * parallel semantics: each component's local `downloadingId` couldn't
 * reliably reflect main's slot map (a second DL clobbered the first
 * row's flag → its button flipped back to "Download" while main
 * still held the slot → re-click hit `DOWNLOAD_BUSY`).
 *
 * REQ-0245 restores the mirror as a multi-slot ARRAY.  Each per-row
 * `isDownloading` derives from `selectActiveKeys(active, kind)`, so
 * the UI stays in lockstep with main regardless of how many
 * concurrent downloads are running.
 *
 * Hydration + subscription live in `services/download-active.ts`;
 * this file is data-only.
 */
interface DownloadActiveStore {
  active: ActiveDownloadInfo[]
  setActive: (next: ActiveDownloadInfo[]) => void
}

export const useDownloadActiveStore = create<DownloadActiveStore>((set) => ({
  active: [],
  setActive: (next) => set({ active: next }),
}))

/**
 * REQ-0245 — build a `Set<targetId>` of the currently-active
 * downloads for a given kind.  Components memoize this once at the
 * top of the map/loop instead of running an O(n) `some()` per row.
 * A Set membership check is O(1).
 *
 * Returning a Set (rather than a callback) keeps the caller's
 * `useMemo` dependency graph honest — the Set identity changes only
 * when the underlying array does, which changes only when the
 * broadcast fires.
 */
export function selectActiveKeys(
  active: ActiveDownloadInfo[],
  kind: DownloadKind,
): Set<string> {
  const s = new Set<string>()
  for (const a of active) {
    if (a.kind === kind) s.add(a.targetId)
  }
  return s
}
