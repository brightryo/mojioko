import { create } from 'zustand'
import type { VideoInfo, SubtitleEntry, TranscriptionDefaults } from '../../shared/types'
import { sampleDefaults } from '@/lib/fixtures'
import { isEditedFromOriginal } from '@/lib/entry-edits'

export type VideoLoadingState = 'idle' | 'loading' | 'loaded' | 'error'

interface ProjectStore {
  video: VideoInfo | null
  videoLoadingState: VideoLoadingState
  selectedTrackIndex: number
  entries: SubtitleEntry[]
  defaults: TranscriptionDefaults

  setVideo: (v: VideoInfo | null) => void
  setVideoLoadingState: (s: VideoLoadingState) => void
  setSelectedTrackIndex: (i: number) => void
  setEntries: (entries: SubtitleEntry[]) => void
  updateEntry: (id: string, patch: Partial<SubtitleEntry>) => void
  addEntry: (entry: SubtitleEntry, atIndex: number) => void
  /**
   * Re-order `entries` by `startSec` ascending (stable sort — equal-startSec
   * entries keep their relative insertion order).  Called by `commitTimeEdit`
   * after any user-initiated time change (TimeEditorDialog confirm, inline
   * TimeInput blur/Enter, row reset).
   *
   * Operates on the FULL entries array including soft-deleted rows: the
   * "Deleted" tab benefits from the same chronological ordering.
   */
  sortByStartSec: () => void
  setDefaults: (d: Partial<TranscriptionDefaults>) => void
  reset: () => void
}

const initialDefaults: TranscriptionDefaults = { ...sampleDefaults }

export const useProjectStore = create<ProjectStore>((set) => ({
  video: null,
  videoLoadingState: 'idle',
  selectedTrackIndex: 2,
  entries: [],
  defaults: { ...initialDefaults },

  setVideo: (v) => set({ video: v }),
  setVideoLoadingState: (s) => set({ videoLoadingState: s }),
  setSelectedTrackIndex: (i) => set({ selectedTrackIndex: i }),
  setEntries: (entries) => set({ entries }),
  /**
   * Merge `patch` into the entry, then **recompute `isEdited`** from the
   * merged entry's values vs `entry.original` (see {@link isEditedFromOriginal}).
   *
   * The recompute deliberately overrides any `isEdited` value supplied in
   * the patch: prior callers set `isEdited: true` on every edit by hand,
   * which could not detect "edited then restored" round-trips (e.g. drag a
   * timeline block away and back to its starting time; type the same
   * displayed value into TimeInput; bulk-edit a row's text back to its
   * original).  Centralising the computation here keeps both views (table
   * and timeline) consistent without each call site duplicating the
   * comparison logic.  REQ-059.
   */
  updateEntry: (id, patch) =>
    set((s) => ({
      entries: s.entries.map((e) => {
        if (e.id !== id) return e
        const merged = { ...e, ...patch }
        return { ...merged, isEdited: isEditedFromOriginal(merged) }
      })
    })),
  addEntry: (entry, atIndex) =>
    set((s) => ({
      entries: [...s.entries.slice(0, atIndex), entry, ...s.entries.slice(atIndex)]
    })),
  sortByStartSec: () =>
    set((s) => ({
      // Spec-guaranteed stable sort (ES2019+) — equal-startSec entries keep
      // their relative position so re-sorting an already-sorted array is a
      // no-op and "+ Add row" insertion order at equal startSec is preserved.
      entries: [...s.entries].sort((a, b) => a.startSec - b.startSec)
    })),
  setDefaults: (d) =>
    set((s) => ({ defaults: { ...s.defaults, ...d } })),
  reset: () =>
    set({
      video: null,
      videoLoadingState: 'idle',
      selectedTrackIndex: 2,
      entries: [],
      defaults: { ...initialDefaults }
    })
}))
