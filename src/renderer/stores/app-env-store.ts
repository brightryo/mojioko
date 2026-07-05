import { create } from 'zustand'

/**
 * REQ-088 #4 — runtime environment flags that the renderer learns once
 * at app boot via IPC.  Today this is just the MSIX/NSIS tier signal
 * (paid vs free); future runtime metadata that doesn't fit Settings
 * (e.g. signing status, demo mode) belongs here too.
 *
 * `isMsix === null` is the pre-boot state: the IPC hasn't returned yet.
 * Components must treat null as "not yet known" and avoid making
 * tier-gated decisions until it settles — otherwise a free build would
 * briefly render as paid (or vice versa) on the first paint.  In
 * practice the IPC resolves in a few ms during App.tsx mount, well
 * before any font UI is reachable.
 *
 * The store is intentionally append-only — once `setIsMsix` writes a
 * boolean, no path resets it back to null.  An MSIX-packaged process
 * doesn't reattach into a non-MSIX environment, and the reverse is
 * equally impossible.
 */
interface AppEnvStore {
  isMsix: boolean | null
  setIsMsix: (value: boolean) => void
}

export const useAppEnvStore = create<AppEnvStore>((set) => ({
  isMsix: null,
  setIsMsix: (value) => set({ isMsix: value }),
}))
