import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Clock, ChevronUp, ChevronDown } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { TimeInput } from '@/components/time-input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
// REQ-20260614-001 補遺③ — most Style-column controls (font picker /
// switch) live in the always-on right-pane Inspector.  REQ-0222 walked
// back the per-row read-only display of textColor / outlineColor /
// outlineThickness: those three are now editable in-place via the
// same ColorPicker and OutlineThicknessSlider the Inspector uses.
// REQ-0225 walked back REQ-0222's bulk-edit blockade — the row-level
// pickers are now always available, matching the "time / size / text
// stay editable during bulk edit" convention the rest of the row uses.
import { ColorPicker } from '@/components/color-picker/color-picker'
import { OutlineThicknessPopover } from '@/components/subtitle-table/outline-thickness-popover'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { type EntryWarnings } from '@/lib/entry-warnings'
import { commitTimeEdit } from '@/lib/commit-time-edit'
import { commitTextEditWithHistory } from '@/lib/commit-text-edit'
import { filterEntries } from '@/lib/subtitle-filter'
import type { SubtitleEntry, RowState } from '../../../shared/types'
import { effectiveEntryState, type ClipStatus, type CutList } from '../../../shared/cuts'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'
import { getFontMeta, isFontId } from '../../../shared/fonts'

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
// REQ-20260614-001 補遺④ — final list-view column layout:
//   - Style cell now hosts a 3-row display-only reference block
//     (text colour swatch / outline colour swatch / outline width
//     number).  Clicks bubble to the row → selection.
//   - Time cell shows start / end / "時間調整" stacked vertically
//     (the legacy "|" separator was dropped — 3 rows on the dot).
//   - Text cell shows the per-row font name (read-only) on row 1 and
//     the editable text on rows 2-3.
//   - Action icons (改行 / 削除 / リセット / 複製) are **removed** from
//     the list — those flows live in the always-on right-pane
//     Inspector.
//
// Columns: checkbox 32 | # 36 | time 130 | size 64 | style-ref 64 |
//          text 1fr | state 90  (7 columns total)
const TABLE_GRID_COLS = 'grid-cols-[32px_36px_130px_64px_64px_1fr_90px]'

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
  /**
   * REQ-0127 Phase 1 — `textOnFocus` is captured at the moment the
   * editor mounts (= gains focus in the table row flow, since the
   * editor is gated by an outer `editingText` state).  Callers hand
   * it into a `beforePatch` on their history push so the resulting
   * Undo target is the pre-focus text — regardless of how many
   * onPreview fires happened in between.
   */
  onCommit: (v: string, textOnFocus: string) => void
  /**
   * REQ-0127 Phase 1 — fires per-keystroke with the current typed
   * value.  Callers wire this to `projectStore.updateEntryPreview`
   * (history-less writer) so the preview overlay reflects typing
   * live without polluting Undo.
   */
  onPreview?: (v: string) => void
  multiline?: boolean
}

