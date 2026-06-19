import { useState, useMemo, useEffect, useCallback, useLayoutEffect } from 'react'
import { bumpRenderCount } from '@/lib/perf-counter'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, RotateCcw, RotateCw, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { AppShell } from '@/components/app-shell/app-shell'
import { Button } from '@/components/ui/button'
import { SubtitleTable } from '@/components/subtitle-table/subtitle-table'
import { BulkEditBar } from '@/components/subtitle-table/bulk-edit-bar'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { TimeEditorDialog } from '@/components/time-editor-dialog/time-editor-dialog'
import { useProjectStore } from '@/stores/project-store'
import { useSettingsStore } from '@/stores/settings-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore, type TableFilter } from '@/stores/ui-store'
import { cn } from '@/lib/utils'
import { saveFileDialog, writeTextFile } from '@/services/dialog'
import { computeOverflowSync } from '@/lib/overflow-calculator'
import { commitTimeEdit } from '@/lib/commit-time-edit'
import { computeEntryWarnings, hasAnyError, hasAnyWarning, type EntryWarnings } from '@/lib/entry-warnings'
import { applyCutsToEntry, effectiveEntryState, origToEdited } from '../../shared/cuts'
import { filterEntries } from '@/lib/subtitle-filter'
import { loadSubtitleFont, getSubtitleFont, type SubtitleFont } from '@/lib/font-metrics'
// REQ-20260614-001 補遺⑤ — `framer-motion` import retired alongside the
// transient bulk-edit-bar slide-in/out (the bar moved to the right pane).
import type { SubtitleEntry } from '../../shared/types'
import { makeEntryLayoutDefaults } from '../../shared/burnin-defaults'
import { NEW_ROW_DURATION_SEC, ENABLE_VIDEO_PREVIEW } from '../../shared/constants'
import { VideoPreviewPanel } from '@/components/video-preview/video-preview-panel'
import { AudioPreviewPanel } from '@/components/audio-preview/audio-preview-panel'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { EditorViewSwitcher } from '@/components/editor-view-switcher/editor-view-switcher'
import { TimelineView } from '@/components/timeline-view/timeline-view'
import { TimelineBlockInspector } from '@/components/timeline-view/timeline-block-inspector'
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable'
import { useRef } from 'react'

/**
 * REQ-20260614-001 補遺⑥ — per-pane PIXEL minimums.  At the minimum
 * Electron window (1280 × 820 content area, set in main/index.ts), the
 * paneArea ends up roughly:
 *
 *   width  ≈ 1232 px  (1280 minus AppShell's `px-6` = 24 + 24)
 *   height ≈ 628 px   (820 minus breadcrumb 45 + footer 65 + main py-5 40
 *                      + step2 heading row 30 + flex gap-3 12)
 *
 * Each ResizableHandle is 1 px wide, so the panel siblings have:
 *
 *   outer width available  = 1232 - 1 = 1231 px
 *   inner height available = 628 - 1 = 627 px
 *
 * REQ-20260615-007: the per-axis sum of pxMin is tuned to exactly equal
 * that available size so the panels at minimum occupy every remaining
 * pixel.  The trim margin (~3 px) that補遺⑥ originally left for
 * "cross-platform rendering jitter" was the same slack the user was
 * dragging through at startup, so it is removed here.  Combined with the
 * `Math.ceil` rounding in `paneMinPct` below the handle has no sub-pixel
 * play left to absorb.
 *
 * Each ResizablePanel below converts its px-min to a percentage via
 * `paneMinPct(MIN_PX, paneAreaSize.w|h)` so the constraint moves with
 * the container (補遺⑥ §実装方針 #2).
 */
const OUTER_LEFT_MIN_PX   = 863  // 860 → 863: 863 + 368 = 1231 (= 1232 − 1 handle)
const OUTER_RIGHT_MIN_PX  = 368
const LEFT_TOP_MIN_PX     = 313  // 312 → 313: 313 + 314 = 627 (= 628 − 1 handle)
const LEFT_BOTTOM_MIN_PX  = 314  // 312 → 314 (symmetric ±0.5 px from previous)

/**
 * Convert a pixel minimum to a percentage string for ResizablePanel's
 * `minSize` prop.  Falls back to `"0%"` while the container dimension is
 * still 0 (first render before the layout effect commits) so the panes
 * boot at their `defaultLayout` without being clamped against a
 * meaningless divisor.
 *
 * REQ-20260615-007: `Math.ceil` to 2 decimal places (instead of `toFixed`'s
 * banker's rounding) so the percentage always rounds in the
 * sum-towards-100 direction; combined with the bumped pxMin constants
 * above, this leaves no sub-pixel slack at minimum window.  Cap at 99.99
 * so a single panel can never demand ≥ 100% on its own.
 */
function paneMinPct(pxMin: number, containerPx: number): string {
  if (containerPx <= 0) return '0%'
  const pct = (pxMin / containerPx) * 100
  return `${Math.min(99.99, Math.ceil(pct * 100) / 100).toFixed(2)}%`
}

/**
 * State driving the shared TimeEditorDialog.
 *
 * - `add` carries the splice index so confirm knows where to insert.
 * - `edit` carries the entry id so confirm can patch the existing row.
 * Both modes carry pre-computed prev / next adjacent times so the dialog
 * itself stays oblivious to the entries array.
 */
type EditorState =
  | { open: false }
  | {
      open: true
      mode: 'add'
      // No `insertIdx` here: the final position is computed at confirm time
      // from the user-chosen startSec so the dialog never freezes a position
      // that does not match the eventual time-ordered placement.
      initialStartSec: number
      initialEndSec: number
      prevEntryStartSec: number | null
      prevEntryEndSec: number | null
      nextEntryStartSec: number | null
      nextEntryEndSec: number | null
      /** Focused row's startSec at the moment the dialog opened. */
      selectedEntryStartSec: number | null
      /** Focused row's endSec at the moment the dialog opened. */
      selectedEntryEndSec: number | null
    }
  | {
      open: true
      mode: 'edit'
      entryId: string
      initialStartSec: number
      initialEndSec: number
      prevEntryStartSec: number | null
      prevEntryEndSec: number | null
      nextEntryStartSec: number | null
      nextEntryEndSec: number | null
    }

