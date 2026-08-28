import { create } from 'zustand'
import type { TranslationToolsState } from '../../shared/translation-tools'
import { listTranslationTools } from '@/services/translation-tool'

/**
 * REQ-0426 — a tiny shared cache of the translation-tools state so surfaces
 * OTHER than the manager (specifically the STEP 2 inspector's auto-translate
 * preview) can tell whether a tool is downloaded + enabled WITHOUT firing a
 * translate IPC just to read a `NO_ACTIVE_TOOL` error.
 *
 * The manager (STEP 1) keeps ownership of mutations; it mirrors its local
 * state into this store on every change (see translation-tool-manager's sync
 * effect).  `App.tsx` also `refresh()`es once on launch as a belt-and-braces
 * so the inspector works even before the manager has mounted this session.
 *
 * `activeId != null` means a tool is enabled — and, since a tool can only be
 * enabled once installed, that it is ready to translate.
 */
interface TranslationToolStore {
  /** Latest tools state, or null before the first fetch. */
  state: TranslationToolsState | null
  setState: (s: TranslationToolsState | null) => void
  refresh: () => Promise<void>
}

export const useTranslationToolStore = create<TranslationToolStore>((set) => ({
  state: null,
  setState: (s) => set({ state: s }),
  refresh: async () => {
    const res = await listTranslationTools()
    if (res.ok) set({ state: res.data })
  },
}))
