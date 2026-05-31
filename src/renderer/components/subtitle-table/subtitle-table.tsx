import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, Trash2, Undo2, FileText, Clock } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { TimeInput } from '@/components/time-input'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { type EntryWarnings } from '@/lib/entry-warnings'
import { commitTimeEdit } from '@/lib/commit-time-edit'
import { filterEntries } from '@/lib/subtitle-filter'
import type { SubtitleEntry, RowState } from '../../../shared/types'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, OUTLINE_THICKNESS_MAX_PX } from '../../../shared/constants'

/**
 * 8-column grid template used by both the table header and every row:
 *   1. checkbox column (32px) — multi-row selection for bulk edit
 *   2. row index           (36px)
 *   3. time start/end stack(110px)
 *   4. font size           (64px)
 *   5. per-row style block (220px)
 *   6. text                (flex 1fr)
 *   7. badges              (90px)
 *   8. row actions         (76px)
 */
const TABLE_GRID_COLS = 'grid-cols-[32px_36px_110px_64px_220px_1fr_90px_76px]'

/** Fallback when warningsMap is missing an entry (deleted rows; race with stale memo). */
const NO_WARNINGS: EntryWarnings = {
  timeInvalid: false,
  overDuration: false,
  overlap: false,
  emptyText: false,
  invalidSize: false,
  overflow: false
}

function getRowState(entry: SubtitleEntry, isOverflow: boolean): RowState {
  if (entry.isDeleted) return 'deleted'
  if (isOverflow) return 'overflow'
  if (entry.isEdited) return 'edited'
  return 'normal'
}

interface CellEditorProps {
  value: string
  onCommit: (v: string) => void
  onCancel: () => void
  multiline?: boolean
}

function CellEditor({ value, onCommit, onCancel, multiline }: CellEditorProps) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // Auto-resize textarea height: up to 3 visual lines, then scroll
  useEffect(() => {
    if (!multiline || !ref.current) return
    const el = ref.current
    el.style.height = 'auto'
    const maxH = 72 // ~3 lines at 13px/1.6 line-height + 8px vertical padding
    el.style.height = `${Math.min(el.scrollHeight, maxH)}px`
    el.style.overflowY = el.scrollHeight > maxH ? 'auto' : 'hidden'
  }, [draft, multiline])

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      onCommit(draft)
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  const sharedClass = cn(
    'w-full bg-zinc-800 rounded px-2 py-1 text-[13px] text-zinc-50 resize-none',
    'focus:outline-none'
  )

  if (multiline) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        onBlur={() => onCommit(draft)}
        className={sharedClass}
      />
    )
  }
  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={handleKey}
      onBlur={() => onCommit(draft)}
      className={sharedClass}
    />
  )
}

interface SubtitleRowProps {
  entry: SubtitleEntry
  displayIndex: number
  overflowStartIndex: number
  isFocused: boolean
  onFocus: (id: string) => void
  /** Full warning bitmap for this entry — drives both badges and the Ready filter. */
  warnings: EntryWarnings
  /** Register / unregister the row's DOM element for auto-scroll coordination. */
  registerRef: (id: string, el: HTMLDivElement | null) => void
  /** True when entry.startSec exceeds the video's total duration. */
  isStartExceedsDuration: boolean
  /** True when entry.endSec exceeds the video's total duration. */
  isEndExceedsDuration: boolean
  /** Open the shared time-editor dialog for this entry. */
  onAdjustTime: (entryId: string) => void
  /** Whether this row is part of the bulk-edit selection. */
  isSelected: boolean
  /** Click handler for the row's checkbox — caller decides toggle vs. range. */
  onCheckboxClick: (id: string, shiftKey: boolean) => void
}

