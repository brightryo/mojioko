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
}))
