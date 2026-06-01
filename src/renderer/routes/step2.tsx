import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Plus, RotateCcw, RotateCw, ChevronDown } from 'lucide-react'
import { useHotkeys } from 'react-hotkeys-hook'
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
import { computeEntryWarnings, hasAnyWarning, isOutputTarget, type EntryWarnings } from '@/lib/entry-warnings'
import { filterEntries } from '@/lib/subtitle-filter'
import { loadSubtitleFont, getSubtitleFont, type SubtitleFont } from '@/lib/font-metrics'
import { AnimatePresence, motion } from 'framer-motion'
import type { SubtitleEntry } from '../../shared/types'
import { NEW_ROW_DURATION_SEC, ENABLE_VIDEO_PREVIEW } from '../../shared/constants'
import { VideoPreviewPanel } from '@/components/video-preview/video-preview-panel'

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
  const { t } = useTranslation(['step2', 'common'])
  const navigate = useNavigate()

  const entries = useProjectStore((s) => s.entries)
  const addEntry = useProjectStore((s) => s.addEntry)
  const updateEntry = useProjectStore((s) => s.updateEntry)
  const defaults = useProjectStore((s) => s.defaults)
  const video = useProjectStore((s) => s.video)
  const pushHistory = useHistoryStore((s) => s.push)
  const canUndo = useHistoryStore((s) => s.canUndo)
  const canRedo = useHistoryStore((s) => s.canRedo)
  const undo = useHistoryStore((s) => s.undo)
  const redo = useHistoryStore((s) => s.redo)
  const tableFilter = useUiStore((s) => s.tableFilter)
  const setTableFilter = useUiStore((s) => s.setTableFilter)
  const focusedRowId = useUiStore((s) => s.focusedRowId)
  const setFocusedRowId = useUiStore((s) => s.setFocusedRowId)
  const setScrollToRowId = useUiStore((s) => s.setScrollToRowId)
  const videoCurrentTimeSec = useUiStore((s) => s.videoCurrentTimeSec)
  const selectedRowIds = useUiStore((s) => s.selectedRowIds)
  const setRowSelection = useUiStore((s) => s.setRowSelection)
  const clearRowSelection = useUiStore((s) => s.clearRowSelection)

  const [editor, setEditor] = useState<EditorState>({ open: false })
  const [discardOpen, setDiscardOpen] = useState(false)
  const [skipDiscardWarning, setSkipDiscardWarning] = useState(false)
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const [subtitleFont, setSubtitleFont] = useState<SubtitleFont | null>(getSubtitleFont)

  // Re-load the opentype.js Font whenever the active font selection changes.
  // Clearing first ensures overflowMap recomputes with the new metrics rather
  // than caching against the previous font's widths.
  useEffect(() => {
    setSubtitleFont(null)
    loadSubtitleFont().then(setSubtitleFont).catch(() => {})
  }, [activeFontId])

  useHotkeys('ctrl+z', (e) => {
    e.preventDefault()
    const label = useHistoryStore.getState().past.at(-1)?.label ?? ''
    undo()
    toast.info(t('toast.undo', { label }))
  }, { enableOnFormTags: false })
  useHotkeys('ctrl+y', (e) => {
    e.preventDefault()
    const label = useHistoryStore.getState().future.at(0)?.label ?? ''
    redo()
    toast.info(t('toast.redo', { label }))
  }, { enableOnFormTags: false })
  useHotkeys('ctrl+shift+z', (e) => { e.preventDefault(); redo() }, { enableOnFormTags: false })
  useHotkeys('ctrl+n', (e) => { e.preventDefault(); openAddRowDialog() }, { enableOnFormTags: false })
  // Ctrl+A — select every row currently visible under the active filter.
  // Intentionally additive: rows hidden by the filter that were already
  // selected stay selected, matching how the table-header checkbox behaves.
  useHotkeys('ctrl+a', (e) => {
    e.preventDefault()
    const next = new Set(selectedRowIds)
    for (const id of visibleEntryIds) next.add(id)
    setRowSelection(next)
  }, { enableOnFormTags: false })
  // Esc clears the bulk-edit selection when one exists.  Yields to the
  // browser/native handlers when nothing is selected, so dialogs and
  // inputs keep their own Esc behaviour.
  useHotkeys('escape', () => {
    if (selectedRowIds.size > 0) clearRowSelection()
  }, { enableOnFormTags: false })

  const videoWidthPx = video?.widthPx ?? 1920

  const overflowMap = useMemo(() => {
    const map = new Map<string, number>()
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
  }, [entries, videoWidthPx, subtitleFont])

  const videoDurationSec = video?.durationSec ?? Infinity

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
    () => filterEntries(entries, tableFilter, warningsMap),
    [entries, tableFilter, warningsMap]
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

  const activeEntries = entries.filter((e) => !e.isDeleted)
  const allCount      = activeEntries.length
  const editedCount   = activeEntries.filter((e) => e.isEdited).length
  // Ready (= "出力対象") aligns with text-export inclusion: warning rows are
  // counted (the user may want to export and fix externally), error rows
  // (emptyText, deleted) are dropped.  See `isOutputTarget` / `hasAnyWarning`
  // in entry-warnings.ts for the canonical rules.
  const warningCount  = activeEntries.filter((e) => {
    const w = warningsMap.get(e.id)
    return w !== undefined && hasAnyWarning(w)
  }).length
  const readyCount    = activeEntries.filter((e) => {
    const w = warningsMap.get(e.id)
    return w !== undefined && isOutputTarget(e, w)
  }).length
  const deletedCount  = entries.filter((e) => e.isDeleted).length

  const FILTERS: { key: TableFilter; count: number }[] = [
    { key: 'all',      count: allCount },
    { key: 'ready',    count: readyCount },
    { key: 'edited',   count: editedCount },
    { key: 'warnings', count: warningCount },
    { key: 'deleted',  count: deletedCount },
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

    if (focusedRowId) {
      const active = entries.filter((e) => !e.isDeleted)
      const activeIdx = active.findIndex((e) => e.id === focusedRowId)

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

  /** Open the dialog in `edit` mode for the given existing entry. */
  function openEditTimeDialog(entryId: string) {
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
  }

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
        fadeEnabled: defaults.fadeEnabled
      }
      const newEntry: SubtitleEntry = {
        id: `new-${Date.now()}`,
        ...base,
        isDeleted: false,
        isEdited: true,
        original: { ...base }
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
      // Focus the freshly added row (green left border highlight) and
      // explicitly request that SubtitleTable scroll it into view.  The
      // dedicated scroll signal defers until after framer-motion's entry
      // animation settles, so the viewport ends up centred on the new row
      // even when it lands far from the previous scroll position.
      setFocusedRowId(newEntry.id)
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
   * Entries written to TXT / SRT export.  Matches the Ready tab count —
   * warnings included, errors (empty text, deleted) excluded.  See
   * `isOutputTarget` in entry-warnings.ts.
   */
  function getOutputEntries(): SubtitleEntry[] {
    return entries.filter((e) => {
      const w = warningsMap.get(e.id)
      return w !== undefined && isOutputTarget(e, w)
    })
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

  const canContinue = activeEntries.length > 0

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
    <span className="text-[12px] text-zinc-500">
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

  const footerRight = (
    <Button
      variant="primary"
      size="md"
      disabled={!canContinue}
      onClick={() => navigate('/step3')}
    >
      {t('action.continueToRender')}
    </Button>
  )

  return (
    <AppShell
      currentStep={2}
      appVersion={appVersion}
      footerLeft={footerLeft}
      footerCenter={footerCenter}
      footerRight={footerRight}
      noScroll
    >
      <div className="flex flex-col h-full gap-3">
        {/* Page header */}
        <div className="flex items-start justify-between flex-shrink-0">
          <div>
            <h1 className="text-[18px] font-semibold text-zinc-50">{t('title')}</h1>
            <p className="mt-0.5 text-[13px] text-zinc-400">{t('subtitle')}</p>
          </div>
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
        </div>

        {/* D-1: Video preview panel — remove this block (or set ENABLE_VIDEO_PREVIEW=false) to revert */}
        {ENABLE_VIDEO_PREVIEW && <VideoPreviewPanel />}

        {/* Filter tabs + Add Row button */}
        <div className="flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-1 bg-zinc-900 rounded-lg p-1">
            {FILTERS.map(({ key, count }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTableFilter(key)}
                className={cn(
                  'h-7 px-3 rounded-md text-[12px] font-medium transition-colors duration-150',
                  tableFilter === key
                    ? 'bg-zinc-800 text-zinc-50'
                    : 'text-zinc-500 hover:text-zinc-300'
                )}
              >
                {t(`tab.${key}`)} · <span className="tabular-nums">{count}</span>
              </button>
            ))}
          </div>

          {/* Undo / Redo + Add Row — right side of the filter row */}
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

          {/* Add Row button — opens the shared TimeEditorDialog in add mode. */}
          <Button variant="ghost" size="md" onClick={openAddRowDialog}>
            <Plus className="h-4 w-4 mr-1" />
            {t('action.addRow')}
          </Button>
          </div>
        </div>

        {/* Bulk-edit bar — slides in above the table when rows are selected.
            AnimatePresence keeps the slide-out animation when the user
            clears the selection so the table doesn't visually jump. */}
        <AnimatePresence initial={false}>
          {selectedRowIds.size > 0 && (
            <motion.div
              key="bulk-edit-bar"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              style={{ overflow: 'hidden' }}
              className="flex-shrink-0"
            >
              <BulkEditBar
                onApplied={(rowCount, label) => {
                  // Surface a one-click undo affordance.  Reads the freshest
                  // history op so even if state changed between render and
                  // toast click (unlikely but possible), we still undo the
                  // op we just registered.
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
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table — fills remaining height */}
        <div className="flex-1 min-h-0 rounded-lg border border-zinc-800 overflow-hidden">
          <SubtitleTable
            overflowMap={overflowMap}
            warningsMap={warningsMap}
            videoDurationSec={videoDurationSec}
            onAdjustTime={openEditTimeDialog}
          />
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
        videoCurrentTimeSec={ENABLE_VIDEO_PREVIEW ? videoCurrentTimeSec : null}
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
              className="h-3.5 w-3.5 rounded border-zinc-600 accent-green-500"
            />
            <label htmlFor="skip-discard" className="text-[12px] text-zinc-400 cursor-pointer">
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
