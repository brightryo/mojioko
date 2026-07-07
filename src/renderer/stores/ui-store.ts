import { create } from 'zustand'

export type TableFilter = 'all' | 'ready' | 'edited' | 'warnings' | 'deleted'

/**
 * STEP 2 lower-area view mode.  Both views read/write the same
 * `useProjectStore.entries` — this flag only decides which UI is rendered.
 * See `dev-docs/specs/timeline.md` for the 1-data-2-views design.
 */
export type EditorViewMode = 'list' | 'timeline'

/** Minimum / maximum timeline zoom in pixels-per-second. */
export const TIMELINE_PPS_MIN = 10
export const TIMELINE_PPS_MAX = 400
/** Default timeline zoom (50 px/sec → 10 s spans 500 px). */
export const TIMELINE_PPS_DEFAULT = 50

/** Maximum number of recent colors kept in memory. */
const MAX_RECENT_COLORS = 5

interface UiStore {
  isSettingsDialogOpen: boolean
  isAboutDialogOpen: boolean
  isDonationDialogOpen: boolean
  isFontLicensesDialogOpen: boolean
  /**
   * REQ-0137 fix — id-keyed set of currently-open overlays.  Replaces
   * REQ-0132's `overlayOpenCount: number` for two reasons the Set
   * solves:
   *
   *   1. **Idempotency under any repeated mount.**  React StrictMode
   *      dev double-invokes effects (setup → cleanup → setup) and a
   *      counter is only correct if inc/dec are perfectly paired.  A
   *      Set with `add(id)` + `delete(id)` is trivially idempotent:
   *      re-add of the same id leaves one entry; delete of an unknown
   *      id is a no-op.
   *   2. **Debuggability.**  `overlayIds` names which overlays are
   *      open at any moment — useful when triaging a "shortcuts don't
   *      fire" report; inspect the Set to see what is still registered.
   *
   * Each overlay picks its id via `useId()` inside
   * `useOverlayRegistration`.  `useId()` is stable per component
   * instance so the same overlay always uses the same id across
   * StrictMode double-invokes / re-renders.
   *
   * `isAnyOverlayOpen(state)` reads `overlayIds.size > 0`.
   */
  overlayIds: ReadonlySet<string>
  tableFilter: TableFilter
  /**
   * REQ-20260614-001 Phase 3 — **playback-active entry id**.  Set by the
   * preview panel's `handleTimeUpdate` to the subtitle whose
   * `[startSec, endSec)` covers the current playhead; cleared on video
   * change.  Distinct from `selectedEntryId` (= user-driven single
   * selection) and from `selectedRowIds` (= bulk-edit checkbox set).
   *
   * Old behaviour (pre-Phase 3): `focusedRowId` was overloaded as both
   * the user selection and the playback follower.  After Phase 3 it is
   * the *playback follower only* — user-driven selection lives in
   * `selectedEntryId`.  The split surfaces both states in the table /
   * timeline UI (green = selected, blue = playing).
   */
  focusedRowId: string | null
  /**
   * REQ-20260614-001 Phase 3 — **user-selected single entry id**.  Set
   * by row click (SubtitleTable), block click (TimelineView), add-row /
   * duplicate-row flows, and time-edit commits.  Drives:
   *   - The (常設) Inspector content (Phase 4).
   *   - The green ring/border highlight in both the list and the timeline.
   *   - The prev/next snap targets in the add-row dialog.
   *
   * Null when the user has not interacted with any specific row yet.
   * Independent of `focusedRowId` (playback follower) so playback can
   * advance through the video without changing the inspector context.
   */
  selectedEntryId: string | null
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
   * VideoPreviewPanel collapsed/expanded state.  Session-only — defaults
   * to expanded on every fresh mount so the user always lands with the
   * preview visible.  Collapsing it (e.g. to reclaim vertical space for
   * the subtitle table at narrow window widths, or to clear room for a
   * future timeline view) is remembered across navigations within the
   * session only.
   */
  videoPreviewExpanded: boolean
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
  /**
   * Monotonic counter bumped whenever the on-disk font inventory changes
   * (download completes, uninstall completes).  REQ-025 (iv).  Hooks like
   * `useInstalledFontIds` watch this so a stale popover list updates when
   * the user installs or removes a font in another part of the UI.
   * Session-only — installed state is always re-read from the main side
   * on launch.
   */
  fontInventoryVersion: number
  /**
   * STEP 2 lower-area view selection.  Session-only — defaults to
   * `'timeline'` on every fresh mount (REQ-063) so the user lands on the
   * timeline editor immediately after transcription; the list view is
   * still one click away via `<EditorViewSwitcher>` and the choice
   * persists for the rest of the session.  Both views read/write the
   * same `useProjectStore.entries`; this flag only controls which
   * component renders.  See `dev-docs/specs/timeline.md`.
   */
  editorViewMode: EditorViewMode
  /**
   * Timeline horizontal zoom in pixels per second.  Drives time→x mapping
   * for the ruler, blocks, and playhead.  Session-only.
   */
  timelinePixelsPerSec: number
  /**
   * Timeline snap toggle.  Phase 1 only stores the flag — the snap algorithm
   * itself lands in Phase 5.  Session-only.
   */
  timelineSnapEnabled: boolean
  /**
   * REQ-074 1e — pending trim In / Out point set by the user from the
   * timeline toolbar but not yet confirmed as a Cut.  Both are ORIGINAL
   * axis seconds (= `<video>.currentTime` at capture time).  Session-only;
   * cleared on cut confirmation or on explicit reset.
   *
   * Lives in ui-store rather than project-store because it represents an
   * in-flight UI gesture, not part of the saved project state — undo /
   * redo only push the confirmed Cut, never the pending In/Out clicks.
   */
  pendingCutInSec: number | null
  pendingCutOutSec: number | null