function CellEditor({ value, onCommit, onPreview, multiline }: CellEditorProps) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null)
  // REQ-0127 Phase 1 — snapshot of the pre-focus value; the editor
  // remounts on every `editingText → true`, so the constructor of this
  // component IS the focus event, and `value` at construction time IS
  // the pre-focus value we want Undo to rewind to.
  const focusValueRef = useRef(value)
  // REQ-20260612-004: track whether the user has typed since the last
  // commit / external sync.  Used by the value-sync effect and the
  // blur handler so that an external `updateEntry({text})` (e.g. from
  // a wrap button) propagates into the displayed draft AND is not
  // silently overwritten on the next blur.  Ref (not state) so the
  // change handler doesn't trigger a re-render purely to flip it.
  const dirtyRef = useRef(false)
  // REQ-20260612-004: skip the value-sync effect while an IME
  // composition is in progress, since replacing the textarea's value
  // mid-composition resets the candidate window and corrupts the
  // partial composition glyphs.
  const isComposingRef = useRef(false)

  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])

  // REQ-20260612-004: accept external value updates while the editor
  // is mounted, as long as the user hasn't typed into the buffer
  // since the last commit and is not mid-IME-composition.  Without
  // this, an `updateEntry({text})` from a sibling control (e.g. the
  // wrap buttons in this row's action column) writes to the store
  // but never reaches the displayed `draft`, so the textarea keeps
  // showing the pre-wrap text and the next blur silently overwrites
  // the wrap with that stale value.
  useEffect(() => {
    if (dirtyRef.current) return
    if (isComposingRef.current) return
    setDraft(value)
  }, [value])

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
    'w-full bg-surface-2 rounded px-2 py-1 text-body text-fg-primary resize-none',
    'focus:outline-none'
  )

  // REQ-20260612-004: only commit on blur when the user has actually
  // typed something — otherwise an externally-driven `value` change
  // (e.g. a wrap button that updated the store while focus was
  // elsewhere on the row) would be re-committed as itself the next
  // time the editor blurs, with no effect.  Worse, when the editor
  // still holds a stale `draft` because the sync effect was gated
  // (dirty / composing), an unconditional blur would write that
  // stale draft back and undo the external update.
  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) {
    dirtyRef.current = true
    const next = e.target.value
    setDraft(next)
    // REQ-0127 Phase 1 — stream the typed value into the store via
    // the history-less preview writer so the overlay lights up live.
    // Skip while an IME composition is in progress; the composition-
    // end handler flushes the final value into draft and re-runs
    // preview from there.
    if (!isComposingRef.current) {
      onPreview?.(next)
    }
  }
  function handleBlur() {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    onCommit(draft, focusValueRef.current)
  }
  function handleCompositionStart() {
    isComposingRef.current = true
  }
  function handleCompositionEnd(e: React.CompositionEvent<HTMLTextAreaElement | HTMLInputElement>) {
    isComposingRef.current = false
    // Treat a committed IME composition as a user edit so the next
    // blur flushes the converted text.  `e.target.value` already
    // reflects the post-composition value when this fires.
    dirtyRef.current = true
    const next = (e.target as HTMLTextAreaElement | HTMLInputElement).value
    setDraft(next)
    // REQ-0127 Phase 1 — flush the IME-committed value into the
    // preview stream so the overlay reflects the final composed text.
    onPreview?.(next)
  }

  if (multiline) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        onChange={handleChange}
        onBlur={handleBlur}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        className={sharedClass}
      />
    )
  }
  return (
    <input
      ref={ref}
      type="text"
      value={draft}
      onChange={handleChange}
      onBlur={handleBlur}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      className={sharedClass}
    />
  )
}

