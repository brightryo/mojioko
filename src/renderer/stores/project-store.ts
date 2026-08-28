import { create } from 'zustand'
import type { VideoInfo, SubtitleEntry, TranscriptionDefaults } from '../../shared/types'
import type { Cut } from '../../shared/cuts'
import { sanitizeCuts } from '../../shared/cuts'
import { sampleDefaults } from '@/lib/fixtures'
import { isEditedFromOriginal } from '@/lib/entry-edits'
import { assignCueNumbers, nextCueNumber } from '../../shared/cue-number'

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
  /**
   * REQ-0342 §3 — apply a DIFFERENT patch to each of many entries in ONE
   * `set()`.
   *
   * `applyBulk` used to loop `updateEntry` once per selected row.  Each call
   * is its own store write, and each write walks the whole entries array and
   * notifies every subscriber — so a select-all edit was O(selected x total)
   * array rebuilds plus N store notifications.  Measured on the subtitle-table
   * view at 3000 cues, one font-size click: **12,666 ms** in that loop.  The
   * same click with the same code in the timeline view cost 97 ms, which is
   * what identified the cost as per-write subscriber work (the unvirtualised
   * table re-measures its framer-motion `layout` rows on every commit), not
   * the array maps.  One write instead of N removes N-1 of them: the same
   * click measures **19.6 ms** after.
   *
   * A Map rather than `(ids, patch)` because the layout-anchor branch of
   * `applyBulk` computes a per-row `posX` / `posY`, and Undo restores a
   * different whole snapshot per row — both need distinct patches, and
   * splitting them back into per-row writes would reintroduce exactly what
   * this exists to remove.  Entries absent from the map are returned by
   * identity, so React's `memo` and every downstream `useMemo` still see them
   * as unchanged.
   *
   * History is the caller's business, same as `updateEntry`: `applyBulk`
   * pushes one entry whose undo/redo both route back through here.
   */
  updateEntriesBatch: (patches: ReadonlyMap<string, Partial<SubtitleEntry>>) => void
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
  /**
   * REQ-0196 — partial reset that clears the step2-produced editing
   * state (`entries` + `cuts`) while keeping the source video, its
   * loading state, and the currently-selected transcription track.
   * Called from:
   *   1. step2's discard-back confirm dialog — REQ-0185 promises
   *      "編集途中のものは破棄されます" but the pre-0196 handler only
   *      called `navigate('/step1')` and left the entries live in
   *      the Zustand store, so the next `saveCurrentProject()` from
   *      step1 emitted a `.mojioko` pairing the new video with the
   *      old entries.
   *   2. step1's video-picker as a defensive follow-up: even if the
   *      back-discard cleared entries, a project-open path could
   *      have left them populated; picking a fresh video means the
   *      old subtitles are always semantically stale.
   */
  resetEditingState: () => void
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
  // REQ-0400 — every creation path (transcription, SRT import, project load)
  // and undo/redo funnels through setEntries, so assigning stable display
  // numbers here back-fills any entry that arrives without one (legacy files,
  // fixtures) exactly once, in array order.  Already-numbered entries keep
  // their number and object identity.
  setEntries: (entries) => set({ entries: assignCueNumbers(entries) }),
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
  updateEntriesBatch: (patches) =>
    set((s) => {
      if (patches.size === 0) return {}
      return {
        entries: s.entries.map((e) => {
          const patch = patches.get(e.id)
          if (patch === undefined) return e
          const merged = { ...e, ...patch }
          return { ...merged, isEdited: isEditedFromOriginal(merged) }
        })
      }
    }),
  addEntry: (entry, atIndex) =>
    set((s) => {
      // REQ-0400 — mint a fresh display number for a cue that arrives without
      // one (add-row, duplicate).  Based on the live max, so it is monotonic
      // and a duplicate is always distinguishable from its source.  Redo of an
      // add recomputes deterministically from the same state.
      const withNumber =
        typeof entry.cueNumber === 'number'
          ? entry
          : { ...entry, cueNumber: nextCueNumber(s.entries) }
      return {
        entries: [...s.entries.slice(0, atIndex), withNumber, ...s.entries.slice(atIndex)]
      }
    }),
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
    }),
  resetEditingState: () =>
    set({
      entries: [],
      cuts: []
    })
}))