  /**
   * REQ-20260614-001 補遺③ — STEP 2 resizable 3-pane layout state
   * (outer **horizontal**: left/right; left inner **vertical**: preview /
   * bottom).  Numbers are PERCENTAGES of the parent group (= the
   * `Layout` map react-resizable-panels v4 returns from
   * `onLayoutChange`).  Session-only; later phases may persist via
   * `localStorage` once the user has lived with the defaults.
   *
   * Keys match the panel `id` props in step2.tsx so the saved Layout map
   * can feed straight back into the Group's `defaultLayout`.  The
   * previous (Phase 2) outer-vertical / inner-horizontal structure was
   * replaced in REQ補遺③ so the Inspector becomes a full-height right
   * column.
   */
  step2OuterLayout: { 'step2-pane-left': number; 'step2-pane-right': number }
  step2LeftLayout:  { 'step2-pane-preview': number; 'step2-pane-bottom': number }

  /**
   * REQ-20260614-001 補遺⑧ — タイムラインツールバーの 2 行目（トリミング +
   * 吸着）の表示状態。Row 1 右端の「ツール」ボタンで toggle する。session-
   * only（ページ遷移をまたいでも保持されるが、アプリ再起動でリセット）。
   * デフォルト `false`（折り畳み）。
   */
  step2TimelineToolsExpanded: boolean

  /**
   * REQ-20260615-064 A — set to `true` by STEP 1 right before it
   * navigates to STEP 2 with an empty `entries` array (faster-whisper
   * returned zero segments because the audio had no detectable
   * speech).  STEP 2 reads this on mount, surfaces a one-time toast
   * ("発話を検出できませんでした。「追加」から手動で作成できます"),
   * and resets the flag back to `false` so the toast does not fire
   * again on subsequent visits within the same session.  Session-
   * only; never persisted.  Keeping the signal local to the UI store
   * avoids changing the `TranscriptionEvent` IPC contract.
   */
  lastTranscriptionWasEmpty: boolean

