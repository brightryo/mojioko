import { create } from 'zustand'

export type TableFilter = 'all' | 'ready' | 'edited' | 'warnings' | 'deleted'

/** Maximum number of recent colors kept in memory. */
const MAX_RECENT_COLORS = 5

interface UiStore {
  isCommandPaletteOpen: boolean
  isSettingsDialogOpen: boolean
  isShortcutsDialogOpen: boolean
  isAboutDialogOpen: boolean
  isDonationDialogOpen: boolean
  tableFilter: TableFilter
  focusedRowId: string | null
  selectedPreviewEntryId: string | null
  /** Session-only recent color history (not persisted to settings.json). */
  recentColors: string[]
  /**
   * One-shot seek request (seconds) produced by a subtitle row click.
   * VideoPreviewPanel consumes it and resets to null after seeking.
   * When ENABLE_VIDEO_PREVIEW is false this value is set but never consumed —
   * that is harmless.
   */
  videoSeekRequestSec: number | null
  /**
   * Current playback position (seconds) continuously updated by VideoPreviewPanel.
   * Used by step2's add-row dialog to default start time to the playhead position.
   * Stays at 0 when ENABLE_VIDEO_PREVIEW is false or no video is loaded.
   */
  videoCurrentTimeSec: number
  /**
   * One-shot "scroll this row into view" request consumed by SubtitleTable.
   *
   * Distinct from `focusedRowId` because:
   *   - `focusedRowId` is high-frequency (every row click, every video
   *     timeupdate) and only triggers a gentle `block: 'nearest'` scroll
   *     that may not move the viewport if the row is already partially
   *     visible.
   *   - `scrollToRowId` is set explicitly by user actions (add row, adjust
   *     time confirm) and triggers a deferred (~200ms, post-framer-motion
   *     animation) `block: 'center'` scroll that always brings the row
   *     well inside the viewport.  Cleared to null after consumption.
   */
  scrollToRowId: string | null
  /**
   * Multi-row selection used by Step 2's bulk-edit bar.  Independent of
   * `focusedRowId` (single row, drives the green left-edge marker and the
   * video seek) — a row can be focused and selected, focused but not
   * selected, or selected but not focused.  Retained across filter changes
   * so the user can refine a selection by hopping between filters.
   */
  selectedRowIds: ReadonlySet<string>
  /**
   * Last row that was single-clicked via its checkbox.  Anchor for Shift+click
   * range selection ("from anchor to clicked, inclusive").  Reset to null on
   * clearRowSelection.
   */
  selectionAnchorId: string | null

  setCommandPaletteOpen: (open: boolean) => void
  setSettingsDialogOpen: (open: boolean) => void
  setShortcutsDialogOpen: (open: boolean) => void
  setAboutDialogOpen: (open: boolean) => void
  setDonationDialogOpen: (open: boolean) => void
  setTableFilter: (f: TableFilter) => void
  setFocusedRowId: (id: string | null) => void
  setSelectedPreviewEntryId: (id: string | null) => void
  /** Prepend a color to the recent list, de-duplicating and capping at MAX_RECENT_COLORS. */
  addRecentColor: (hex: string) => void
  setVideoSeekRequest: (sec: number | null) => void
  setVideoCurrentTimeSec: (sec: number) => void
  setScrollToRowId: (id: string | null) => void
  /** Replace the entire selection set (used by select-all / Ctrl+A). */
  setRowSelection: (ids: ReadonlySet<string>) => void
  /** Toggle a single row's selection; updates selectionAnchorId to `id`. */
  toggleRowSelected: (id: string) => void
  /**
   * Select all rows between anchor and `id` (inclusive) in the visible-row
   * order.  When no anchor exists, falls back to a single-row toggle.
   * `visibleOrder` is the ordered list of currently displayed row ids — the
   * store does not know about filters, so callers must supply it.
   */
  selectRowRange: (id: string, visibleOrder: readonly string[]) => void
  clearRowSelection: () => void
}

export const useUiStore = create<UiStore>((set) => ({
  isCommandPaletteOpen: false,
  isSettingsDialogOpen: false,
  isShortcutsDialogOpen: false,
  isAboutDialogOpen: false,
  isDonationDialogOpen: false,
  tableFilter: 'all',
  focusedRowId: null,
  selectedPreviewEntryId: null,
  recentColors: [],
  videoSeekRequestSec: null,
  videoCurrentTimeSec: 0,
  scrollToRowId: null,
  selectedRowIds: new Set<string>(),
  selectionAnchorId: null,

  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
  setSettingsDialogOpen: (open) => set({ isSettingsDialogOpen: open }),
  setShortcutsDialogOpen: (open) => set({ isShortcutsDialogOpen: open }),
  setAboutDialogOpen: (open) => set({ isAboutDialogOpen: open }),
  setDonationDialogOpen: (open) => set({ isDonationDialogOpen: open }),
  setTableFilter: (f) => set({ tableFilter: f }),
  setFocusedRowId: (id) => set({ focusedRowId: id }),
  setSelectedPreviewEntryId: (id) => set({ selectedPreviewEntryId: id }),
  addRecentColor: (hex) =>
    set((s) => {
      const upper = hex.toUpperCase()
      const filtered = s.recentColors.filter((c) => c.toUpperCase() !== upper)
      return { recentColors: [upper, ...filtered].slice(0, MAX_RECENT_COLORS) }
    }),
  setVideoSeekRequest: (sec) => set({ videoSeekRequestSec: sec }),
  setVideoCurrentTimeSec: (sec) => set({ videoCurrentTimeSec: sec }),
  setScrollToRowId: (id) => set({ scrollToRowId: id }),
  setRowSelection: (ids) =>
    set((s) => ({
      selectedRowIds: ids,
      // Preserve the anchor when ids are non-empty (select-all keeps the
      // last anchored row meaningful for a subsequent Shift+click).  Clear
      // it when the set is empty so no stale id can survive.
      selectionAnchorId: ids.size > 0 ? s.selectionAnchorId : null
    })),
  toggleRowSelected: (id) =>
    set((s) => {
      const next = new Set(s.selectedRowIds)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { selectedRowIds: next, selectionAnchorId: id }
    }),
  selectRowRange: (id, visibleOrder) =>
    set((s) => {
      const anchor = s.selectionAnchorId
      // No anchor → treat as a plain toggle so the click still does something
      // sensible.  Subsequent Shift+click now has an anchor to expand from.
      if (anchor === null || anchor === id) {
        const next = new Set(s.selectedRowIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { selectedRowIds: next, selectionAnchorId: id }
      }
      const a = visibleOrder.indexOf(anchor)
      const b = visibleOrder.indexOf(id)
      if (a === -1 || b === -1) {
        // Anchor is filtered out of the current view; fall back to toggling
        // just the clicked row rather than producing an empty range.
        const next = new Set(s.selectedRowIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return { selectedRowIds: next, selectionAnchorId: id }
      }
      const [lo, hi] = a <= b ? [a, b] : [b, a]
      // Additive range: rows previously selected outside this range stay
      // selected, matching Finder / VS Code multi-select semantics.
      const next = new Set(s.selectedRowIds)
      for (let i = lo; i <= hi; i++) next.add(visibleOrder[i])
      return { selectedRowIds: next, selectionAnchorId: id }
    }),
  clearRowSelection: () =>
    set({ selectedRowIds: new Set<string>(), selectionAnchorId: null }),
}))
