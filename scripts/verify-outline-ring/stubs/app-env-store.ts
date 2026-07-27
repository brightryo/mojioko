/**
 * REQ-0325 §3-1 — harness stub for `@/stores/app-env-store`.
 *
 * Identical to the real store except `isMsix` starts as `true` instead of
 * `null`.  Under server rendering zustand hands `useSyncExternalStore` its
 * `getInitialState()` snapshot, so `setState` before render does not reach the
 * component (see the "Known limitation" note in index.mjs) — the only way to
 * drive the flag is to change the initial value.
 *
 * `isMsix: true` = the MSIX (paid) build, where `canSelectFontInTier` allows
 * every registered font.  Without it `resolveRenderableFontId` tier-locks
 * every fixture back to `DEFAULT_FONT_ID` and the weight coverage is a no-op.
 * `canSelectFontInTier` itself is NOT stubbed — the real policy still runs.
 */
import { create } from 'zustand'

interface AppEnvStore {
  isMsix: boolean | null
  setIsMsix: (value: boolean) => void
}

export const useAppEnvStore = create<AppEnvStore>((set) => ({
  isMsix: true,
  setIsMsix: (value) => set({ isMsix: value }),
}))