function SubtitleRow({ entry, displayIndex, overflowStartIndex, isFocused, onFocus, warnings, registerRef, isStartExceedsDuration, isEndExceedsDuration, onAdjustTime, isSelected, onCheckboxClick }: SubtitleRowProps) {
  const isOverflow = overflowStartIndex !== -1
  const isStartOverlap = warnings.overlap
  const { t } = useTranslation(['step2'])
  const updateEntry = useProjectStore((s) => s.updateEntry)
  const pushHistory = useHistoryStore((s) => s.push)

  const [editingText, setEditingText] = useState(false)
  const [sizeWarning, setSizeWarning] = useState(false)

  // Register this row's DOM element so SubtitleTable can scroll it into view.
  const rowDivRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    registerRef(entry.id, rowDivRef.current)
    return () => registerRef(entry.id, null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id])

  const rowState = getRowState(entry, isOverflow)

  function applyPatch(patch: Partial<SubtitleEntry>) {
    updateEntry(entry.id, { ...patch, isEdited: true })
  }

  function withHistory(label: string, patch: Partial<SubtitleEntry>) {
    const snapshot = { ...entry }
    // Time-affecting patches (startSec / endSec) need a re-sort on undo /
    // redo as well so the row visually lands at the position that matches
    // its restored or re-applied time value.  Non-time patches (text, size,
    // colour, fade) do not affect ordering and skip the resort.
    const affectsTime = 'startSec' in patch || 'endSec' in patch
    pushHistory({
      label,
      undo: () => {
        updateEntry(entry.id, snapshot)
        if (affectsTime) useProjectStore.getState().sortByStartSec()
      },
      redo: () => {
        updateEntry(entry.id, { ...snapshot, ...patch, isEdited: true })
        if (affectsTime) useProjectStore.getState().sortByStartSec()
      }
    })
    applyPatch(patch)
  }

  function handleTextCommit(text: string) {
    setEditingText(false)
    // CellEditor uses real newlines internally; convert back to ASS \N on save.
    const normalized = text.replace(/\n/g, '\\N')
    if (normalized === entry.text) return
    withHistory(t('history.editText'), { text: normalized })
  }

  function handleStartChange(v: number) {
    // TimeInput fires onChange only on commit (Enter / blur), never during
    // typing — so this is always a "user finished typing" event and the
    // re-sort below never interrupts mid-edit.
    if (v === entry.startSec) return
    withHistory(t('history.editTime'), { startSec: v })
    commitTimeEdit(entry.id)
  }

  function handleEndChange(v: number) {
    if (v === entry.endSec) return
    withHistory(t('history.editTime'), { endSec: v })
    commitTimeEdit(entry.id)
  }

  function handleSizeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10)
    setSizeWarning(!isNaN(v) && (v < FONT_SIZE_MIN_PX || v > FONT_SIZE_MAX_PX))
  }

  function handleSizeBlur(e: React.FocusEvent<HTMLInputElement>) {
    setSizeWarning(false)
    const v = parseInt(e.target.value, 10)
    if (isNaN(v) || v < 1) return
    const clamped = Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, v))
    if (clamped === entry.fontSizePx) return
    withHistory(t('history.editSize'), { fontSizePx: clamped })
  }

  function handleTextColorChange(hex: string) {
    withHistory(t('history.editColor'), { textColorHex: hex })
  }

  function handleOutlineColorChange(hex: string) {
    withHistory(t('history.editColor'), { outlineColorHex: hex })
  }

  function handleFadeChange(checked: boolean) {
    withHistory(t('history.editFade'), { fadeEnabled: checked })
  }

  function handleDelete() {
    if (entry.isDeleted) {
      const snapshot = { ...entry }
      pushHistory({
        label: t('history.restoreRow'),
        undo: () => updateEntry(entry.id, snapshot),
        redo: () => updateEntry(entry.id, { ...snapshot, isDeleted: false })
      })
      updateEntry(entry.id, { isDeleted: false })
    } else {
      const snapshot = { ...entry }
      pushHistory({
        label: t('history.deleteRow'),
        undo: () => updateEntry(entry.id, snapshot),
        redo: () => updateEntry(entry.id, { ...snapshot, isDeleted: true })
      })
      updateEntry(entry.id, { isDeleted: true })
    }
  }

  function handleReset() {
    const { original } = entry
    const snapshot = { ...entry }
    // Reset can restore a startSec/endSec that differs from the row's
    // currently-sorted position (e.g. user edited time then reset).  Treat
    // it like a time-affecting patch so the row re-sorts and the user sees
    // it land where the original times sit chronologically.
    const affectsTime = original.startSec !== entry.startSec || original.endSec !== entry.endSec
    pushHistory({
      label: t('history.resetRow'),
      undo: () => {
        updateEntry(entry.id, snapshot)
        if (affectsTime) useProjectStore.getState().sortByStartSec()
      },
      redo: () => {
        updateEntry(entry.id, { ...original, isEdited: false, isDeleted: false })
        if (affectsTime) useProjectStore.getState().sortByStartSec()
      }
    })
    updateEntry(entry.id, { ...original, isEdited: false, isDeleted: false })
    if (affectsTime) commitTimeEdit(entry.id)
  }

  // Multi-row selection takes visual priority over warning tints (amber /
  // red row backgrounds) because the user is actively shaping a bulk
  // operation and needs to see what is targeted.  The focused-row green
  // marker still wins over selection on the left-edge border so single-row
  // focus is never lost in a sea of selected rows.
  const rowBg = cn(
    'group grid items-start gap-0 border-b border-zinc-800/50 transition-colors duration-150',
    TABLE_GRID_COLS,
    isFocused
      ? 'bg-zinc-800/50 border-l-2 border-l-green-500'
      : isSelected
        ? 'border-l-2 border-l-[hsl(var(--row-selected-border))]'
        : 'border-l-2 border-l-transparent',
    !isFocused && !isSelected && 'hover:bg-zinc-800/20',
    rowState === 'deleted' && 'opacity-40',
    !isSelected && rowState === 'edited' && !isFocused && 'bg-amber-400/[0.04]',
    !isSelected && rowState === 'overflow' && !isFocused && 'bg-red-500/[0.04]'
  )

  return (
    <div
      ref={rowDivRef}
      className={rowBg}
      style={
        isSelected && !isFocused
          ? { backgroundColor: 'hsl(var(--row-selected) / var(--row-selected-alpha))' }
          : undefined
      }
      onClick={() => {
        onFocus(entry.id)
        useUiStore.getState().setVideoSeekRequest(entry.startSec)
      }}
      role="row"
      aria-selected={isFocused}
    >
      {/* Selection checkbox — stopPropagation so toggling it does not also
          set focusedRowId / seek the video.  Shift+click handled by the
          parent table (range vs. toggle). */}
      <div
        className="flex items-center justify-center py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={isSelected}
          onClick={(e) => {
            e.stopPropagation()
            onCheckboxClick(entry.id, (e as React.MouseEvent).shiftKey)
          }}
          aria-label={`Select row ${displayIndex}`}
        />
      </div>

      {/* # */}
      <div className="flex items-center justify-center py-3 text-[12px] text-zinc-500 font-mono tabular-nums">
        {displayIndex}
      </div>

      {/* Time */}
      <div className="flex flex-col gap-1 py-2 px-1">
        <TimeInput
          value={entry.startSec}
          onChange={handleStartChange}
          disabled={entry.isDeleted}
          warning={isStartOverlap || isStartExceedsDuration}
          title={isStartExceedsDuration ? t('warning.exceedsDuration') : undefined}
        />
        <div className="w-[90px] text-[12px] text-zinc-600 text-center leading-none select-none">|</div>
        <TimeInput
          value={entry.endSec}
          onChange={handleEndChange}
          disabled={entry.isDeleted}
          warning={isEndExceedsDuration}
          title={isEndExceedsDuration ? t('warning.exceedsDuration') : undefined}
        />
        {/* Adjust-time button — opens the shared modal time editor.
            Hidden for deleted rows since editing a deleted row's time is a no-op. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAdjustTime(entry.id) }}
          disabled={entry.isDeleted}
          className={cn(
            'mt-0.5 flex items-center justify-center gap-1 self-center',
            'h-5 px-1.5 rounded text-[10px] text-zinc-500',
            'hover:bg-zinc-800 hover:text-zinc-200 transition-colors duration-100',
            'disabled:opacity-30 disabled:pointer-events-none'
          )}
        >
          <Clock className="h-3 w-3" />
          {t('action.adjustTime')}
        </button>
      </div>

      {/* Size */}
      <div className="flex items-center py-3 px-1">
        <input
          type="number"
          min={FONT_SIZE_MIN_PX}
          max={FONT_SIZE_MAX_PX}
          defaultValue={entry.fontSizePx}
          key={entry.fontSizePx}
          onChange={handleSizeChange}
          onBlur={handleSizeBlur}
          disabled={entry.isDeleted}
          className={cn(
            'w-full h-7 rounded border bg-zinc-950 px-1 text-center text-[12px] text-zinc-100',
            'focus:outline-none focus:ring-1',
            'disabled:opacity-40 disabled:cursor-not-allowed',
            '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
            sizeWarning
              ? 'border-amber-400/60 focus:ring-amber-400/30'
              : 'border-zinc-800 focus:border-zinc-700 focus:ring-green-500/30'
          )}
        />
      </div>

      {/* Style */}
      <div className="flex flex-col gap-1 py-2 px-1">
        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
          <span className="text-[10px] text-zinc-500 truncate">{t('styleCell.textColor')}</span>
          <ColorPicker value={entry.textColorHex} onChange={handleTextColorChange} disabled={entry.isDeleted} swatchOnly />
        </div>
        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
          <span className="text-[10px] text-zinc-500 truncate">{t('styleCell.outlineColor')}</span>
          <ColorPicker value={entry.outlineColorHex} onChange={handleOutlineColorChange} disabled={entry.isDeleted} swatchOnly />
        </div>
        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
          <span className="text-[10px] text-zinc-500 truncate">{t('styleCell.outlineWidth')}</span>
          <div className={cn(
            'flex rounded overflow-hidden border border-zinc-800',
            entry.isDeleted && 'opacity-40 pointer-events-none'
          )}>
            {Array.from({ length: OUTLINE_THICKNESS_MAX_PX + 1 }, (_, i) => i).map((v) => {
              const clamped = Math.min(OUTLINE_THICKNESS_MAX_PX, Math.max(0, entry.outlineThicknessPx))
              return (
                <button
                  key={v}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    if (v === clamped) return
                    withHistory(t('history.editStroke'), { outlineThicknessPx: v })
                  }}
                  className={cn(
                    // 11 values squeezed into the same cell width; tabular-nums keeps
                    // "1" and "10" the same character width for a tidy row.
                    'flex-1 py-1 text-[10px] tabular-nums transition-colors duration-150',
                    clamped === v
                      ? 'bg-green-500 text-green-950 font-bold'
                      : 'bg-zinc-950 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300'
                  )}
                >
                  {v}
                </button>
              )
            })}
          </div>
        </div>
        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
          <span className="text-[10px] text-zinc-500 truncate">{t('styleCell.fade')}</span>
          <Switch checked={entry.fadeEnabled} onCheckedChange={handleFadeChange} disabled={entry.isDeleted} className="scale-75 origin-left" />
        </div>
      </div>

      {/* Text */}
      <div
        className={cn(
          'flex items-start my-1 py-2 px-2 min-w-0 min-h-[36px] cursor-text rounded transition-all duration-150',
          // Non-editing: always show a subtle inset border (no layout shift vs a real border)
          !editingText && 'shadow-[inset_0_0_0_1px_rgba(63,63,70,0.5)]',
          // Hover: brighten border + light bg
          !editingText && !entry.isDeleted && 'hover:shadow-[inset_0_0_0_1px_rgba(113,113,122,0.5)] hover:bg-zinc-800/30',
          // Editing: green border + bg
          editingText && 'shadow-[inset_0_0_0_1px_rgba(34,197,94,0.5)] bg-zinc-800/20'
        )}
        onClick={(e) => {
          e.stopPropagation()
          onFocus(entry.id)
          useUiStore.getState().setVideoSeekRequest(entry.startSec)
          if (!entry.isDeleted) setEditingText(true)
        }}
      >
        {editingText ? (
          // Convert \N to real newlines for the textarea; handleTextCommit converts back.
          <CellEditor
            value={entry.text.replace(/\\N/g, '\n')}
            onCommit={handleTextCommit}
            onCancel={() => setEditingText(false)}
            multiline
          />
        ) : entry.isDeleted ? (
          <span className="text-[13px] leading-relaxed break-words whitespace-pre-wrap line-clamp-3 line-through text-zinc-500 cursor-text select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        ) : isOverflow ? (
          <span className="text-[13px] leading-relaxed break-words whitespace-pre-wrap line-clamp-3 cursor-text select-text">
            <span className="text-zinc-100">{entry.text.replace(/\\N/g, '\n').slice(0, overflowStartIndex)}</span>
            <span className="text-red-500">{entry.text.replace(/\\N/g, '\n').slice(overflowStartIndex)}</span>
          </span>
        ) : (
          <span className="text-[13px] leading-relaxed break-words whitespace-pre-wrap line-clamp-3 text-zinc-100 cursor-text select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        )}
      </div>

      {/* State — shows all applicable badges simultaneously */}
      <div className="flex flex-wrap items-center gap-1 py-3 px-1">
        {entry.isDeleted && (
          <Badge variant="danger">{t('state.deleted')}</Badge>
        )}
        {!entry.isDeleted && entry.isEdited && (
          <Badge variant="default">{t('state.edited')}</Badge>
        )}
        {!entry.isDeleted && warnings.timeInvalid && (
          <Badge variant="danger">{t('badge.timeInvalid')}</Badge>
        )}
        {!entry.isDeleted && warnings.overlap && (
          /* warning (amber), not danger — overlap is an intentional pattern
             for stacked captions (libass renders both simultaneously) and
             should NOT exclude the row from burn-in.  The amber styling
             tells the user "this works, but heads-up". */
          <Badge variant="warning">{t('badge.overlap')}</Badge>
        )}
        {!entry.isDeleted && warnings.overDuration && (
          <Badge variant="warning">{t('badge.overDuration')}</Badge>
        )}
        {!entry.isDeleted && warnings.overflow && (
          <Badge variant="warning">{t('badge.overflow')}</Badge>
        )}
        {!entry.isDeleted && warnings.emptyText && (
          <Badge variant="warning">{t('badge.emptyText')}</Badge>
        )}
        {!entry.isDeleted && warnings.invalidSize && (
          <Badge variant="warning">{t('badge.invalidSize')}</Badge>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 py-3 px-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        <button
          type="button"
          title={entry.isDeleted ? t('action.restoreRow') : t('action.deleteRow')}
          onClick={(e) => { e.stopPropagation(); handleDelete() }}
          className={cn(
            'flex items-center justify-center h-6 w-6 rounded text-zinc-500 transition-colors duration-150',
            'hover:bg-zinc-800 hover:text-zinc-200',
            entry.isDeleted && 'text-green-500 hover:text-green-400'
          )}
        >
          {entry.isDeleted ? <Undo2 className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          title={t('action.resetRow')}
          onClick={(e) => { e.stopPropagation(); handleReset() }}
          disabled={!entry.isEdited && !entry.isDeleted}
          className={cn(
            'flex items-center justify-center h-6 w-6 rounded text-zinc-500 transition-colors duration-150',
            'hover:bg-zinc-800 hover:text-zinc-200',
            'disabled:opacity-30 disabled:pointer-events-none'
          )}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

/** Milliseconds after a manual scroll during which auto-scroll is suppressed. */
const AUTO_SCROLL_DEBOUNCE_MS = 3000

export function SubtitleTable({
  overflowMap,
  warningsMap,
  videoDurationSec,
  onAdjustTime,
}: {
  /**
   * Where each entry's text overflows (-1 = no overflow).  Required separately
   * from `warningsMap` because the per-row text rendering needs the exact
   * start index to colour the overflowing suffix.
   */
  overflowMap: ReadonlyMap<string, number>
  /** Per-entry warning bitmap; drives the Ready/Warnings filter and badges. */
  warningsMap: ReadonlyMap<string, EntryWarnings>
  /** Video total duration in seconds; Infinity when no video is loaded. */
  videoDurationSec: number
  /** Open the shared time-editor dialog for the given entry. */
  onAdjustTime: (entryId: string) => void
}) {
  const { t } = useTranslation(['step2'])
  const entries = useProjectStore((s) => s.entries)
  const tableFilter = useUiStore((s) => s.tableFilter)
  const focusedRowId = useUiStore((s) => s.focusedRowId)
  const setFocusedRowId = useUiStore((s) => s.setFocusedRowId)
  const scrollToRowId = useUiStore((s) => s.scrollToRowId)
  const setScrollToRowId = useUiStore((s) => s.setScrollToRowId)
  const selectedRowIds = useUiStore((s) => s.selectedRowIds)
  const setRowSelection = useUiStore((s) => s.setRowSelection)
  const toggleRowSelected = useUiStore((s) => s.toggleRowSelected)
  const selectRowRange = useUiStore((s) => s.selectRowRange)

  // Row DOM-element registry for programmatic scrolling.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // Timestamp of the last user-initiated scroll.
  // Auto-scroll is suppressed for AUTO_SCROLL_DEBOUNCE_MS after this.
  const lastUserScrollAt = useRef<number>(0)
  // True while our own scrollIntoView() is executing so handleScroll
  // does not misinterpret it as a user scroll and block the next auto-scroll.
  const isAutoScrollingRef = useRef(false)
  const autoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) {
      rowRefs.current.set(id, el)
    } else {
      rowRefs.current.delete(id)
    }
  }, [])

  // Auto-scroll the focused row into view when focusedRowId changes.
  // Suppressed while the user is actively scrolling the table manually.
  useEffect(() => {
    if (!focusedRowId) return
    if (Date.now() - lastUserScrollAt.current < AUTO_SCROLL_DEBOUNCE_MS) return
    const el = rowRefs.current.get(focusedRowId)
    if (!el) return
    // Mark auto-scroll in progress so handleScroll ignores the scroll event
    // that scrollIntoView() itself fires (which would otherwise reset the
    // debounce timer and block the *next* auto-scroll for 3 seconds).
    if (autoScrollTimerRef.current !== null) clearTimeout(autoScrollTimerRef.current)
    isAutoScrollingRef.current = true
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    autoScrollTimerRef.current = setTimeout(() => {
      isAutoScrollingRef.current = false
      autoScrollTimerRef.current = null
    }, 600)
  }, [focusedRowId])

  function handleScroll() {
    // Skip scroll events that originate from our own scrollIntoView() calls.
    if (isAutoScrollingRef.current) return
    lastUserScrollAt.current = Date.now()
  }

  // Explicit "scroll this row into view" request — set by step2 after the
  // user confirms an add or time-edit in the TimeEditorDialog.
  //
  // Separate from `focusedRowId` because new rows are inserted with
  // `framer-motion` entry animation (height: 0 → auto over 150ms); calling
  // `scrollIntoView` immediately while the row is still height:0 lets the
  // browser compute a position that is wrong by the time the animation
  // settles, so the viewport ends up in the wrong place (or doesn't move at
  // all).  We defer the scroll past the animation, then use `block: 'center'`
  // so the row is brought well inside the viewport rather than just to the
  // nearest edge.
  //
  // Lifecycle guarantees (per spec):
  //   - Timer is cleared on unmount via cleanup → no scrollIntoView fires on
  //     an unmounted component.
  //   - scrollToRowId is set to null only AFTER the timer fires, so leaving
  //     Step 2 within the 200ms window simply drops the request (cleanup
  //     cancels the timer; null isn't written; next mount will see the stale
  //     id but the `if (el)` check skips when the row is missing).
  //   - The post-consumption null write prevents re-firing if other state
  //     changes cause a re-render before the timer.
  useEffect(() => {
    if (!scrollToRowId) return
    const targetId = scrollToRowId
    const timer = setTimeout(() => {
      const el = rowRefs.current.get(targetId)
      if (el) {
        // Coordinate with the focus-based debounce so our own scroll event
        // is not mistaken for a manual scroll (which would suppress the next
        // auto-scroll for 3 seconds).
        if (autoScrollTimerRef.current !== null) clearTimeout(autoScrollTimerRef.current)
        isAutoScrollingRef.current = true
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        autoScrollTimerRef.current = setTimeout(() => {
          isAutoScrollingRef.current = false
          autoScrollTimerRef.current = null
        }, 600)
      }
      setScrollToRowId(null)
    }, 200)
    return () => clearTimeout(timer)
  }, [scrollToRowId, setScrollToRowId])

  const filtered = filterEntries(entries, tableFilter, warningsMap)

  const emptyKey =
    tableFilter === 'all'      ? 'empty.all'      :
    tableFilter === 'ready'    ? 'empty.ready'    :
    tableFilter === 'edited'   ? 'empty.edited'   :
    tableFilter === 'warnings' ? 'empty.warnings' :
    'empty.deleted'

  const headerCols = cn(
    'grid border-b border-zinc-800 bg-zinc-900 sticky top-0 z-10',
    TABLE_GRID_COLS
  )

  // Visible-row order is the authoritative input for both Shift+click range
  // selection and the header "select all" checkbox.  Memoised so callbacks
  // closing over it don't see a fresh array every render.
  const visibleIds = useMemo(() => filtered.map((e) => e.id), [filtered])

  // Header checkbox state — three values:
  //   - true            : every visible row is selected
  //   - false           : no visible row is selected
  //   - 'indeterminate' : some visible rows are selected
  // Selection retention across filters means selectedRowIds can contain rows
  // that aren't currently visible; the header only reflects the *visible*
  // subset so clicking it produces a deterministic outcome for what the user
  // can see.
  const visibleSelectedCount = useMemo(() => {
    let n = 0
    for (const id of visibleIds) if (selectedRowIds.has(id)) n++
    return n
  }, [visibleIds, selectedRowIds])
  const headerCheckState: boolean | 'indeterminate' =
    visibleSelectedCount === 0
      ? false
      : visibleSelectedCount === visibleIds.length
        ? true
        : 'indeterminate'

  function handleHeaderCheckboxClick() {
    // Toggle semantics:
    //   - any visible row selected → clear visible rows from selection
    //     (rows hidden by the filter are intentionally preserved)
    //   - no visible row selected  → add all visible rows to selection
    if (visibleSelectedCount > 0) {
      const next = new Set(selectedRowIds)
      for (const id of visibleIds) next.delete(id)
      setRowSelection(next)
    } else {
      const next = new Set(selectedRowIds)
      for (const id of visibleIds) next.add(id)
      setRowSelection(next)
    }
  }

  function handleRowCheckboxClick(id: string, shiftKey: boolean) {
    if (shiftKey) selectRowRange(id, visibleIds)
    else toggleRowSelected(id)
  }

  return (
    <div className="flex flex-col h-full">
      <div className={headerCols}>
        <div
          className="flex items-center justify-center py-2"
          onClick={(e) => e.stopPropagation()}
        >
          <Checkbox
            checked={headerCheckState}
            onClick={(e) => { e.stopPropagation(); handleHeaderCheckboxClick() }}
            aria-label={t('table.selectAllAria')}
          />
        </div>
        <div className="py-2 px-1 text-[11px] font-medium text-zinc-500 text-center">{t('table.colIndex')}</div>
        <div className="py-2 px-1 text-[11px] font-medium text-zinc-500">{t('table.colTime')}</div>
        <div className="py-2 px-1 text-[11px] font-medium text-zinc-500">{t('table.colSize')}</div>
        <div className="py-2 px-1 text-[11px] font-medium text-zinc-500">{t('table.colStyle')}</div>
        <div className="py-2 px-2 text-[11px] font-medium text-zinc-500">{t('table.colText')}</div>
        <div className="py-2 px-1 text-[11px] font-medium text-zinc-500">{t('table.colState')}</div>
        <div className="py-2 px-1 text-[11px] font-medium text-zinc-500">{t('table.colActions')}</div>
      </div>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center gap-3 py-16"
          >
            <FileText className="h-8 w-8 text-zinc-700" />
            <p className="text-[13px] font-medium text-zinc-400">{t(emptyKey)}</p>
          </motion.div>
        ) : (
          <AnimatePresence initial={false}>
            {filtered.map((entry, i) => (
              <motion.div
                key={entry.id}
                layout
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                style={{ overflow: 'hidden' }}
              >
                <SubtitleRow
                  entry={entry}
                  displayIndex={i + 1}
                  overflowStartIndex={overflowMap.get(entry.id) ?? -1}
                  isFocused={focusedRowId === entry.id}
                  onFocus={setFocusedRowId}
                  warnings={warningsMap.get(entry.id) ?? NO_WARNINGS}
                  registerRef={registerRef}
                  isStartExceedsDuration={entry.startSec > videoDurationSec}
                  isEndExceedsDuration={entry.endSec > videoDurationSec}
                  onAdjustTime={onAdjustTime}
                  isSelected={selectedRowIds.has(entry.id)}
                  onCheckboxClick={handleRowCheckboxClick}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