  setSettingsDialogOpen: (open: boolean) => void
  setAboutDialogOpen: (open: boolean) => void
  setDonationDialogOpen: (open: boolean) => void
  setFontLicensesDialogOpen: (open: boolean) => void
  /** REQ-0137 — id-keyed overlay registration.  Idempotent add / delete. */
  addOverlay: (id: string) => void
  removeOverlay: (id: string) => void
  setTableFilter: (f: TableFilter) => void
  setFocusedRowId: (id: string | null) => void
  setSelectedEntryId: (id: string | null) => void
  /** Prepend a color to the recent list, de-duplicating and capping at MAX_RECENT_COLORS. */
  addRecentColor: (hex: string) => void
  setVideoSeekRequest: (sec: number | null) => void
  setVideoCurrentTimeSec: (sec: number) => void
  setVideoPreviewExpanded: (open: boolean) => void
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
  /** Increment fontInventoryVersion — call after a font is installed / uninstalled. */
  bumpFontInventoryVersion: () => void
  setEditorViewMode: (m: EditorViewMode) => void
  /** Set timeline zoom; clamped to [TIMELINE_PPS_MIN, TIMELINE_PPS_MAX]. */
  setTimelinePixelsPerSec: (v: number) => void
  setTimelineSnapEnabled: (v: boolean) => void
  setPendingCutIn: (sec: number | null) => void
  setPendingCutOut: (sec: number | null) => void
  clearPendingCut: () => void
  setStep2OuterLayout: (layout: { 'step2-pane-left': number; 'step2-pane-right': number }) => void
  setStep2LeftLayout:  (layout: { 'step2-pane-preview': number; 'step2-pane-bottom': number }) => void
  toggleStep2TimelineTools: () => void
  /** REQ-20260615-064 A — see `lastTranscriptionWasEmpty` above. */
  setLastTranscriptionWasEmpty: (v: boolean) => void
}

