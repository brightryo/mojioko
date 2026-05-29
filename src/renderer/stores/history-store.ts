import { create } from 'zustand'
import { MAX_HISTORY } from '../../shared/constants'

export interface HistoryEntry {
  label: string
  undo: () => void
  redo: () => void
}

interface HistoryStore {
  past: HistoryEntry[]
  future: HistoryEntry[]
  canUndo: boolean
  canRedo: boolean

  push: (entry: HistoryEntry) => void
  undo: () => void
  redo: () => void
  clear: () => void
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  past: [],
  future: [],
  canUndo: false,
  canRedo: false,

  push: (entry) => {
    set((s) => {
      const past = [...s.past, entry].slice(-MAX_HISTORY)
      return { past, future: [], canUndo: true, canRedo: false }
    })
  },

  undo: () => {
    const { past, future } = get()
    if (past.length === 0) return
    const entry = past[past.length - 1]
    entry.undo()
    set({
      past: past.slice(0, -1),
      future: [entry, ...future],
      canUndo: past.length > 1,
      canRedo: true
    })
  },

  redo: () => {
    const { past, future } = get()
    if (future.length === 0) return
    const entry = future[0]
    entry.redo()
    set({
      past: [...past, entry],
      future: future.slice(1),
      canUndo: true,
      canRedo: future.length > 1
    })
  },

  clear: () => set({ past: [], future: [], canUndo: false, canRedo: false })
}))
