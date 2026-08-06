import { create } from 'zustand'
import { preloadTranslation } from '@/services/translation-tool'

/**
 * REQ-0426 — tracks the MADLAD model warm-up so the inspector can show a
 * 「ロード処理中」 state right after 自動翻訳 is enabled.
 *
 * `preload()` is idempotent while already loading/loaded; `reset()` is called
 * when 自動翻訳 is turned OFF (the sidecar stays resident, but the next enable
 * re-checks and re-warms if needed).  The App-level effect drives both from the
 * `translationAutoEnabled` + active-tool status.
 */
export type TranslationLoadState = 'idle' | 'loading' | 'loaded' | 'error'

interface TranslationLoadStore {
  loadState: TranslationLoadState
  preload: () => Promise<void>
  reset: () => void
}

export const useTranslationLoadStore = create<TranslationLoadStore>((set, get) => ({
  loadState: 'idle',
  preload: async () => {
    const current = get().loadState
    if (current === 'loading' || current === 'loaded') return
    set({ loadState: 'loading' })
    try {
      const res = await preloadTranslation()
      set({ loadState: res.ok ? 'loaded' : 'error' })
    } catch {
      set({ loadState: 'error' })
    }
  },
  reset: () => set({ loadState: 'idle' }),
}))
