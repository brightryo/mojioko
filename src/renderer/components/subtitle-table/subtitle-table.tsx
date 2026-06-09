import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Eraser, Trash2, Undo2, FileText, Clock, ChevronUp, ChevronDown, WrapText } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { TimeInput } from '@/components/time-input'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { RowFontSelector } from '@/components/subtitle-table/row-font-selector'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import type { FontId } from '../../../shared/fonts'
import { type EntryWarnings } from '@/lib/entry-warnings'
import { commitTimeEdit } from '@/lib/commit-time-edit'
import { filterEntries } from '@/lib/subtitle-filter'
import { autoLineBreakRow as runAutoLineBreakRow, resetRow as runResetRow, toggleDeleteRow as runToggleDeleteRow } from '@/lib/entry-row-actions'
import type { SubtitleEntry, RowState } from '../../../shared/types'
import { effectiveEntryState, type ClipStatus, type CutList } from '../../../shared/cuts'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'

/** Step amount for the per-row size ↑/↓ buttons (REQ-039 #4). */
const SIZE_STEP_PX = 10

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
// REQ-068 Phase C: time column 110 → 130 to fit the widened TimeInput
// (w-[110px]) needed after bumping all time text to 13 px (was 12).
const TABLE_GRID_COLS = 'grid-cols-[32px_36px_130px_64px_220px_1fr_90px_76px]'

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
  multiline?: boolean
}

function CellEditor({ value, onCommit, multiline }: CellEditorProps) {
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

  // REQ-082: Ctrl+Enter / Esc removed.  onBlur (= click elsewhere or
  // Tab away) still commits the typed value.

  const sharedClass = cn(
    'w-full bg-zinc-800 rounded px-2 py-1 text-body text-zinc-50 resize-none',
    'focus:outline-none'
  )

  if (multiline) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        onChange={(e) => setDraft(e.target.value)}
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
  /**
   * REQ-103 — the row's 4-state classification (`normal` / `edited` /
   * `manuallyDeleted` / `trimDeleted`).  Drives the primary status
   * badge so the trim-deleted case is visually distinct from a
   * manual delete (the two used to share the `state.deleted`
   * badge).  Computed by the parent so the per-row component does
   * not need its own `cuts` subscription.
   */
  clipStatus: ClipStatus
  /**
   * REQ-115 — current cut list, forwarded to the row's TimeInputs so
   * the displayed timecode is on the EDITED axis (= matches the SRT
   * export, ruler, and video preview).  Stored as the SubtitleEntry
   * value remains on the Original axis; the input applies
   * `editedToOrig` on commit so persistence is unchanged.
   */
  cuts: CutList
}