export const useUiStore = create<UiStore>((set) => ({
  isSettingsDialogOpen: false,
  isAboutDialogOpen: false,
  isDonationDialogOpen: false,
  isFontLicensesDialogOpen: false,
  overlayIds: new Set<string>(),
  tableFilter: 'all',
  focusedRowId: null,
  selectedEntryId: null,
  recentColors: [],
  videoSeekRequestSec: null,
  videoCurrentTimeSec: 0,
  videoPreviewExpanded: true,
  scrollToRowId: null,
  selectedRowIds: new Set<string>(),
  selectionAnchorId: null,
  fontInventoryVersion: 0,
  editorViewMode: 'timeline',
  timelinePixelsPerSec: TIMELINE_PPS_DEFAULT,
  timelineSnapEnabled: true,
  pendingCutInSec: null,
  pendingCutOutSec: null,
  // REQ-20260614-001 補遺③ — defaults: outer left=70/right=30 so the
  // Inspector lives in a comfortable right column (~280-320 px at common
  // window sizes) without crushing the preview / table.  Left inner is
  // split 50/50 between preview and the table/timeline body; the user can
  // adjust via the resize handles.  Persisted across navigations within
  // the session.
  step2OuterLayout: { 'step2-pane-left': 70, 'step2-pane-right': 30 },
  step2LeftLayout:  { 'step2-pane-preview': 50, 'step2-pane-bottom': 50 },
  step2TimelineToolsExpanded: false,
  lastTranscriptionWasEmpty: false,

  setSettingsDialogOpen: (open) => set({ isSettingsDialogOpen: open }),
  setAboutDialogOpen: (open) => set({ isAboutDialogOpen: open }),
  setDonationDialogOpen: (open) => set({ isDonationDialogOpen: open }),
  setFontLicensesDialogOpen: (open) => set({ isFontLicensesDialogOpen: open }),
  addOverlay: (id) =>
    set((s) => {
      // Idempotent: re-adding an existing id is a no-op.  StrictMode's
      // double-invoke of effects (setup → cleanup → setup) can add the
      // same id twice in a row; treating it as a no-op keeps the Set
      // truthful ("this overlay is open") without double-counting.
      if (s.overlayIds.has(id)) return {}
      const next = new Set(s.overlayIds)
      next.add(id)
      return { overlayIds: next }
    }),
  removeOverlay: (id) =>
    set((s) => {
      // Idempotent: removing an unknown id is a no-op.  Same StrictMode
      // reason — the initial cleanup of a double-invoked effect removes
      // before the re-setup adds; a stale cleanup after that would find
      // nothing to remove and correctly leave the Set alone.
      if (!s.overlayIds.has(id)) return {}
      const next = new Set(s.overlayIds)
      next.delete(id)
      return { overlayIds: next }
    }),
  setTableFilter: (f) => set({ tableFilter: f }),
  setFocusedRowId: (id) => set({ focusedRowId: id }),
  setSelectedEntryId: (id) => set({ selectedEntryId: id }),
  addRecentColor: (hex) =>
    set((s) => {
      const upper = hex.toUpperCase()
      const filtered = s.recentColors.filter((c) => c.toUpperCase() !== upper)
      return { recentColors: [upper, ...filtered].slice(0, MAX_RECENT_COLORS) }
    }),
  setVideoSeekRequest: (sec) => set({ videoSeekRequestSec: sec }),
  setVideoCurrentTimeSec: (sec) => set({ videoCurrentTimeSec: sec }),
  setVideoPreviewExpanded: (open) => set({ videoPreviewExpanded: open }),
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
  bumpFontInventoryVersion: () =>
    set((s) => ({ fontInventoryVersion: s.fontInventoryVersion + 1 })),
  setEditorViewMode: (m) => set({ editorViewMode: m }),
  setTimelinePixelsPerSec: (v) =>
    set({
      timelinePixelsPerSec: Math.min(
        TIMELINE_PPS_MAX,
        Math.max(TIMELINE_PPS_MIN, v)
      )
    }),
  setTimelineSnapEnabled: (v) => set({ timelineSnapEnabled: v }),
  setPendingCutIn: (sec) => set({ pendingCutInSec: sec }),
  setPendingCutOut: (sec) => set({ pendingCutOutSec: sec }),
  clearPendingCut: () => set({ pendingCutInSec: null, pendingCutOutSec: null }),
  setStep2OuterLayout: (layout) => set({ step2OuterLayout: layout }),
  setStep2LeftLayout:  (layout) => set({ step2LeftLayout: layout }),
  toggleStep2TimelineTools: () =>
    set((s) => ({ step2TimelineToolsExpanded: !s.step2TimelineToolsExpanded })),
  setLastTranscriptionWasEmpty: (v) => set({ lastTranscriptionWasEmpty: v }),
}))

/**
 * REQ-0132 §2.1 / REQ-0137 fix — derived selector reading the overlay
 * id set that every Dialog / Sheet / modal Popover writes to via
 * `useOverlayRegistration`.  Both the shared shortcut handler and the
 * preview panels' Space bindings consume this so context A (any
 * overlay open) is judged the same way everywhere.
 *
 * Migrated from a counter to a Set in REQ-0137 after the counter
 * approach shipped as "true from app boot" — the previous
 * implementation called `useOverlayRegistration()` from the wrapper's
 * function body, so it fired at wrapper-mount (= app boot for every
 * always-rendered Dialog) rather than at Radix Content open.  The new
 * implementation registers inside `<DialogPrimitive.Content>` so it
 * only fires when Radix's Presence actually mounts the Content — i.e.
 * when the dialog is open.
 */
export function isAnyOverlayOpen(s: { overlayIds: ReadonlySet<string> }): boolean {
  return s.overlayIds.size > 0
}