interface SubtitleRowProps {
  entry: SubtitleEntry
  displayIndex: number
  overflowStartIndex: number
  /**
   * REQ-20260614-001 Phase 3 — user single-selection (drives the green
   * left-border highlight + the inspector content via the parent).
   */
  isUserSelected: boolean
  /** Click handler for the row body — caller writes `selectedEntryId`. */
  onSelect: (id: string) => void
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

function SubtitleRow({ entry, displayIndex, overflowStartIndex, isUserSelected, onSelect, warnings, registerRef, isStartExceedsDuration, isEndExceedsDuration, onAdjustTime, isSelected, onCheckboxClick, clipStatus, cuts }: SubtitleRowProps) {
  const isOverflow = overflowStartIndex !== -1
  const isStartOverlap = warnings.overlap
  // step1 namespace included so the size input's `title` tooltip can
  // reuse the `subtitleDefaults.sizeHint` string defined for STEP 1's
  // Subtitle Style dialog (REQ-034 #3).
  const { t } = useTranslation(['step2', 'step1'])
  const updateEntry = useProjectStore((s) => s.updateEntry)
  // REQ-0127 Phase 1 — history-less preview writer used from CellEditor's
  // onPreview so typing lights up the video overlay live.
  const updateEntryPreview = useProjectStore((s) => s.updateEntryPreview)
  const pushHistory = useHistoryStore((s) => s.push)
  // REQ-028: in audio-only mode the size / style / font cells render
  // empty so the grid stays in place (col widths unchanged) but the
  // style controls are visually + functionally suppressed.
  const isAudioOnly = useIsAudioOnly()
  // REQ-20260614-001 補遺④ — read the project-default font so rows
  // that don't carry a `fontId` override still surface the inherited
  // family name above the text editor.  Subscribed per-row; activeFontId
  // changes infrequently (font selection is a global setting) so the
  // re-render cost is negligible.
  const activeFontId = useSettingsStore((s) => s.activeFontId)

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

  function withHistory(
    label: string,
    patch: Partial<SubtitleEntry>,
    // REQ-0127 Phase 1 — like the inspector's applyStyleEdit(beforePatch),
    // this override tells `undo` which fields to restore to which values
    // instead of using the naive current-entry snapshot.  The text-cell
    // path uses it because the preview stream has moved the store past
    // the pre-focus value, so a naive snapshot would capture the typed
    // text and Undo would be a no-op.
    beforePatch?: Partial<SubtitleEntry>
  ) {
    const snapshot = { ...entry }
    const undoState = beforePatch ? { ...snapshot, ...beforePatch } : snapshot
    // Time-affecting patches (startSec / endSec) need a re-sort on undo /
    // redo as well so the row visually lands at the position that matches
    // its restored or re-applied time value.  Non-time patches (text, size,
    // colour, fade) do not affect ordering and skip the resort.
    const affectsTime = 'startSec' in patch || 'endSec' in patch
    pushHistory({
      label,
      undo: () => {
        updateEntry(entry.id, undoState)
        if (affectsTime) useProjectStore.getState().sortByStartSec()
      },
      redo: () => {
        updateEntry(entry.id, { ...snapshot, ...patch, isEdited: true })
        if (affectsTime) useProjectStore.getState().sortByStartSec()
      }
    })
    applyPatch(patch)
  }

  function handleTextCommit(text: string, textOnFocus: string) {
    setEditingText(false)
    // CellEditor uses real newlines internally; convert back to ASS \N on save.
    const normalized = text.replace(/\n/g, '\\N')
    const normalizedOnFocus = textOnFocus.replace(/\n/g, '\\N')
    // REQ-0199 — routed through the shared helper.  Guard compares against the
    // pre-focus value (NOT `entry.text`, which the preview stream already moved
    // to match `normalized`) so real text edits push exactly one history op and
    // Undo rewinds to what was on screen before the editor gained focus.
    commitTextEditWithHistory({
      entry,
      normalizedNew: normalized,
      normalizedOnFocus,
      label: t('history.editText'),
      updateEntry,
      pushHistory,
    })
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

  // REQ-20260614-001 補遺③ — text-colour / outline-colour / fade /
  // horizontal-position / vertical-position / margin / background-* /
  // font-selector handlers were removed from SubtitleRow alongside the
  // Style column slimming.  All those edits now happen via the always-on
  // right-pane Inspector (which keeps its own handlers in
  // `timeline-block-inspector.tsx`).  Size stays here because the row
  // still renders a compact number input for it.

  // REQ-20260614-001 補遺④ — Row-level Delete / Reset / AutoLineBreak /
  // OverflowWrap / Duplicate handlers were retired from the list view.
  // The action icon column is gone; those operations now live exclusively
  // in the always-on right-pane Inspector (which keeps its own handlers
  // in `timeline-block-inspector.tsx`).

  // REQ-20260614-001 補遺④ — font-name display in the text column.
  // Resolve `entry.fontId ?? activeFontId` then look up the canonical
  // display name.  `isFontId` is defensive against stale settings (e.g.
  // a fontId pointing at a removed family).
  const resolvedFontId = isFontId(entry.fontId) ? entry.fontId : activeFontId
  const rowFontDisplayName = getFontMeta(resolvedFontId).displayName

  // REQ-20260614-001 補遺⑬: sky (再生アクティブ) ハイライトを撤去。残る
  // 左 border 優先順位は 緑 (ユーザー選択) > HSL var (bulk-select) > 無し。
  // bg は 緑 (選択) と amber/red (state tint) と HSL var (bulk-select) の
  // 組み合わせ。再生中の自動スクロール (= focusedRowId 駆動の
  // scrollIntoView) は別経路で維持されている (本ファイル下部の effect
  // 参照)。
  const rowBg = cn(
    'group grid items-start gap-0 border-b border-line/50 transition-colors duration-150',
    TABLE_GRID_COLS,
    isUserSelected
      ? 'border-l-2 border-l-primary'
      : isSelected
        ? 'border-l-2 border-l-[hsl(var(--row-selected-border))]'
        : 'border-l-2 border-l-transparent',
    isUserSelected && rowState !== 'edited' && rowState !== 'overflow' && 'bg-surface-2/50',
    !isUserSelected && !isSelected && 'hover:bg-surface-2/20',
    // REQ-20260614-001 補遺④ — actions column removed, so the previous
    // `[&>*:not([data-row-actions])]` exemption is no longer needed.
    // Every cell now fades together when the row is deleted.
    rowState === 'deleted' && 'opacity-40',
    // State tints persist through selection (green) AND bulk-select.
    // The multi-row HSL highlight (applied inline below) wants the row bg
    // cleared so the variable colour shines through.
    !isSelected && rowState === 'edited' && 'bg-warning-soft/[0.04]',
    !isSelected && rowState === 'overflow' && 'bg-destructive/[0.04]'
  )

  return (
    <div
      ref={rowDivRef}
      className={rowBg}
      style={
        // bulk-select HSL bg only when no single-row green highlight is
        // also active.  (補遺⑬: sky 廃止により isPlaybackActive 条件は除去。)
        isSelected && !isUserSelected
          ? { backgroundColor: 'hsl(var(--row-selected) / var(--row-selected-alpha))' }
          : undefined
      }
      onClick={() => {
        onSelect(entry.id)
        useUiStore.getState().setVideoSeekRequest(entry.startSec)
      }}
      role="row"
      // aria-selected reflects the user-driven selection (= the inspector
      // entry); the playback follower is a passive marker and does not
      // change accessibility semantics.
      aria-selected={isUserSelected}
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
      <div className="flex items-center justify-center py-3 text-body-sm text-fg-muted font-mono tabular-nums">
        {displayIndex}
      </div>

      {/* Time — REQ-20260614-001 補遺④ — vertical 3-row stack:
              row 1: start time (TimeInput)
              row 2: end time (TimeInput)
              row 3: "時間調整" link (opens TimeEditorDialog)
          The legacy "|" separator between start/end was dropped per
          補遺④ (3 rows exactly). */}
      <div className="flex flex-col gap-1 py-2 px-1">
        <TimeInput
          value={entry.startSec}
          cuts={cuts}
          onChange={handleStartChange}
          disabled={isFrozen}
          warning={isStartOverlap || isStartExceedsDuration}
          title={isStartExceedsDuration ? t('warning.exceedsDuration') : undefined}
        />
        <TimeInput
          value={entry.endSec}
          cuts={cuts}
          onChange={handleEndChange}
          disabled={isFrozen}
          warning={isEndExceedsDuration}
          title={isEndExceedsDuration ? t('warning.exceedsDuration') : undefined}
        />
        {/* Adjust-time button — opens the shared modal time editor.
            Hidden for deleted rows since editing a deleted row's time is a no-op.
            `data-testid="adjust-time"` lets the green-button-color e2e click
            the chip without depending on the localised label ("時間調整" /
            "Adjust time"), so the test works under DEFAULT_LANGUAGE='en'.
            Multiple rows render the same testid; the test uses `.first()`. */}
        <button
          type="button"
          data-testid="adjust-time"
          onClick={(e) => { e.stopPropagation(); onAdjustTime(entry.id) }}
          disabled={isFrozen}
          className={cn(
            'mt-0.5 flex items-center justify-center gap-1 self-center',
            'h-5 px-1.5 rounded text-micro text-fg-muted',
            'hover:bg-surface-2 hover:text-fg-secondary transition-colors duration-100',
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
                'flex h-4 items-center justify-center rounded text-fg-muted',
                'hover:bg-surface-2 hover:text-fg-secondary transition-colors duration-100',
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
              // REQ-0128 Phase 1 — Enter commits via blur, matching
              // REQ-0127's DaVinci contract for every numeric input.
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
              disabled={isFrozen}
              // REQ-034 #3: 64 px column has no room for an inline hint
              // line, so surface the clamp range as a hover tooltip.
              title={t('step1:subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
              className={cn(
                'w-full h-7 rounded border bg-surface-0 px-1 text-center text-body-sm text-fg-primary',
                'focus:outline-none focus-visible:ring-1',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                sizeWarning
                  ? 'border-warning-soft/60 focus-visible:ring-warning-soft/30'
                  : 'border-line focus-visible:border-line-strong focus-visible:ring-primary/30'
              )}
            />
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleSizeBump(-SIZE_STEP_PX) }}
              disabled={isFrozen || entry.fontSizePx <= FONT_SIZE_MIN_PX}
              title={t('action.sizeStepDown', { step: SIZE_STEP_PX, min: FONT_SIZE_MIN_PX })}
              aria-label={t('action.sizeStepDown', { step: SIZE_STEP_PX, min: FONT_SIZE_MIN_PX })}
              className={cn(
                'flex h-4 items-center justify-center rounded text-fg-muted',
                'hover:bg-surface-2 hover:text-fg-secondary transition-colors duration-100',
                'disabled:opacity-30 disabled:pointer-events-none'
              )}
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>

      {/* REQ-20260614-001 補遺④ → REQ-0222 → REQ-0225 — style cell.
          The three cells (text colour swatch / outline colour swatch /
          outline width readout) are editable in-place: the two
          swatches open the shared ColorPicker popover, the number
          opens an OutlineThicknessPopover with the Inspector's
          slider inside.  Both use the same per-frame preview
          (`updateEntryPreview`) + close-time-commit (`withHistory`)
          split the ColorPicker already established under REQ-0125.

          REQ-0225 removed the REQ-0222 bulk-edit blockade: since
          the row's time / size / text inputs stay editable during a
          bulk selection, gating just the style trio was inconsistent.
          Row-level edits always apply to this row only; the bulk-edit
          bar continues to be the surface for "apply to N selected
          rows" separately.

          `onClick={(e) => e.stopPropagation()}` on the outer div
          keeps swatch/number clicks from bubbling to the row's own
          select handler; without it every picker open would also
          shift the Inspector to this row. */}
      {isAudioOnly ? (
        <div className="py-2 px-1" />
      ) : (
        <div
          className="flex flex-col items-center justify-center gap-1 py-2 px-1"
          onClick={(e) => e.stopPropagation()}
        >
          <ColorPicker
            value={entry.textColorHex}
            onChange={(hex) =>
              updateEntryPreview(entry.id, { textColorHex: hex })
            }
            onCommit={(hex, hexOnOpen) =>
              withHistory(
                t('history.editColor'),
                { textColorHex: hex },
                { textColorHex: hexOnOpen },
              )
            }
            onPairApply={(text, outline) =>
              withHistory(t('history.editColor'), {
                textColorHex: text,
                outlineColorHex: outline,
              })
            }
            disabled={isFrozen}
            swatchOnly
            heading={t('common:colorPicker.headingText')}
          />
          <ColorPicker
            value={entry.outlineColorHex}
            onChange={(hex) =>
              updateEntryPreview(entry.id, { outlineColorHex: hex })
            }
            onCommit={(hex, hexOnOpen) =>
              withHistory(
                t('history.editColor'),
                { outlineColorHex: hex },
                { outlineColorHex: hexOnOpen },
              )
            }
            onPairApply={(text, outline) =>
              withHistory(t('history.editColor'), {
                textColorHex: text,
                outlineColorHex: outline,
              })
            }
            disabled={isFrozen}
            swatchOnly
            heading={t('common:colorPicker.headingOutline')}
          />
          <OutlineThicknessPopover
            value={entry.outlineThicknessPx}
            onPreview={(v) =>
              updateEntryPreview(entry.id, { outlineThicknessPx: v })
            }
            onCommit={(v, valueOnOpen) =>
              withHistory(
                t('history.editStroke'),
                { outlineThicknessPx: v },
                { outlineThicknessPx: valueOnOpen },
              )
            }
            disabled={isFrozen}
            isFrozen={isFrozen}
            ariaLabel={t('styleCell.outlineWidth')}
          />
        </div>
      )}

      {/* Text column — REQ-20260614-001 補遺④:
            row 1: font name (display only, truncates when long)
            rows 2-3: editable text (CellEditor on click, otherwise
                       static span with `line-clamp-3`)
          The font name resolves entry.fontId → activeFontId fallback so
          rows that inherit the project default still show the
          inherited family name.  Click anywhere on the text editor
          opens edit mode; clicks on the font label propagate up to
          the row select (no edit affordance — font is changed in the
          Inspector). */}
      <div className="flex flex-col gap-1 my-1 min-w-0">
      {!isAudioOnly && (
        <span
          title={rowFontDisplayName}
          className="text-caption text-fg-muted truncate px-2 leading-none"
        >
          {rowFontDisplayName}
        </span>
      )}
      <div
        className={cn(
          'flex items-start py-2 px-2 min-w-0 min-h-[36px] cursor-text rounded transition-all duration-150',
          // Non-editing: always show a subtle inset border (no layout shift vs a real border)
          !editingText && 'shadow-[inset_0_0_0_1px_hsl(var(--border-strong)/0.5)]',
          // Hover: brighten border + light bg
          !editingText && !isFrozen && 'hover:shadow-[inset_0_0_0_1px_hsl(var(--text-muted)/0.5)] hover:bg-surface-2/30',
          // Editing: green border + bg
          editingText && 'shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.5)] bg-surface-2/20'
        )}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(entry.id)
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
            onPreview={(text) => updateEntryPreview(entry.id, { text: text.replace(/\n/g, '\\N') })}
            multiline
          />
        ) : isFrozen ? (
          <span className="text-body leading-relaxed break-words whitespace-pre-wrap line-clamp-3 line-through text-fg-muted cursor-text select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        ) : isOverflow ? (
          <span className="text-body leading-relaxed break-words whitespace-pre-wrap line-clamp-3 cursor-text select-text">
            <span className="text-fg-primary">{entry.text.replace(/\\N/g, '\n').slice(0, overflowStartIndex)}</span>
            <span className="text-destructive">{entry.text.replace(/\\N/g, '\n').slice(overflowStartIndex)}</span>
          </span>
        ) : (
          <span className="text-body leading-relaxed break-words whitespace-pre-wrap line-clamp-3 text-fg-primary cursor-text select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        )}
      </div>
      </div>

      {/* REQ-20260614-001 補遺④ — Actions column removed from the list
          view.  改行 / 削除 / リセット / 複製 are exposed by the
          always-on right-pane Inspector instead.  The State badges
          below occupy the rightmost slot directly (TABLE_GRID_COLS has
          7 columns now, not 8). */}

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
        {/* REQ-20260615-036: the standalone "position-pinned" badge
            was retired — offset edits now surface through the generic
            "編集済み" badge below (driven by isEditedFromOriginal, which
            already factors in posX/posY). */}
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
  // Two distinct slices:
  //   selectedEntryId  = user single-selection  → green left border
  //   focusedRowId      = playback follower      → drives auto-scroll only
  // Row click writes selectedEntryId; the preview panel continues to
  // write focusedRowId from `handleTimeUpdate`.  (補遺⑬: sky 視覚化は撤去、
  // focusedRowId は下の scrollIntoView effect だけが参照する。)
  const selectedEntryId = useUiStore((s) => s.selectedEntryId)
  const setSelectedEntryId = useUiStore((s) => s.setSelectedEntryId)
  const focusedRowId = useUiStore((s) => s.focusedRowId)
  // REQ-028: blank out the "Size" / "Style" header labels when the
  // input is audio-only so the dead columns don't advertise themselves.
  // Column widths stay reserved (TABLE_GRID_COLS unchanged) — only the
  // labels disappear.
  const isAudioOnly = useIsAudioOnly()
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

  // REQ-20260614-001 Phase 3 — auto-scroll continues to track the
  // playback-active entry (= `focusedRowId`).  User clicks land on a
  // row that is already visible, so they do not need to drive this
  // scroll path; explicit "add / time-edit / duplicate" flows still go
  // through the dedicated `scrollToRowId` signal below (centred, deferred).
  //
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
    'grid border-b border-line bg-surface-1 sticky top-0 z-10',
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
        <div className="py-2 px-1 text-caption font-normal text-fg-secondary text-center">{t('table.colIndex')}</div>
        <div className="py-2 px-1 text-caption font-normal text-fg-secondary">{t('table.colTime')}</div>
        <div className="py-2 px-1 text-caption font-normal text-fg-secondary">{isAudioOnly ? '' : t('table.colSize')}</div>
        {/* REQ-20260614-001 補遺④ — column 5: style-reference block
            (text colour / outline colour / outline width — display
            only).  No header label since the cell content is purely
            visual reference. */}
        <div className="py-2 px-1 text-caption font-normal text-fg-secondary"></div>
        <div className="py-2 px-2 text-caption font-normal text-fg-secondary">{t('table.colText')}</div>
        {/* REQ-20260614-001 補遺④ — actions column removed.  Action
            icons (改行 / 削除 / リセット / 複製) now live exclusively
            in the right-pane Inspector. */}
        <div className="py-2 px-1 text-caption font-normal text-fg-secondary">{t('table.colState')}</div>
      </div>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center gap-3 py-16"
          >
            <FileText className="h-8 w-8 text-fg-faint" />
            <p className="text-body font-medium text-fg-tertiary">{t(emptyKey)}</p>
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
                  // user single-selection drives the green left-border + the
                  // inspector content.  (補遺⑬: sky 廃止により isPlaybackActive
                  // は撤去。focusedRowId は本ファイル下部の effect が
                  // 自動スクロール用にのみ参照する。)
                  isUserSelected={selectedEntryId === entry.id}
                  onSelect={setSelectedEntryId}
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