function SubtitleRow({ entry, displayIndex, overflowStartIndex, isFocused, onFocus, warnings, registerRef, isStartExceedsDuration, isEndExceedsDuration, onAdjustTime, isSelected, onCheckboxClick, clipStatus, cuts }: SubtitleRowProps) {
  const isOverflow = overflowStartIndex !== -1
  const isStartOverlap = warnings.overlap
  // step1 namespace included so the size input's `title` tooltip can
  // reuse the `subtitleDefaults.sizeHint` string defined for STEP 1's
  // Subtitle Style dialog (REQ-034 #3).
  const { t } = useTranslation(['step2', 'step1'])
  const updateEntry = useProjectStore((s) => s.updateEntry)
  const pushHistory = useHistoryStore((s) => s.push)
  // REQ-028: in audio-only mode the size / style / font cells render
  // empty so the 8-column grid stays in place (col widths unchanged)
  // but the style controls are visually + functionally suppressed.
  const isAudioOnly = useIsAudioOnly()

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
  // REQ-118 [2] — trim-deleted entries are frozen by spec §2.1.  Mirror
  // the existing `entry.isDeleted` lockout (manual delete) so every
  // editable affordance respects the same "no edits" rule for both
  // deletion states.  The flag is read by every disabled-prop below and
  // by the Restore / Delete button branch.
  const isTrimDeleted = clipStatus === 'trimDeleted'
  const isFrozen = entry.isDeleted || isTrimDeleted

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

  // REQ-039 #4: ±SIZE_STEP_PX bump buttons.  Clamp to the same
  // [FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX] range used by the typed-input
  // blur handler so all three entry paths (typing, ↑, ↓) commit values
  // inside the documented bounds.  Bumps that would land on the current
  // value (already at limit) early-return so undo history stays clean.
  function handleSizeBump(delta: number) {
    const next = Math.min(
      FONT_SIZE_MAX_PX,
      Math.max(FONT_SIZE_MIN_PX, entry.fontSizePx + delta)
    )
    if (next === entry.fontSizePx) return
    withHistory(t('history.editSize'), { fontSizePx: next })
  }

  function handleTextColorChange(hex: string) {
    withHistory(t('history.editColor'), { textColorHex: hex })
  }

  // Per-row fontId change (REQ-022 step 1).  `undefined` clears the
  // override so the row falls back to the project default.  Snapshot via
  // withHistory writes the entire prior entry, so undo restores the
  // previous fontId (including back to undefined) and the entry.isEdited
  // flag also lifts in tandem with the other style edits.
  //
  // Mirrors handleReset's explicit `fontId: original.fontId` trick: a
  // patch object whose `fontId` property is `undefined` is required for
  // the updateEntry merge to actually clear the key, since a missing
  // property would leave the previous override in place.
  function handleFontChange(next: FontId | undefined) {
    if (next === entry.fontId) return
    withHistory(t('history.editFont'), { fontId: next })
  }

  function handleOutlineColorChange(hex: string) {
    withHistory(t('history.editColor'), { outlineColorHex: hex })
  }

  function handleFadeChange(checked: boolean) {
    withHistory(t('history.editFade'), { fadeEnabled: checked })
  }

  // Row-level Delete / Reset / AutoLineBreak go through the shared
  // `entry-row-actions` lib so the timeline-block inspector drives the
  // exact same history shape, sort behaviour, and side effects.  Labels
  // are resolved here at the call site because the lib is intentionally
  // i18n-free (see entry-row-actions.ts docstring).
  function handleDelete() {
    runToggleDeleteRow(entry, {
      delete: t('history.deleteRow'),
      restore: t('history.restoreRow')
    })
  }

  async function handleAutoLineBreakRow() {
    await runAutoLineBreakRow(entry, {
      history: t('history.autoLineBreak'),
      noChangeToast: t('bulk.autoLineBreakNoChange')
    })
  }

  function handleReset() {
    runResetRow(entry, { reset: t('history.resetRow') })
  }

  // Multi-row selection takes visual priority over warning tints (amber /
  // red row backgrounds) because the user is actively shaping a bulk
  // operation and needs to see what is targeted.  The focused-row green
  // marker still wins over selection on the left-edge border so single-row
  // focus is never lost in a sea of selected rows.
  const rowBg = cn(
    'group grid items-start gap-0 border-b border-zinc-800/50 transition-colors duration-150',
    TABLE_GRID_COLS,
    // REQ-118 [1] — the focused-row green tint used to win over the
    // edited (amber) / overflow (red) state tint, hiding the row state
    // the moment the user clicked it.  Split focus into "always-show"
    // (= green left border) and "neutral fill" (= zinc-800/50 ONLY when
    // no state tint is present), so amber / red rows keep showing
    // their state colour while focused.
    isFocused
      ? 'border-l-2 border-l-green-500'
      : isSelected
        ? 'border-l-2 border-l-[hsl(var(--row-selected-border))]'
        : 'border-l-2 border-l-transparent',
    isFocused && rowState !== 'edited' && rowState !== 'overflow' && 'bg-zinc-800/50',
    !isFocused && !isSelected && 'hover:bg-zinc-800/20',
    // REQ-117 [1] — fade every cell EXCEPT the actions column so the
    // Restore / Reset buttons that the user CAN click never look like
    // they are disabled.  Previously `opacity-40` was applied to the
    // whole row, and CSS opacity cannot be re-set higher on a child,
    // so the actually-clickable affordances looked muted.  The actions
    // cell carries `data-row-actions` and is matched out via the
    // arbitrary `:not()` selector.
    rowState === 'deleted' && '[&>*:not([data-row-actions])]:opacity-40',
    // REQ-118 [1] — the previous `!isFocused` gate erased the amber /
    // red tint as soon as the row was selected.  Drop it: state tints
    // now persist through focus + selection (they layer under the
    // green left-border and the selection chrome).
    !isSelected && rowState === 'edited' && 'bg-amber-400/[0.04]',
    !isSelected && rowState === 'overflow' && 'bg-red-500/[0.04]'
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
          parent table (range vs. toggle).
          REQ-119 [1] — frozen rows (manual-delete OR trim-delete) cannot
          enter the bulk-edit selection.  The disabled checkbox is the
          first line of defence; the parent's "select all" and the
          bulk-edit-bar apply paths apply the same `isFrozen` filter as
          belt-and-braces (= even a programmatic selection cannot reach
          a frozen row). */}
      <div
        className="flex items-center justify-center py-3"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={isSelected}
          disabled={isFrozen}
          onClick={(e) => {
            e.stopPropagation()
            if (isFrozen) return
            onCheckboxClick(entry.id, (e as React.MouseEvent).shiftKey)
          }}
          aria-label={`Select row ${displayIndex}`}
        />
      </div>

      {/* # */}
      <div className="flex items-center justify-center py-3 text-body-sm text-zinc-500 font-mono tabular-nums">
        {displayIndex}
      </div>

      {/* Time */}
      <div className="flex flex-col gap-1 py-2 px-1">
        <TimeInput
          value={entry.startSec}
          cuts={cuts}
          onChange={handleStartChange}
          disabled={isFrozen}
          warning={isStartOverlap || isStartExceedsDuration}
          title={isStartExceedsDuration ? t('warning.exceedsDuration') : undefined}
        />
        <div className="w-[90px] text-body-sm text-zinc-600 text-center leading-none select-none">|</div>
        <TimeInput
          value={entry.endSec}
          cuts={cuts}
          onChange={handleEndChange}
          disabled={isFrozen}
          warning={isEndExceedsDuration}
          title={isEndExceedsDuration ? t('warning.exceedsDuration') : undefined}
        />
        {/* Adjust-time button — opens the shared modal time editor.
            Hidden for deleted rows since editing a deleted row's time is a no-op. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAdjustTime(entry.id) }}
          disabled={isFrozen}
          className={cn(
            'mt-0.5 flex items-center justify-center gap-1 self-center',
            'h-5 px-1.5 rounded text-micro text-zinc-500',
            'hover:bg-zinc-800 hover:text-zinc-200 transition-colors duration-100',
            'disabled:opacity-30 disabled:pointer-events-none'
          )}
        >
          <Clock className="h-3 w-3" />
          {t('action.adjustTime')}
        </button>
      </div>

      {/* Size — empty in audio mode (REQ-028).  Column width stays
          reserved by the empty div so the grid template doesn't shift.
          REQ-039 #4: ↑ / ↓ buttons stacked above and below the input
          step the value by SIZE_STEP_PX (10) within FONT_SIZE_MIN_PX /
          FONT_SIZE_MAX_PX.  Up = larger size, placed above; Down =
          smaller, placed below — matches the visual metaphor of "above
          = bigger". */}
      <div className="flex items-center py-3 px-1">
        {!isAudioOnly && (
          <div
            className="flex w-full flex-col items-stretch gap-0.5"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleSizeBump(+SIZE_STEP_PX) }}
              disabled={isFrozen || entry.fontSizePx >= FONT_SIZE_MAX_PX}
              title={t('action.sizeStepUp', { step: SIZE_STEP_PX, max: FONT_SIZE_MAX_PX })}
              aria-label={t('action.sizeStepUp', { step: SIZE_STEP_PX, max: FONT_SIZE_MAX_PX })}
              className={cn(
                'flex h-4 items-center justify-center rounded text-zinc-500',
                'hover:bg-zinc-800 hover:text-zinc-200 transition-colors duration-100',
                'disabled:opacity-30 disabled:pointer-events-none'
              )}
            >
              <ChevronUp className="h-3 w-3" />
            </button>
            <input
              type="number"
              min={FONT_SIZE_MIN_PX}
              max={FONT_SIZE_MAX_PX}
              defaultValue={entry.fontSizePx}
              key={entry.fontSizePx}
              onChange={handleSizeChange}
              onBlur={handleSizeBlur}
              disabled={isFrozen}
              // REQ-034 #3: 64 px column has no room for an inline hint
              // line, so surface the clamp range as a hover tooltip.
              title={t('step1:subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
              className={cn(
                'w-full h-7 rounded border bg-zinc-950 px-1 text-center text-body-sm text-zinc-100',
                'focus:outline-none focus:ring-1',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                sizeWarning
                  ? 'border-amber-400/60 focus:ring-amber-400/30'
                  : 'border-zinc-800 focus:border-zinc-700 focus:ring-green-500/30'
              )}
            />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleSizeBump(-SIZE_STEP_PX) }}
              disabled={isFrozen || entry.fontSizePx <= FONT_SIZE_MIN_PX}
              title={t('action.sizeStepDown', { step: SIZE_STEP_PX, min: FONT_SIZE_MIN_PX })}
              aria-label={t('action.sizeStepDown', { step: SIZE_STEP_PX, min: FONT_SIZE_MIN_PX })}
              className={cn(
                'flex h-4 items-center justify-center rounded text-zinc-500',
                'hover:bg-zinc-800 hover:text-zinc-200 transition-colors duration-100',
                'disabled:opacity-30 disabled:pointer-events-none'
              )}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {/* Style — empty container in audio mode for the same reason. */}
      {isAudioOnly ? (
        <div className="py-3 px-1" />
      ) : (
      <div className="flex flex-col gap-1 py-2 px-1">
        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
          <span className="text-micro text-zinc-500 truncate">{t('styleCell.textColor')}</span>
          <ColorPicker
            value={entry.textColorHex}
            onChange={handleTextColorChange}
            onPairApply={(text, outline) =>
              withHistory(t('history.editColor'), { textColorHex: text, outlineColorHex: outline })
            }
            disabled={isFrozen}
            swatchOnly
          />
        </div>
        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
          <span className="text-micro text-zinc-500 truncate">{t('styleCell.outlineColor')}</span>
          <ColorPicker
            value={entry.outlineColorHex}
            onChange={handleOutlineColorChange}
            onPairApply={(text, outline) =>
              withHistory(t('history.editColor'), { textColorHex: text, outlineColorHex: outline })
            }
            disabled={isFrozen}
            swatchOnly
          />
        </div>
        <div
          className="grid grid-cols-[80px_1fr] items-center gap-2"
          // stopPropagation so dragging the slider thumb does not also
          // trigger the row-level click handler (which would re-focus the
          // row and seek the video on every onChange frame).
          onClick={(e) => e.stopPropagation()}
        >
          <span className="text-micro text-zinc-500 truncate">{t('styleCell.outlineWidth')}</span>
          <OutlineThicknessSlider
            value={entry.outlineThicknessPx}
            onCommit={(v) => withHistory(t('history.editStroke'), { outlineThicknessPx: v })}
            disabled={isFrozen}
            ariaLabel={t('styleCell.outlineWidth')}
          />
        </div>
        <div className="grid grid-cols-[80px_1fr] items-center gap-2">
          <span className="text-micro text-zinc-500 truncate">{t('styleCell.fade')}</span>
          <Switch checked={entry.fadeEnabled} onCheckedChange={handleFadeChange} disabled={isFrozen} className="scale-75 origin-left" />
        </div>
      </div>
      )}

      {/* Text column — REQ-022 step 1 stacks the per-row font selector
          above the editor so the user always sees "this row's font" in
          context with the text it applies to.  The selector itself
          stops click propagation so picking a font does not re-focus the
          row / seek the video.
          REQ-023: the selector wrapper used to have `px-2` which made
          the button 16 px narrower than the text editor below (the
          text editor's px-2 is internal padding on the div whose outer
          edge is at the full column width).  Wrapper padding removed
          so both children's outer edges sit at the same column x. */}
      <div className="flex flex-col gap-1 my-1 min-w-0">
      {/* Row font selector — hidden in audio mode (REQ-028): there is
          no burn-in stage so per-row font choice has no consumer. */}
      {!isAudioOnly && (
        <RowFontSelector
          value={entry.fontId}
          onChange={handleFontChange}
          disabled={isFrozen}
        />
      )}
      <div
        className={cn(
          'flex items-start py-2 px-2 min-w-0 min-h-[36px] cursor-text rounded transition-all duration-150',
          // Non-editing: always show a subtle inset border (no layout shift vs a real border)
          !editingText && 'shadow-[inset_0_0_0_1px_rgba(63,63,70,0.5)]',
          // Hover: brighten border + light bg
          !editingText && !isFrozen && 'hover:shadow-[inset_0_0_0_1px_rgba(113,113,122,0.5)] hover:bg-zinc-800/30',
          // Editing: green border + bg
          editingText && 'shadow-[inset_0_0_0_1px_rgba(34,197,94,0.5)] bg-zinc-800/20'
        )}
        onClick={(e) => {
          e.stopPropagation()
          onFocus(entry.id)
          useUiStore.getState().setVideoSeekRequest(entry.startSec)
          // REQ-118 [2] — refuse to enter text-edit mode on trim-deleted
          // entries (= spec §2.1 freeze); manual-delete behaviour
          // unchanged.
          if (!isFrozen) setEditingText(true)
        }}
      >
        {editingText ? (
          // Convert \N to real newlines for the textarea; handleTextCommit converts back.
          <CellEditor
            value={entry.text.replace(/\\N/g, '\n')}
            onCommit={handleTextCommit}
            multiline
          />
        ) : isFrozen ? (
          <span className="text-body leading-relaxed break-words whitespace-pre-wrap line-clamp-3 line-through text-zinc-500 cursor-text select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        ) : isOverflow ? (
          <span className="text-body leading-relaxed break-words whitespace-pre-wrap line-clamp-3 cursor-text select-text">
            <span className="text-zinc-100">{entry.text.replace(/\\N/g, '\n').slice(0, overflowStartIndex)}</span>
            <span className="text-red-500">{entry.text.replace(/\\N/g, '\n').slice(overflowStartIndex)}</span>
          </span>
        ) : (
          <span className="text-body leading-relaxed break-words whitespace-pre-wrap line-clamp-3 text-zinc-100 cursor-text select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        )}
      </div>
      </div>

      {/* State — shows all applicable badges simultaneously.
          REQ-103 §C: split the legacy "削除済み" badge into two —
          `manuallyDeleted` keeps the old `state.deleted` label, while
          `trimDeleted` gets its own `state.trimDeleted` label so the
          user can distinguish a row they intentionally deleted from
          a row a cut consumed.  Both are still danger-styled and
          both suppress the per-row warning badges (the warnings are
          still computed and surfaced in the 警告 tab — they just
          don't decorate a row that's already gone).
          The `edited` badge fires for any row that `wasEdited`
          (= REQ-103 §B cross-cutting `wasEdited` flag), so a row
          that was manually edited and then manually deleted still
          shows its `edited` badge alongside the `deleted` one — the
          user can see at a glance that the row WAS edited before it
          was removed. */}
      <div className="flex flex-wrap items-center gap-1 py-3 px-1">
        {clipStatus === 'manuallyDeleted' && (
          <Badge variant="danger">{t('state.deleted')}</Badge>
        )}
        {clipStatus === 'trimDeleted' && (
          <Badge variant="danger">{t('state.trimDeleted')}</Badge>
        )}
        {(entry.isEdited ||
          // REQ-103: also surface "edited" badge for rows whose times
          // were clamped by a head/tail cut (= `clipStatus === 'edited'`
          // when not deleted, OR `wasEdited` on a deleted row).  We
          // detect cut-induced edit by reading the precomputed status —
          // if the row is 'edited' the clamp happened, and for deleted
          // rows we still want the badge when `entry.isEdited` was true
          // pre-deletion.
          clipStatus === 'edited') && (
          <Badge variant="default">{t('state.edited')}</Badge>
        )}
        {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.timeInvalid && (
          <Badge variant="danger">{t('badge.timeInvalid')}</Badge>
        )}
        {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overlap && (
          /* warning (amber), not danger — overlap is an intentional pattern
             for stacked captions (libass renders both simultaneously) and
             should NOT exclude the row from burn-in.  The amber styling
             tells the user "this works, but heads-up". */
          <Badge variant="warning">{t('badge.overlap')}</Badge>
        )}
        {/* REQ-121 — overDuration is an error (concat path can't include
            an out-of-range time); badge promoted to danger. */}
        {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overDuration && (
          <Badge variant="danger">{t('badge.overDuration')}</Badge>
        )}
        {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overflow && (
          <Badge variant="warning">{t('badge.overflow')}</Badge>
        )}
        {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.emptyText && (
          <Badge variant="warning">{t('badge.emptyText')}</Badge>
        )}
        {/* REQ-121 — invalidSize (fontSizePx ≤ 0) is an error (libass
            cannot render); badge promoted to danger. */}
        {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.invalidSize && (
          <Badge variant="danger">{t('badge.invalidSize')}</Badge>
        )}
      </div>

      {/* Actions — REQ-039 #2 adds the per-row auto-line-break button
          stacked below the delete/reset icon row.  REQ-041 #2 removes
          the hover-only opacity gate: actions are now always visible
          so the user does not have to hunt the mouse over each row to
          see / target them.  The auto-line-break button is still
          suppressed in audio mode because there's no burn-in stage
          that would consume the rewrapped text.
          REQ-117 [1] — `data-row-actions` exempts this column from the
          row-level deleted-state opacity fade so the Restore / Reset
          buttons read as clickable instead of greyed-out. */}
      <div data-row-actions className="flex flex-col gap-1 py-3 px-1">
        <div className="flex items-center justify-center gap-1">
          {/* REQ-118 [2] — three branches now:
              · trim-deleted: show the restore glyph in zinc (the user
                CAN click — they get a hint toast — but the button is
                NOT the green "ready to undo" affordance because clicking
                does not restore.  Storage stays untouched, so the
                trim/manual states never swap roles).
              · manually-deleted: green restore glyph, click un-deletes.
              · normal: red-tinted-on-hover delete glyph. */}
          <button
            type="button"
            title={
              isTrimDeleted
                ? t('action.trimDeletedHint')
                : entry.isDeleted
                  ? t('action.restoreRow')
                  : t('action.deleteRow')
            }
            onClick={(e) => {
              e.stopPropagation()
              if (isTrimDeleted) {
                toast.info(t('toast.trimDeletedRestoreHint'))
                return
              }
              handleDelete()
            }}
            className={cn(
              'flex items-center justify-center h-6 w-6 rounded text-zinc-500 transition-colors duration-150',
              'hover:bg-zinc-800 hover:text-zinc-200',
              entry.isDeleted && !isTrimDeleted && 'text-green-500 hover:text-green-400'
            )}
          >
            {isTrimDeleted || entry.isDeleted
              ? <Undo2 className="h-3.5 w-3.5" />
              : <Trash2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            title={t('action.resetRow')}
            onClick={(e) => { e.stopPropagation(); handleReset() }}
            // REQ-119 [2] — Reset is an EDIT, not a revive.  Frozen rows
            // (= manual delete OR trim delete) only accept the
            // Restore/Undo button next to it.  `!entry.isEdited` keeps
            // the original "nothing to reset" gate for live rows.
            disabled={isFrozen || !entry.isEdited}
            className={cn(
              'flex items-center justify-center h-6 w-6 rounded text-zinc-500 transition-colors duration-150',
              'hover:bg-zinc-800 hover:text-zinc-200',
              'disabled:opacity-30 disabled:pointer-events-none'
            )}
          >
            {/* REQ-047 #2: Eraser instead of the RotateCcw used by the
                top-right Undo button — visually distinct so the row's
                "wipe my edits, restore the original transcription"
                action can't be mistaken for the global "undo last
                history op" action.  RotateCcw stays as the canonical
                undo glyph in step2.tsx. */}
            <Eraser className="h-3.5 w-3.5" />
          </button>
        </div>
        {!isAudioOnly && (
          <button
            type="button"
            title={t('action.autoLineBreakRowHelp')}
            aria-label={t('action.autoLineBreakRowHelp')}
            onClick={(e) => { e.stopPropagation(); handleAutoLineBreakRow() }}
            disabled={isFrozen}
            className={cn(
              'flex items-center justify-center gap-0.5',
              'h-5 px-1 rounded text-micro text-zinc-500',
              'hover:bg-zinc-800 hover:text-zinc-200 transition-colors duration-100',
              'disabled:opacity-30 disabled:pointer-events-none'
            )}
          >
            <WrapText className="h-3 w-3" />
            {t('action.autoLineBreakRow')}
          </button>
        )}
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
  // REQ-102: filterEntries is now cut-aware so the table tabs / counts
  // agree with the timeline view and the ffmpeg burnin output.  See
  // src/renderer/lib/subtitle-filter.ts for the predicate; this
  // subscription wires the live cut list into that filter.
  const cuts = useProjectStore((s) => s.cuts)
  const tableFilter = useUiStore((s) => s.tableFilter)
  const focusedRowId = useUiStore((s) => s.focusedRowId)
  // REQ-028: blank out the "Size" / "Style" header labels when the
  // input is audio-only so the dead columns don't advertise themselves.
  // Column widths stay reserved (TABLE_GRID_COLS unchanged) — only the
  // labels disappear.
  const isAudioOnly = useIsAudioOnly()
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

  const filtered = filterEntries(entries, tableFilter, warningsMap, cuts)

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

  // REQ-119 [1] — bulk-edit cannot reach a frozen row (= manually-deleted
  // OR trim-deleted per REQ-118 spec §2.1).  Compute a "selectable"
  // subset of the visible rows so the header "select all" toggle, the
  // Shift+click range, and the per-row checkbox all agree on the same
  // exclusion rule.  Storage selection (`selectedRowIds`) keeps its
  // existing shape; we just narrow what the header adds.  The Shift+
  // click range expansion runs against `selectableIds`, which means the
  // user can never drag a selection across a frozen row.
  const selectableIds = useMemo(
    () =>
      filtered
        .filter(
          (e) =>
            !e.isDeleted &&
            effectiveEntryState(e, cuts).status !== 'trimDeleted',
        )
        .map((e) => e.id),
    [filtered, cuts],
  )

  // Header checkbox state — three values:
  //   - true            : every visible row is selected
  //   - false           : no visible row is selected
  //   - 'indeterminate' : some visible rows are selected
  // Selection retention across filters means selectedRowIds can contain rows
  // that aren't currently visible; the header only reflects the *visible*
  // subset so clicking it produces a deterministic outcome for what the user
  // can see.
  // REQ-119 [1] — header checkbox state mirrors the SELECTABLE subset
  // (= frozen rows are excluded from "all rows selected" calculations).
  // When the visible tab is entirely frozen (= the Deleted tab), the
  // selectable set is empty and the header checkbox stays unchecked +
  // disabled so the user has no way to bulk-select frozen rows.
  const selectableSelectedCount = useMemo(() => {
    let n = 0
    for (const id of selectableIds) if (selectedRowIds.has(id)) n++
    return n
  }, [selectableIds, selectedRowIds])
  const headerCheckState: boolean | 'indeterminate' =
    selectableSelectedCount === 0
      ? false
      : selectableSelectedCount === selectableIds.length
        ? true
        : 'indeterminate'
  const headerCheckDisabled = selectableIds.length === 0

  function handleHeaderCheckboxClick() {
    // Toggle semantics:
    //   - any SELECTABLE row selected → clear selectable rows from selection
    //     (rows hidden by the filter, and frozen rows in the current
    //      filter, are intentionally preserved)
    //   - none selected → add all SELECTABLE rows (= frozen rows skipped)
    if (selectableSelectedCount > 0) {
      const next = new Set(selectedRowIds)
      for (const id of selectableIds) next.delete(id)
      setRowSelection(next)
    } else {
      const next = new Set(selectedRowIds)
      for (const id of selectableIds) next.add(id)
      setRowSelection(next)
    }
  }

  function handleRowCheckboxClick(id: string, shiftKey: boolean) {
    // REQ-119 [1] — Shift+click range uses selectableIds so dragging
    // across a frozen row never adds it to the selection.  Single-click
    // toggling is already guarded by the per-row `disabled={isFrozen}`
    // in SubtitleRow.
    if (shiftKey) selectRowRange(id, selectableIds)
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
            disabled={headerCheckDisabled}
            onClick={(e) => {
              e.stopPropagation()
              if (headerCheckDisabled) return
              handleHeaderCheckboxClick()
            }}
            aria-label={t('table.selectAllAria')}
          />
        </div>
        {/* REQ-072 Phase 3c: column headers shifted from 11/medium uppercase
            (chrome label tier) to 13/semibold non-uppercase (callout / item
            name tier).  Apple HIG, VSCode, Notion, Linear all use
            sentence-case for table headers — uppercase + tracking-wider
            made these read as decorative chrome rather than as item names
            that pair with the cell values below.  Color also lifted from
            zinc-500 to zinc-300 so the headers carry the item-name weight
            of a real label. */}
        <div className="py-2 px-1 text-callout font-semibold text-zinc-300 text-center">{t('table.colIndex')}</div>
        <div className="py-2 px-1 text-callout font-semibold text-zinc-300">{t('table.colTime')}</div>
        <div className="py-2 px-1 text-callout font-semibold text-zinc-300">{isAudioOnly ? '' : t('table.colSize')}</div>
        <div className="py-2 px-1 text-callout font-semibold text-zinc-300">{isAudioOnly ? '' : t('table.colStyle')}</div>
        <div className="py-2 px-2 text-callout font-semibold text-zinc-300">{t('table.colText')}</div>
        <div className="py-2 px-1 text-callout font-semibold text-zinc-300">{t('table.colState')}</div>
        <div className="py-2 px-1 text-callout font-semibold text-zinc-300">{t('table.colActions')}</div>
      </div>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center gap-3 py-16"
          >
            <FileText className="h-8 w-8 text-zinc-700" />
            <p className="text-body font-medium text-zinc-400">{t(emptyKey)}</p>
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
                  // REQ-103 — derive the row's 4-state classification
                  // from the live cut list.  Cuts is a small array; per-
                  // row recompute is O(cuts.length).
                  clipStatus={effectiveEntryState(entry, cuts).status}
                  // REQ-115 — forward the live cut list so the row's
                  // TimeInputs display Edited-axis timecodes.
                  cuts={cuts}
                />
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
    </div>
  )
}