/** Format seconds as SRT timecode: HH:MM:SS,mmm */
function formatSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec % 1) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

/**
 * Build UTF-8 BOM SRT content from subtitle entries (DaVinci Resolve
 * compatible).  The caller is responsible for filtering entries through
 * `isOutputTarget` first — this function blindly serialises everything it
 * is given.
 */
function buildSrtContent(entries: SubtitleEntry[]): string {
  const blocks = entries.map((e, i) => {
    // Convert ASS \N line breaks to real newlines — SRT allows multi-line captions.
    const srtText = e.text.replace(/\\N/g, '\n').trim()
    return `${i + 1}\n${formatSrtTime(e.startSec)} --> ${formatSrtTime(e.endSec)}\n${srtText}`
  })
  // BOM = UTF-8 BOM required by DaVinci Resolve
  return '﻿' + blocks.join('\n\n')
}

interface Step2RouteProps {
  appVersion: string
}


export default function Step2Route({ appVersion }: Step2RouteProps) {
  bumpRenderCount('Step2Route')
  const { t } = useTranslation(['step2', 'common'])
  const navigate = useNavigate()

  const entries = useProjectStore((s) => s.entries)
  // REQ-102: subscribe to cuts so the tab counts (allCount /
  // editedCount / readyCount / warningCount / deletedCount) AND the
  // text/SRT export filter (getOutputEntries) AND the shared
  // filterEntries call below all see the same cut list as the
  // timeline view.  Cuts as a separate layer (REQ-074 §3.3) — we
  // never write back into `entries` from cut confirmation.
  const cuts = useProjectStore((s) => s.cuts)
  const addEntry = useProjectStore((s) => s.addEntry)
  const updateEntry = useProjectStore((s) => s.updateEntry)
  const defaults = useProjectStore((s) => s.defaults)
  const video = useProjectStore((s) => s.video)
  const isAudioOnly = useIsAudioOnly()
  const pushHistory = useHistoryStore((s) => s.push)
  const canUndo = useHistoryStore((s) => s.canUndo)
  const canRedo = useHistoryStore((s) => s.canRedo)
  const undo = useHistoryStore((s) => s.undo)
  const redo = useHistoryStore((s) => s.redo)
  const tableFilter = useUiStore((s) => s.tableFilter)
  const setTableFilter = useUiStore((s) => s.setTableFilter)
  const editorViewMode = useUiStore((s) => s.editorViewMode)
  // REQ-20260614-001 Phase 3 — `selectedEntryId` is the user-driven
  // single selection (row click / block click / add / duplicate / time-
  // edit commit).  `focusedRowId` continues to track the playback-active
  // entry but is no longer the source of truth for "what the user is
  // currently editing".
  const selectedEntryId = useUiStore((s) => s.selectedEntryId)
  const setSelectedEntryId = useUiStore((s) => s.setSelectedEntryId)
  const setScrollToRowId = useUiStore((s) => s.setScrollToRowId)
  // REQ-094 case C: `videoCurrentTimeSec` subscription removed.  The
  // route used to hold this slice solely to forward it to
  // TimeEditorDialog as a prop, which made the whole route re-render
  // on every playhead tick (~50 fps during scrub) and cascaded into
  // VideoPreviewPanel / SubtitleOverlay.  The dialog now subscribes
  // itself (see time-editor-dialog.tsx), so the cascade stops at the
  // dialog boundary and Step2Route stays at 0 renders during scrub.
  const selectedRowIds = useUiStore((s) => s.selectedRowIds)
  const setRowSelection = useUiStore((s) => s.setRowSelection)

  const [editor, setEditor] = useState<EditorState>({ open: false })
  const [discardOpen, setDiscardOpen] = useState(false)
  const [skipDiscardWarning, setSkipDiscardWarning] = useState(false)

  // REQ-20260614-001 補遺③ — 3-pane resizable layout state.  Outer is
  // **horizontal** (left / right); left inner is **vertical** (preview /
  // bottom).  Inspector lives in the right column at full height.
  // `defaultLayout` ↔ `onLayoutChange` round-trip persists the user's
  // adjustments for the session; ResizeObserver drives the small-screen
  // fallback (vertical stack when the pane area is too narrow for the
  // 3-pane to be usable).
  const step2OuterLayout    = useUiStore((s) => s.step2OuterLayout)
  const step2LeftLayout     = useUiStore((s) => s.step2LeftLayout)
  const setStep2OuterLayout = useUiStore((s) => s.setStep2OuterLayout)
  const setStep2LeftLayout  = useUiStore((s) => s.setStep2LeftLayout)

  // REQ-20260614-001 補遺⑥ — measure BOTH width and height of the
  // paneArea so the px → % minSize conversion can keep up with window
  // resize.  At the (newly enforced) minimum window the percentages
  // resolve to ≈100% sum → handles can't move, no slack.  At larger
  // windows the percentages shrink → slack appears and handles become
  // useful again.  The < 600 px stacked fallback was retired in the
  // same補遺⑥ because the Electron window minimum (also 1280×820) makes
  // it unreachable.
  const paneAreaRef = useRef<HTMLDivElement>(null)
  const [paneAreaSize, setPaneAreaSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = paneAreaRef.current
    if (!el) return
    const obs = new ResizeObserver(() => {
      setPaneAreaSize({ w: el.clientWidth, h: el.clientHeight })
    })
    obs.observe(el)
    setPaneAreaSize({ w: el.clientWidth, h: el.clientHeight })
    return () => obs.disconnect()
  }, [])
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const [subtitleFont, setSubtitleFont] = useState<SubtitleFont | null>(getSubtitleFont)

  // Re-load the opentype.js Font whenever the active font selection changes.
  // Clearing first ensures overflowMap recomputes with the new metrics rather
  // than caching against the previous font's widths.
  useEffect(() => {
    setSubtitleFont(null)
    loadSubtitleFont().then(setSubtitleFont).catch(() => {})
  }, [activeFontId])

  // REQ-082: removed Step 2 keyboard shortcuts.
  // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z (undo/redo) — use the toolbar buttons.
  // Ctrl+N (add row) — use the Add button.
  // Ctrl+Shift+L / Ctrl+Shift+T (view switch) — use the view switcher.
  // Ctrl+A (select all visible) — use the table header checkbox.
  // Esc (clear bulk selection) — use the bulk-edit bar's clear button.

  const videoWidthPx = video?.widthPx ?? 1920

  // REQ-029 #3: in audio-only mode, every warning that derives from
  // burn-in physics is meaningless and is suppressed:
  //   - `overflow` (text width > video width) → return an empty map so
  //     no row gets the red-text "はみ出し" treatment and no entry
  //     contributes to the warnings tab count.
  //   - `overDuration` (start/end > video duration) → pass Infinity for
  //     videoDurationSec so the comparison `t > duration` is always
  //     false.  This also suppresses the per-row TimeInput red border
  //     (isStartExceedsDuration / isEndExceedsDuration in the table).
  // Video mode keeps the original checks intact.
  const overflowMap = useMemo(() => {
    const map = new Map<string, number>()
    if (isAudioOnly) return map
    for (const e of entries) {
      if (e.isDeleted) continue
      const r = computeOverflowSync({
        text: e.text,
        fontFamily: 'Noto Sans JP',
        fontSizePx: e.fontSizePx,
        outlineThicknessPx: e.outlineThicknessPx,
        videoWidthPx,
        // Per-row fontId (REQ-021): when set, computeOverflowSync looks
        // up that font's own Font + libassScale instead of falling back
        // to the active selection.  Undefined → row inherits active.
        fontId: e.fontId
      }, subtitleFont)
      if (r.overflowStartIndex !== -1) map.set(e.id, r.overflowStartIndex)
    }
    return map
  }, [entries, videoWidthPx, subtitleFont, isAudioOnly])

  const videoDurationSec = isAudioOnly ? Infinity : (video?.durationSec ?? Infinity)

  /**
   * Per-entry warning flags — single source of truth for the Ready/Warnings
   * tabs, the per-row badges, and the footer summary.  Built in entry order
   * because `overlap` depends on the previous non-deleted entry's end time.
   */
  const warningsMap = useMemo(() => {
    const map = new Map<string, EntryWarnings>()
    let prevEnd: number | null = null
    for (const e of entries) {
      if (e.isDeleted) continue
      const isOverflow = overflowMap.has(e.id)
      map.set(e.id, computeEntryWarnings(e, prevEnd, videoDurationSec, isOverflow))
      prevEnd = e.endSec
    }
    return map
  }, [entries, overflowMap, videoDurationSec])

  // Currently-visible entries under the active filter — drives Ctrl+A's
  // target list and the bulk-selection pruning effect below.
  const visibleEntries = useMemo(
    () => filterEntries(entries, tableFilter, warningsMap, cuts),
    [entries, tableFilter, warningsMap, cuts]
  )
  const visibleEntryIds = useMemo(() => visibleEntries.map((e) => e.id), [visibleEntries])

  // Prune the bulk selection to the intersection with visible rows.
  //
  // Selection is INTENTIONALLY scoped to "what the user can currently
  // see" so a follow-up bulk apply can never affect rows hidden behind a
  // filter the user has since switched away from.  The hidden-selection
  // count UI was retired alongside this rule because there can no
  // longer be any hidden selection.
  //
  // Fires on:
  //   - filter switch (tableFilter changes → visibleEntries recomputes)
  //   - entry mutation that causes a selected row to leave the visible
  //     set (e.g. fixing an empty-text warning row drops it from the
  //     "Warnings" tab)
  // Both reduce to the same dep — visibleEntryIds — so a single effect
  // covers them.
  useEffect(() => {
    if (selectedRowIds.size === 0) return
    const visible = new Set(visibleEntryIds)
    let needsPrune = false
    for (const id of selectedRowIds) {
      if (!visible.has(id)) { needsPrune = true; break }
    }
    if (!needsPrune) return
    const intersection = new Set<string>()
    for (const id of selectedRowIds) {
      if (visible.has(id)) intersection.add(id)
    }
    setRowSelection(intersection)
  }, [visibleEntryIds, selectedRowIds, setRowSelection])

  // REQ-103 — tab counts implement the two-group model from the
  // trimming spec (§6).
  //
  //   行き先 (mutually exclusive — `ready + deleted === all`):
  //     allCount     = every entry, including manually-deleted +
  //                    trim-deleted rows so the inventory is complete.
  //     readyCount   = entries whose status is 'normal' or 'edited'
  //                    (= !effectivelyDeleted).  emptyText rows ARE
  //                    counted here because they still belong to one of
  //                    the two undeleted states; the actual TXT/SRT
  //                    export step in getOutputEntries below filters
  //                    them out at write time.
  //     deletedCount = manuallyDeleted + trimDeleted (= effectivelyDeleted).
  //
  //   フィルタ (cross-cutting — do NOT exclude deleted rows per REQ-103 §B):
  //     editedCount  = `wasEdited` (manual edit OR cut clamp).  A row
  //                    that was edited and later deleted still counts —
  //                    the user wants to see what was edited even if
  //                    the row no longer makes it to the timeline.
  //     warningCount = hasAnyWarning(w).  Same rationale; a warning on
  //                    a deleted row is still informative.
  //
  // effectiveStates is computed once per (entries, cuts) change so
  // each .filter() walk below costs O(N) only.
  const effectiveStates = useMemo(() => {
    const map = new Map<string, ReturnType<typeof effectiveEntryState>>()
    for (const e of entries) map.set(e.id, effectiveEntryState(e, cuts))
    return map
  }, [entries, cuts])
  const allCount      = entries.length
  const readyCount    = entries.filter((e) => {
    const s = effectiveStates.get(e.id)
    return s !== undefined && !s.effectivelyDeleted
  }).length
  const deletedCount  = entries.filter((e) => {
    const s = effectiveStates.get(e.id)
    return s !== undefined && s.effectivelyDeleted
  }).length
  const editedCount   = entries.filter((e) => {
    const s = effectiveStates.get(e.id)
    return s !== undefined && s.wasEdited
  }).length
  // REQ-121 — split the legacy single "warnings" count into errors and
  // warnings.  The "Issues" tab (was: Warnings) shows the union; the
  // continue-to-Step-3 button gates only on errors.  Both counts
  // ignore `effectivelyDeleted` rows because:
  //   - the source `warningsMap` already skips manually-deleted rows
  //     (= `entry.isDeleted` is filtered out at construction time)
  //   - trim-deleted rows (`status === 'trimDeleted'`) never reach the
  //     SRT / burnin pipeline either, so flagging them as "blocking
  //     export" would be misleading
  const errorCount    = entries.filter((e) => {
    const s = effectiveStates.get(e.id)
    if (s === undefined || s.effectivelyDeleted) return false
    const w = warningsMap.get(e.id)
    return w !== undefined && hasAnyError(w)
  }).length
  const warningCount  = entries.filter((e) => {
    const s = effectiveStates.get(e.id)
    if (s === undefined || s.effectivelyDeleted) return false
    const w = warningsMap.get(e.id)
    return w !== undefined && (hasAnyError(w) || hasAnyWarning(w))
  }).length

  // REQ-103 tab order + REQ-121 rename: すべて・出力対象・削除・編集済み・
  // 問題あり.  The two destination tabs come first (left-to-right "where
  // does each clip go") followed by the two cross-cutting filters.  The
  // single "問題あり" tab (= "Issues") covers both errors AND warnings;
  // the badge colour inside the row distinguishes them (REQ-121 §3.4).
  const FILTERS: { key: TableFilter; count: number }[] = [
    { key: 'all',      count: allCount },
    { key: 'ready',    count: readyCount },
    { key: 'deleted',  count: deletedCount },
    { key: 'edited',   count: editedCount },
    { key: 'warnings', count: warningCount },
  ]

  /**
   * Open the TimeEditorDialog in `add` mode.
   *
   * The eventual list position is decided at confirm time from the chosen
   * startSec — see `computeAddInsertion()`.  The focused row only seeds the
   * dialog's initial times and snap targets.
   *
   * Prev/Next snap targets (shown as quick-set buttons in the dialog) — only
   * the rows IMMEDIATELY BEFORE / AFTER the focused row, never the focused
   * row itself:
   *   - prev = active[activeIdx - 1].{start,end}  (null when activeIdx === 0)
   *   - next = active[activeIdx + 1].{start,end}  (null when activeIdx is last)
   *   - No focus → all null → no snap buttons rendered.
   *
   * Initial times: focused row's start/end if a row is selected, 00:00:00.00
   * otherwise.
   */
  function openAddRowDialog() {
    let prevStart: number | null = null
    let prevEnd: number | null = null
    let nextStart: number | null = null
    let nextEnd: number | null = null
    let selectedStart: number | null = null
    let selectedEnd: number | null = null
    let initialStart = 0
    let initialEnd = 0

    // REQ-20260614-001 Phase 3 — prev/next snap targets come from the
    // user's explicit selection, not from playback.  Playback follow
    // (`focusedRowId`) is intentionally ignored here: the user opening
    // the add-row dialog is acting on "the row I clicked", not "the row
    // currently playing".  When no row has been selected yet, all snap
    // targets stay null.
    if (selectedEntryId) {
      const active = entries.filter((e) => !e.isDeleted)
      const activeIdx = active.findIndex((e) => e.id === selectedEntryId)

      if (activeIdx !== -1) {
        if (activeIdx > 0) {
          prevStart = active[activeIdx - 1].startSec
          prevEnd = active[activeIdx - 1].endSec
        }
        if (activeIdx < active.length - 1) {
          nextStart = active[activeIdx + 1].startSec
          nextEnd = active[activeIdx + 1].endSec
        }

        selectedStart = active[activeIdx].startSec
        selectedEnd = active[activeIdx].endSec
        initialStart = selectedStart
        initialEnd = selectedEnd
      }
    }

    setEditor({
      open: true,
      mode: 'add',
      initialStartSec: initialStart,
      initialEndSec: initialEnd,
      prevEntryStartSec: prevStart,
      prevEntryEndSec: prevEnd,
      nextEntryStartSec: nextStart,
      nextEntryEndSec: nextEnd,
      selectedEntryStartSec: selectedStart,
      selectedEntryEndSec: selectedEnd
    })
  }

  /**
   * Open the dialog in `edit` mode for the given existing entry.
   *
   * REQ-071 Phase 3.9 (original): wrapped in useCallback so the function
   * reference stayed stable across re-renders driven by Step2Route's
   * `videoCurrentTimeSec` subscription — Step 2 used to re-render on every
   * playhead tick, so without useCallback every tick produced a fresh
   * `openEditTimeDialog` reference, which propagated into TimelineView's
   * `onAdjustTime` prop, then into every Block as `onAdjustTime`, and
   * defeated `React.memo(Block)`.  REQ-094 case C removed that route-level
   * subscription, so the playback-driven cascade no longer reaches here;
   * the useCallback is still cheap insurance against future props churn.
   */
  const openEditTimeDialog = useCallback((entryId: string) => {
    const fullIdx = entries.findIndex((e) => e.id === entryId)
    if (fullIdx === -1) return
    const entry = entries[fullIdx]

    // For an existing entry, "prev" is the most recent non-deleted entry
    // BEFORE this one, and "next" is the first non-deleted entry AFTER this
    // one — adjacentTimes(fullIdx + 1) would include this entry as prev, so
    // we step around it explicitly.  We capture BOTH startSec and endSec of
    // the prev/next row in a single pass so the four snap buttons (prev start,
    // prev end, next start, next end) can all be rendered from the same row.
    let prevStart: number | null = null
    let prevEnd: number | null = null
    for (let i = fullIdx - 1; i >= 0; i--) {
      if (!entries[i].isDeleted) {
        prevStart = entries[i].startSec
        prevEnd = entries[i].endSec
        break
      }
    }
    let nextStart: number | null = null
    let nextEnd: number | null = null
    for (let i = fullIdx + 1; i < entries.length; i++) {
      if (!entries[i].isDeleted) {
        nextStart = entries[i].startSec
        nextEnd = entries[i].endSec
        break
      }
    }

    setEditor({
      open: true,
      mode: 'edit',
      entryId,
      initialStartSec: entry.startSec,
      initialEndSec: entry.endSec,
      prevEntryStartSec: prevStart,
      prevEntryEndSec: prevEnd,
      nextEntryStartSec: nextStart,
      nextEntryEndSec: nextEnd
    })
  }, [entries])

  function closeEditor() {
    setEditor({ open: false })
  }

  /**
   * Decide where a new row with `newStartSec` should land in the entries array.
   *
   * Rule:  active rows are kept sorted by startSec ascending.  The new row is
   * placed at the first position whose existing startSec is STRICTLY greater
   * than `newStartSec` (so equal-start rows tie-break by being placed AFTER —
   * the new row goes immediately past the last matching row).  If no such
   * active row exists, the new row goes after the last active row.
   *
   * Deleted rows are skipped while searching but their original positions in
   * the full entries array are preserved.  The returned full-array index is
   * what `addEntry()` expects.
   *
   * `visiblePos` is the 1-indexed position the user will SEE in the table —
   * used for the success toast.
   */
  function computeAddInsertion(newStartSec: number): { fullIdx: number; visiblePos: number } {
    const active = entries.filter((e) => !e.isDeleted)
    const afterActiveIdx = active.findIndex((e) => e.startSec > newStartSec)

    if (afterActiveIdx === -1) {
      // No active row has a later startSec — append AFTER the last active row.
      if (active.length === 0) {
        return { fullIdx: entries.length, visiblePos: 1 }
      }
      const lastActiveId = active[active.length - 1].id
      const lastActiveFullIdx = entries.findIndex((e) => e.id === lastActiveId)
      return { fullIdx: lastActiveFullIdx + 1, visiblePos: active.length + 1 }
    }

    // Place BEFORE the first active row whose startSec exceeds the new value.
    const pivotFullIdx = entries.findIndex((e) => e.id === active[afterActiveIdx].id)
    return { fullIdx: pivotFullIdx, visiblePos: afterActiveIdx + 1 }
  }

  function handleEditorConfirm(startSec: number, endSec: number) {
    if (!editor.open) return

    if (editor.mode === 'add') {
      // Position is decided HERE, from the chosen startSec — not from any
      // stale value snapshotted when the dialog opened.
      const { fullIdx: idx, visiblePos } = computeAddInsertion(startSec)
      const base = {
        startSec,
        endSec,
        text: '',
        fontSizePx: defaults.fontSizePx,
        textColorHex: defaults.textColorHex,
        outlineColorHex: defaults.outlineColorHex,
        outlineThicknessPx: defaults.outlineThicknessPx,
        fadeEnabled: defaults.fadeEnabled,
        // REQ-20260613-016 / v1.2.2 機能A: seed per-row layout + background
        // defaults at creation time.  Same pattern as the transcription
        // segment mapping in step1.tsx.
        ...makeEntryLayoutDefaults()
      }
      // REQ-079 #2: collision-resistant id.  Date.now() alone collides
      // when two rows are added within the same millisecond — both rows
      // then share a key in the layout's `trackOf` map, with the later
      // assignment overwriting the earlier, and the timeline blocks
      // render on top of each other.  Matches the cuts uuid pattern in
      // timeline-view.tsx for consistency.
      const id = (typeof crypto !== 'undefined' && 'randomUUID' in crypto)
        ? `new-${crypto.randomUUID()}`
        : `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const newEntry: SubtitleEntry = {
        id,
        ...base,
        isDeleted: false,
        isEdited: true,
        // Deep-copy subtitleBackground so the live entry and original
        // snapshot do not share object identity.
        original: { ...base, subtitleBackground: { ...base.subtitleBackground } }
      }
      pushHistory({
        label: t('history.addRow'),
        undo: () => {
          const s = useProjectStore.getState()
          s.setEntries(s.entries.filter((e) => e.id !== newEntry.id))
        },
        redo: () => addEntry(newEntry, idx)
      })
      addEntry(newEntry, idx)
      // REQ-20260614-001 Phase 3 — select the freshly added row so it
      // gets the green left-border highlight AND becomes the inspector's
      // current entry.  setScrollToRowId still uses the dedicated
      // "deferred + centre" scroll signal so the row lands inside the
      // viewport once framer-motion's entry animation settles.
      setSelectedEntryId(newEntry.id)
      setScrollToRowId(newEntry.id)
      toast.success(t('toast.rowAdded', { index: visiblePos }))
    } else {
      // edit mode
      const target = entries.find((e) => e.id === editor.entryId)
      if (!target) { closeEditor(); return }
      // No-op when neither value changed — avoids polluting history.
      if (target.startSec === startSec && target.endSec === endSec) {
        closeEditor()
        return
      }
      const snapshot = { ...target }
      const patch = { startSec, endSec, isEdited: true }
      pushHistory({
        label: t('history.editTime'),
        undo: () => updateEntry(target.id, snapshot),
        redo: () => updateEntry(target.id, { ...snapshot, ...patch })
      })
      updateEntry(target.id, patch)
      // Time changed → re-sort, focus, scroll.  commitTimeEdit bundles the
      // three side effects (project-store sortByStartSec + ui-store
      // setFocusedRowId + setScrollToRowId) so every time-edit entry point
      // (dialog, inline TimeInput) has identical post-edit behaviour.
      commitTimeEdit(target.id)
    }

    closeEditor()
  }

  /**
   * Entries written to TXT / SRT export.
   *
   * REQ-103 §D: timestamps now go through the same
   *   applyCutsToEntry → origToEdited
   * pipeline that ffmpeg-burnin.ts:133-143 already runs, so the
   * Dialogue Start/End in the rendered video, the SRT cue times,
   * and the TXT row order all agree on the post-cut Edited axis.
   * Previously the SRT / TXT path emitted raw Original-axis times
   * (= REQ-102 RES §8 hand-off item), which placed the cues at
   * wall-clock positions that did not exist in the burnin output —
   * downstream tools (Premiere, Resolve) consuming the SRT against
   * the burnin video saw a constant cumulative-cut offset.
   *
   * Filter chain (mirrors ffmpeg-burnin.ts):
   *   1. Drop `effectivelyDeleted` rows (manual delete + fully-cut).
   *      For fully-cut rows, applyCutsToEntry would also return null
   *      below — but we check effectiveStates first to keep the
   *      manual-delete case explicit.
   *   2. Drop `emptyText` rows (= error, not exportable).
   *   3. Run `applyCutsToEntry` to clamp partial-overlap rows.
   *      Returns null in rare cases (visible duration below
   *      MIN_SUBTITLE_DURATION_SEC after head + tail clamp) —
   *      drop those too.
   *   4. Translate the clamped Original-axis times to Edited axis
   *      via origToEdited.  No cuts → identity, so the legacy
   *      non-trim path is byte-identical.
   *
   * `getOutputEntries` returns NEW SubtitleEntry objects with
   * translated startSec/endSec — the entries in the project store
   * stay untouched (the data-non-destructive contract from REQ-101 /
   * REQ-102).
   */
  function getOutputEntries(): SubtitleEntry[] {
    const out: SubtitleEntry[] = []
    for (const e of entries) {
      const w = warningsMap.get(e.id)
      if (w === undefined) continue
      const s = effectiveStates.get(e.id)
      if (s === undefined || s.effectivelyDeleted) continue
      if (w.emptyText) continue
      const clamped = cuts.length === 0 ? e : applyCutsToEntry(e, cuts)
      if (clamped === null) continue
      out.push({
        ...e,
        startSec: cuts.length === 0 ? e.startSec : origToEdited(clamped.startSec, cuts),
        endSec:   cuts.length === 0 ? e.endSec   : origToEdited(clamped.endSec, cuts),
      })
    }
    return out
  }

  async function handleExportText() {
    const stem = video?.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'transcript'
    const savePath = await saveFileDialog(
      `${stem}_transcript.txt`,
      undefined,
      [
        { name: 'Text File', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    )
    if (!savePath) return
    const content = getOutputEntries()
      // Remove ASS \N line breaks so each entry becomes a single flat line.
      .map((e) => e.text.replace(/\\N/g, '').trim())
      .join('\n')
    await writeTextFile(savePath, content)
    toast.success(t('toast.exported'))
  }

  async function handleExportSrt() {
    const stem = video?.path.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'subtitles'
    const savePath = await saveFileDialog(
      `${stem}_subtitles.srt`,
      undefined,
      [
        { name: 'SRT Subtitle', extensions: ['srt'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    )
    if (!savePath) return
    const content = buildSrtContent(getOutputEntries())
    await writeTextFile(savePath, content)
    toast.success(t('toast.exportedSrt'))
  }

  // REQ-103 — `activeEntries` from REQ-102 was removed in favour of the
  // per-tab counts above; `canContinue` originally read `readyCount`
  // directly (= the 出力対象 count = entries not effectivelyDeleted).
  // REQ-121 — gate the Step 3 transition on `errorCount === 0` too.
  // Pre-REQ-121 the renderer silently dropped error rows in Step 3's
  // `activeEntries` filter; the user could ship a video missing every
  // time-invalid / out-of-duration / invalid-size subtitle without
  // noticing.  The new gate stops at Step 2 with a tooltip pointing to
  // the Issues tab so the user fixes (or knowingly deletes) each error.
  const canContinue = readyCount > 0 && errorCount === 0

  const hasChanges = entries.some((e) => e.isEdited || e.isDeleted)

  function handleBack() {
    if (hasChanges && !skipDiscardWarning) {
      setDiscardOpen(true)
    } else {
      navigate('/step1')
    }
  }

  const footerLeft = (
    <Button variant="ghost" size="md" onClick={handleBack}>
      {t('common:nav.back')}
    </Button>
  )

  const footerCenter = (
    /* REQ-067 phase B: zinc-500 → zinc-300 so the per-step counts
       (edited / warnings / deleted) stay readable at a glance.  The
       inner "selected" span keeps its `text-foreground` accent so the
       active-selection callout still wins visual priority. */
    <span className="text-body-sm text-fg-secondary">
      {selectedRowIds.size > 0 && (
        <>
          <span className="text-foreground">
            {t('footer.selected', { count: selectedRowIds.size })}
          </span>
          {' · '}
        </>
      )}
      {t('footer.summary', {
        edited: editedCount,
        warnings: warningCount,
        deleted: deletedCount
      })}
    </span>
  )

  // REQ-028: export DropdownMenu moved from the page header to the
  // footer, and "Continue to render" hidden in audio mode (no burn-in
  // path).  Audio mode → export is the only footer-right action and
  // ends up right-aligned naturally because nothing else flanks it.
  const footerRight = (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="md">
            {t('action.export')}
            <ChevronDown className="h-3.5 w-3.5 ml-1.5 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={handleExportText}>
            {t('action.exportText')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleExportSrt}>
            {t('action.exportSrt')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!isAudioOnly && (
        // REQ-121 — when the only thing blocking the transition is the
        // errorCount gate, surface a tooltip pointing the user at the
        // Issues tab.  Radix's <TooltipTrigger asChild> on a disabled
        // <button> would swallow pointer events (the disabled DOM node
        // does not fire enter/leave); wrap in a span so the tooltip
        // still appears on hover.
        errorCount > 0 ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="primary"
                  size="md"
                  disabled
                  onClick={() => navigate('/step3')}
                >
                  {t('action.continueToRender')}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t('tooltip.fixErrorsFirst', { count: errorCount })}
            </TooltipContent>
          </Tooltip>
        ) : (
          <Button
            variant="primary"
            size="md"
            disabled={!canContinue}
            onClick={() => navigate('/step3')}
          >
            {t('action.continueToRender')}
          </Button>
        )
      )}
    </div>
  )

  // REQ-20260614-001 Phase 2 — JSX helpers.  Preview / Inspector / Bottom
  // are extracted as small render functions so they can be wired into both
  // the resizable 3-pane layout and the small-screen stacked fallback
  // without duplicating their inner structure.
  const previewSlot = ENABLE_VIDEO_PREVIEW
    ? (isAudioOnly ? <AudioPreviewPanel /> : <VideoPreviewPanel />)
    : null

  // REQ-20260614-001 補遺⑤ — right-pane Inspector now has a fixed
  // heading bar + 3-state body:
  //
  //   • Bulk mode    (selectedRowIds.size > 0)
  //       Heading "一括編集" + BulkEditBar (relocated from above the
  //       table to the right pane).
  //   • Single mode  (selectedRowIds empty AND selectedEntry resolved)
  //       Heading "インスペクタ" + TimelineBlockInspector (per-row
  //       full editor, 補遺③/④ content).
  //   • Empty mode   (no selection at all)
  //       Heading "インスペクタ" + the empty-state placeholder.
  //
  // Priority: bulk > single > empty (per補遺⑤ §C).  Drag commits and
  // playback-follow do NOT switch the panel because they don't touch
  // `selectedRowIds` or `selectedEntryId`.
  const selectedEntry = selectedEntryId === null
    ? null
    : entries.find((e) => e.id === selectedEntryId) ?? null
  const isBulkMode = selectedRowIds.size > 0
  const inspectorHeading = isBulkMode
    ? t('inspector.bulkHeading')
    : t('inspector.heading')
  const inspectorBody = isBulkMode ? (
    <BulkEditBar
      onApplied={(rowCount, label) => {
        toast.success(t('toast.bulkApplied', { count: rowCount, label }), {
          action: {
            label: t('toast.bulkAppliedUndo'),
            onClick: () => {
              useHistoryStore.getState().undo()
            }
          }
        })
      }}
    />
  ) : selectedEntry !== null ? (
    <TimelineBlockInspector
      entry={selectedEntry}
      warnings={warningsMap.get(selectedEntry.id) ?? null}
      onAdjustTime={openEditTimeDialog}
    />
  ) : (
    <div className="flex h-full w-full items-center justify-center p-2 text-center">
      <div className="space-y-1 max-w-xs">
        <p className="text-body-sm text-fg-tertiary">{t('inspector.emptyTitle')}</p>
        <p className="text-caption text-fg-muted">{t('inspector.emptyHint')}</p>
      </div>
    </div>
  )
  const inspectorSlot = (
    <div className="flex h-full w-full flex-col">
      <div className="flex-shrink-0 px-3 py-2 border-b border-line">
        <h2 className="text-callout font-semibold text-fg-secondary">
          {inspectorHeading}
        </h2>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3">
        {inspectorBody}
      </div>
    </div>
  )

  // REQ-20260614-001 補遺② 修正1 — view switcher + filter tabs + undo/redo
  // + add row moved INTO the bottom pane so the operations live next to
  // the list/timeline they affect.
  const toolbarSlot = (
    <div className="flex items-center justify-between flex-shrink-0 px-2 py-1.5 border-b border-line/60">
      <div className="flex items-center gap-2">
        <EditorViewSwitcher />
        <div className="flex items-center gap-1 bg-surface-1 rounded-lg p-1">
          {FILTERS.map(({ key, count }) => (
            <button
              key={key}
              type="button"
              onClick={() => setTableFilter(key)}
              className={cn(
                'h-7 px-3 rounded-md text-body-sm font-medium transition-colors duration-150',
                tableFilter === key
                  ? 'bg-surface-2 text-fg-primary'
                  : 'text-fg-muted hover:text-fg-secondary'
              )}
            >
              {t(`tab.${key}`)} · <span className="tabular-nums">{count}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={!canUndo}
              onClick={() => {
                const label = useHistoryStore.getState().past.at(-1)?.label ?? ''
                undo()
                toast.info(t('toast.undo', { label }))
              }}
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('tooltip.undo')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              disabled={!canRedo}
              onClick={() => {
                const label = useHistoryStore.getState().future.at(0)?.label ?? ''
                redo()
                toast.info(t('toast.redo', { label }))
              }}
            >
              <RotateCw className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('tooltip.redo')}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="md" onClick={openAddRowDialog} data-testid="add-row">
          <Plus className="h-4 w-4 mr-1" />
          {t('action.addRow')}
        </Button>
      </div>
    </div>
  )

  // REQ-20260614-001 補遺⑤ (C) — `bulkBarSlot` is retired here.  The
  // bulk-edit controls were relocated into the right-pane Inspector
  // body (see `inspectorBody` above) — the right pane switches between
  // "bulk edit" (selectedRowIds.size > 0), "single inspector"
  // (selectedEntry !== null), and the empty placeholder.  The list view
  // no longer sprouts a transient horizontal bar above the table.

  // bottomSlot bundles the toolbar + the actual list/timeline body
  // (the bulk-edit bar moved to the right pane in 補遺⑤).
  const bottomSlot = (
    <div className="flex h-full w-full flex-col">
      {toolbarSlot}
      <div className="flex-1 min-h-0">
        {editorViewMode === 'list' ? (
          <SubtitleTable
            overflowMap={overflowMap}
            warningsMap={warningsMap}
            videoDurationSec={videoDurationSec}
            onAdjustTime={openEditTimeDialog}
          />
        ) : (
          <TimelineView
            warningsMap={warningsMap}
            videoDurationSec={videoDurationSec}
          />
        )}
      </div>
    </div>
  )

  return (
    <AppShell
      currentStep={2}
      appVersion={appVersion}
      footerLeft={footerLeft}
      footerCenter={footerCenter}
      footerRight={footerRight}
      noScroll
      fluid
    >
      <div className="flex flex-col h-full gap-3">
        {/* Page header — REQ-075 #1: title + subtitle laid out on a single
            row to reclaim vertical space.  Subtitle keeps its muted tone
            (text-body-sm + zinc-400) but moves to the right of the heading
            with a baseline alignment and a small inset gap.  REQ-028 still
            governs the export DropdownMenu (footer-right). */}
        <div className="flex items-baseline gap-3 flex-shrink-0">
          <h1 className="text-heading font-semibold text-fg-primary">{t('title')}</h1>
          <p className="text-body-sm text-fg-tertiary">{t('subtitle')}</p>
        </div>

        {/* REQ-20260614-001 補遺② 修正1 — view switcher / filter tabs /
            undo/redo / add row / BulkEditBar are now rendered INSIDE the
            bottom pane (see `bottomSlot`), so the toolbar lives next to
            the list/timeline it operates on instead of detached at the
            page top. */}

        {/* REQ-20260614-001 補遺⑥ — variable 3-pane area.
            Outer = HORIZONTAL PanelGroup
              ├── Left (70% default) = VERTICAL PanelGroup
              │     ├── Preview  (50% default)
              │     └── Bottom   (50% default) = toolbar + list/timeline
              └── Right (30% default) = Inspector full height

            minSize: dynamically converted from px → % so px minimums
            travel with the user's window resize.  At the Electron
            minimum window (1280×820, also enforced as the OS-level
            minimum) the percentages resolve to ≈100% sum → handles
            cannot move (the REQ補遺⑥ "余白ゼロ" requirement).  At
            larger windows the percentages shrink → slack appears.

            The < 600-px stacked fallback that used to live here was
            retired in補遺⑥: the OS window minimum prevents the pane
            area from ever shrinking that small. */}
        <div ref={paneAreaRef} className="flex-1 min-h-0 overflow-hidden">
          <ResizablePanelGroup
            direction="horizontal"
            defaultLayout={step2OuterLayout}
            onLayoutChange={(layout) => {
              const left  = layout['step2-pane-left']
              const right = layout['step2-pane-right']
              if (typeof left === 'number' && typeof right === 'number') {
                setStep2OuterLayout({ 'step2-pane-left': left, 'step2-pane-right': right })
              }
            }}
            className="rounded-lg border border-line overflow-hidden"
          >
            <ResizablePanel
              id="step2-pane-left"
              minSize={paneMinPct(OUTER_LEFT_MIN_PX, paneAreaSize.w)}
            >
              <ResizablePanelGroup
                direction="vertical"
                defaultLayout={step2LeftLayout}
                onLayoutChange={(layout) => {
                  const preview = layout['step2-pane-preview']
                  const bottom  = layout['step2-pane-bottom']
                  if (typeof preview === 'number' && typeof bottom === 'number') {
                    setStep2LeftLayout({
                      'step2-pane-preview': preview,
                      'step2-pane-bottom': bottom,
                    })
                  }
                }}
              >
                <ResizablePanel
                  id="step2-pane-preview"
                  minSize={paneMinPct(LEFT_TOP_MIN_PX, paneAreaSize.h)}
                >
                  {previewSlot}
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel
                  id="step2-pane-bottom"
                  minSize={paneMinPct(LEFT_BOTTOM_MIN_PX, paneAreaSize.h)}
                >
                  {bottomSlot}
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              id="step2-pane-right"
              minSize={paneMinPct(OUTER_RIGHT_MIN_PX, paneAreaSize.w)}
            >
              {inspectorSlot}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>

      {/* Shared time-editor modal — driven by `editor` state. */}
      <TimeEditorDialog
        open={editor.open}
        mode={editor.open ? editor.mode : 'add'}
        initialStartSec={editor.open ? editor.initialStartSec : 0}
        initialEndSec={editor.open ? editor.initialEndSec : NEW_ROW_DURATION_SEC}
        prevEntryStartSec={editor.open ? editor.prevEntryStartSec : null}
        prevEntryEndSec={editor.open ? editor.prevEntryEndSec : null}
        nextEntryStartSec={editor.open ? editor.nextEntryStartSec : null}
        nextEntryEndSec={editor.open ? editor.nextEntryEndSec : null}
        // Selected-row snap targets are only meaningful in add mode.
        // In edit mode the row being edited IS the focused row, so setting its
        // own start/end from itself would be a no-op — pass null to hide them.
        selectedEntryStartSec={editor.open && editor.mode === 'add' ? editor.selectedEntryStartSec : null}
        selectedEntryEndSec={editor.open && editor.mode === 'add' ? editor.selectedEntryEndSec : null}
        videoDurationSec={videoDurationSec}
        onConfirm={handleEditorConfirm}
        onCancel={closeEditor}
      />

      {/* Discard changes dialog */}
      <Dialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <DialogContent className="max-w-[400px]">
          <DialogHeader>
            <DialogTitle>{t('common:dialog.discardChanges')}</DialogTitle>
            <DialogDescription>{t('common:dialog.discardChangesDesc')}</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 mt-1">
            <input
              type="checkbox"
              id="skip-discard"
              checked={skipDiscardWarning}
              onChange={(e) => setSkipDiscardWarning(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-surface-4 accent-primary"
            />
            <label htmlFor="skip-discard" className="text-body-sm text-fg-tertiary cursor-pointer">
              {t('common:dialog.dontAskAgain')}
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" size="md" onClick={() => setDiscardOpen(false)}>
              {t('common:action.cancel')}
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={() => {
                setDiscardOpen(false)
                navigate('/step1')
              }}
            >
              {t('common:action.ok')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  )
}
