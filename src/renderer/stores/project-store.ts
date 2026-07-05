import { create } from 'zustand'
import type { VideoInfo, SubtitleEntry, TranscriptionDefaults } from '../../shared/types'
import type { Cut } from '../../shared/cuts'
import { sanitizeCuts } from '../../shared/cuts'
import { sampleDefaults } from '@/lib/fixtures'
import { isEditedFromOriginal } from '@/lib/entry-edits'

export type VideoLoadingState = 'idle' | 'loading' | 'loaded' | 'error'

interface ProjectStore {
  video: VideoInfo | null
  videoLoadingState: VideoLoadingState
  selectedTrackIndex: number
  entries: SubtitleEntry[]
  defaults: TranscriptionDefaults
  /**
   * Trim/cut list — original-axis intervals that the user wants removed
   * from the final video.  Maintained sorted by startSec and non-overlapping
   * via `sanitizeCuts` (every mutation runs through it).  Empty by default.
   * Lives here, not on SubtitleEntry, so the entry type stays untouched and
   * cuts can be added/removed without rewriting subtitles (§1.2 / §3.3).
   */
  cuts: Cut[]

  setVideo: (v: VideoInfo | null) => void
  setVideoLoadingState: (s: VideoLoadingState) => void
  setSelectedTrackIndex: (i: number) => void
  setEntries: (entries: SubtitleEntry[]) => void
  updateEntry: (id: string, patch: Partial<SubtitleEntry>) => void
  /**
   * REQ-0125 — history-less variants of `updateEntry`.  Used for live
   * "preview during drag" updates from the color picker's `onChange`.
   * These write to `entries` (so subscribing views like SubtitleOverlay
   * re-render immediately) but do NOT push a history op, so an
   * S/V-drag does not spam the Undo stack.  Once the popover closes,
   * the caller registers a single coarse-grained history op via the
   * existing `applyStyleEdit` / `applyBulk` paths, passing a
   * `beforePatch` / `preBeforeSnapshots` so the Undo target rewinds
   * past the preview stream to the pre-open state.  The pair — one
   * history-less preview API + a beforePatch on the commit-time
   * history push — is the unified fix for RES-0124 bugs 2 and 3.
   */
  updateEntryPreview: (id: string, patch: Partial<SubtitleEntry>) => void
  updateEntriesPreview: (ids: readonly string[], patch: Partial<SubtitleEntry>) => void
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
  /** Replace the entire cut list.  Sanitised before storage. */
  setCuts: (cuts: Cut[]) => void
  /** Append a cut.  Sanitisation collapses overlaps with existing cuts. */
  addCut: (cut: Cut) => void
  /** Remove a cut by id.  No-op when the id is unknown. */
  removeCut: (id: string) => void
  /** Patch a cut's start/end (id unchanged).  Sanitised after patch. */
  updateCut: (id: string, patch: Partial<Pick<Cut, 'startSec' | 'endSec'>>) => void
  reset: () => void
}

const initialDefaults: TranscriptionDefaults = { ...sampleDefaults }

export const useProjectStore = create<ProjectStore>((set, get) => ({
  video: null,
  videoLoadingState: 'idle',
  selectedTrackIndex: 2,
  entries: [],
  defaults: { ...initialDefaults },
  cuts: [],

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
  // REQ-0125 — same shape as `updateEntry` (including the isEdited
  // recompute) but intentionally does NOT invoke the history-store.
  // Callers use this from the color picker's onChange during a drag; the
  // matching history op fires once at popover close via the existing
  // applyStyleEdit / applyBulk paths.
  updateEntryPreview: (id, patch) =>
    set((s) => ({
      entries: s.entries.map((e) => {
        if (e.id !== id) return e
        const merged = { ...e, ...patch }
        return { ...merged, isEdited: isEditedFromOriginal(merged) }
      })
    })),
  updateEntriesPreview: (ids, patch) =>
    set((s) => {
      const idSet = new Set(ids)
      return {
        entries: s.entries.map((e) => {
          if (!idSet.has(e.id)) return e
          const merged = { ...e, ...patch }
          return { ...merged, isEdited: isEditedFromOriginal(merged) }
        })
      }
    }),
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
  setCuts: (cuts) =>
    set({ cuts: sanitizeCuts(cuts, get().video?.durationSec) }),
  addCut: (cut) =>
    set((s) => ({
      cuts: sanitizeCuts([...s.cuts, cut], s.video?.durationSec)
    })),
  removeCut: (id) =>
    set((s) => ({ cuts: s.cuts.filter((c) => c.id !== id) })),
  updateCut: (id, patch) =>
    set((s) => ({
      cuts: sanitizeCuts(
        s.cuts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        s.video?.durationSec
      )
    })),
  reset: () =>
    set({
      video: null,
      videoLoadingState: 'idle',
      selectedTrackIndex: 2,
      entries: [],
      defaults: { ...initialDefaults },
      cuts: []
    })
}))
