import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { FileText, Clock, ArrowRight, Copy, Trash2, RotateCcw } from 'lucide-react'
import { motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { RowStylePreview } from '@/components/subtitle-table/row-style-preview'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { type EntryWarnings } from '@/lib/entry-warnings'
import { commitTextEditWithHistory } from '@/lib/commit-text-edit'
import { formatEditedTimecode, editedDurationOfEntry } from '@/lib/time'
import {
  duplicateRow as runDuplicateRow,
  toggleDeleteRow as runToggleDeleteRow,
} from '@/lib/entry-row-actions'
import type { SubtitleEntry, RowState } from '../../../shared/types'
import { effectiveEntryState, type ClipStatus, type CutList } from '../../../shared/cuts'
import { getFontMeta, isFontId } from '../../../shared/fonts'

/**
 * REQ-0471 §1 — list row layout (4 columns).
 *
 * The pre-REQ-0471 row was a 7-column control surface (inline size stepper,
 * text/outline colour swatches, outline-width popover, a 3-row time stack).
 * Owner decision (b) retired every inline STYLE control from the row — they are
 * reachable from both the Inspector and the Bulk bar (sole-path audit in
 * `dev-docs/specs/subtitle-list-ui.md` §1.2), so the row is now a
 * SELECT / READ / EDIT-TEXT surface, not a style editor.  Columns:
 *
 *   1. bulk-edit checkbox  (34px) — REQUIRED, left edge
 *   2. row index (#)       (34px)
 *   3. meta                (184px) — time "start → end · dur", state badges,
 *                                    and a font-override chip (only when set)
 *   4. text preview        (1fr)  — style-faithful `SubtitleOverlay` (case A),
 *                                    click to edit; hover reveals row actions
 */
const TABLE_GRID_COLS = 'grid-cols-[34px_34px_184px_1fr]'

/** Fallback video width when no video is loaded (drives the preview scale). */
const FALLBACK_VIDEO_WIDTH_PX = 1920

/** Fallback when warningsMap is missing an entry (deleted rows; race with stale memo). */
const NO_WARNINGS: EntryWarnings = {
  timeInvalid: false,
  overDuration: false,
  overlap: false,
  emptyText: false,
  invalidSize: false,
  overflow: false,
  verticalOverflow: false
}

function getRowState(entry: SubtitleEntry, isOverflow: boolean): RowState {
  if (entry.isDeleted) return 'deleted'
  if (isOverflow) return 'overflow'
  if (entry.isEdited) return 'edited'
  return 'normal'
}

/** "00:00:02.50" → "00:02.50" — drop a zero hours field for the compact row. */
function compactTimecode(full: string): string {
  return full.startsWith('00:') ? full.slice(3) : full
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
   * REQ-0471 §1 (d) — Escape discards the in-progress edit.  Because the
   * onPreview stream has already written the typed text into the store
   * (history-less), the parent restores the store to `originalValue` and
   * closes the editor.  Also used by blur-with-no-change to close cleanly.
   */
  onCancel: (originalValue: string) => void
  /**
   * REQ-0127 Phase 1 — fires per-keystroke with the current typed
   * value.  Callers wire this to `projectStore.updateEntryPreview`
   * (history-less writer) so the preview overlay reflects typing
   * live without polluting Undo.
   */
  onPreview?: (v: string) => void
  multiline?: boolean
}

function CellEditor({ value, onCommit, onCancel, onPreview, multiline }: CellEditorProps) {
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
  // REQ-0471 §1 (d) — set by the Escape handler so the blur that follows
  // does not re-commit (or re-cancel) the value; onCancel already ran.
  const cancelledRef = useRef(false)
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
  // since the last commit and is not mid-IME-composition.
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

  const sharedClass = cn(
    'w-full bg-surface-2 rounded px-2 py-1 text-body text-fg-primary resize-none',
    'focus:outline-none'
  )

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) {
    dirtyRef.current = true
    const next = e.target.value
    setDraft(next)
    if (!isComposingRef.current) {
      onPreview?.(next)
    }
  }
  function handleBlur() {
    // Escape already ran onCancel + closed; swallow the trailing blur.
    if (cancelledRef.current) {
      cancelledRef.current = false
      return
    }
    if (dirtyRef.current) {
      dirtyRef.current = false
      onCommit(draft, focusValueRef.current)
    } else {
      // No edit made — close the editor cleanly (restore is a no-op).
      onCancel(focusValueRef.current)
    }
  }
  // REQ-0471 §1 (d) — Enter inserts a newline (default); Ctrl/Cmd+Enter
  // commits (via blur → handleBlur); Escape cancels and restores.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelledRef.current = true
      onCancel(focusValueRef.current)
      ref.current?.blur()
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      ref.current?.blur()
    }
  }
  function handleCompositionStart() {
    isComposingRef.current = true
  }
  function handleCompositionEnd(e: React.CompositionEvent<HTMLTextAreaElement | HTMLInputElement>) {
    isComposingRef.current = false
    dirtyRef.current = true
    const next = (e.target as HTMLTextAreaElement | HTMLInputElement).value
    setDraft(next)
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
        onKeyDown={handleKeyDown}
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
      onKeyDown={handleKeyDown}
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
  isUserSelected: boolean
  onSelect: (id: string) => void
  warnings: EntryWarnings
  isStartExceedsDuration: boolean
  isEndExceedsDuration: boolean
  onAdjustTime: (entryId: string) => void
  isSelected: boolean
  onCheckboxClick: (id: string, shiftKey: boolean) => void
  clipStatus: ClipStatus
  cuts: CutList
  /** Native video width (or fallback) — denominator for the preview scale. */
  videoWidthPx: number
  /** Measured text-column width, shared by every row (see table JSDoc). */
  textColWidthPx: number
  /** True while the list is being fling-scrolled — row previews go lightweight. */
  isScrolling: boolean
}

function SubtitleRow({
  entry,
  displayIndex,
  overflowStartIndex,
  isUserSelected,
  onSelect,
  warnings,
  isStartExceedsDuration,
  isEndExceedsDuration,
  onAdjustTime,
  isSelected,
  onCheckboxClick,
  clipStatus,
  cuts,
  videoWidthPx,
  textColWidthPx,
  isScrolling,
}: SubtitleRowProps) {
  const isOverflow = overflowStartIndex !== -1
  const { t } = useTranslation(['step2'])
  const updateEntry = useProjectStore((s) => s.updateEntry)
  const updateEntryPreview = useProjectStore((s) => s.updateEntryPreview)
  const pushHistory = useHistoryStore((s) => s.push)
  const isAudioOnly = useIsAudioOnly()
  const activeFontId = useSettingsStore((s) => s.activeFontId)

  const [editingText, setEditingText] = useState(false)

  const rowState = getRowState(entry, isOverflow)
  // REQ-118 [2] — trim-deleted entries are frozen by spec §2.1.
  const isTrimDeleted = clipStatus === 'trimDeleted'
  const isFrozen = entry.isDeleted || isTrimDeleted

  function handleTextCommit(text: string, textOnFocus: string) {
    setEditingText(false)
    const normalized = text.replace(/\n/g, '\\N')
    const normalizedOnFocus = textOnFocus.replace(/\n/g, '\\N')
    commitTextEditWithHistory({
      entry,
      normalizedNew: normalized,
      normalizedOnFocus,
      label: t('history.editText'),
      updateEntry,
      pushHistory,
    })
  }

  // REQ-0471 §1 (d) — Escape / clean-close: restore the store text to the
  // pre-focus value (the preview stream wrote the typed drafts there) and
  // exit edit mode.  No history push — cancel leaves the undo stack clean.
  function handleTextCancel(originalNewlineForm: string) {
    setEditingText(false)
    updateEntryPreview(entry.id, { text: originalNewlineForm.replace(/\n/g, '\\N') })
  }

  function handleDuplicate() {
    runDuplicateRow(entry, {
      history: t('history.duplicateRow'),
      successToast: t('toast.rowDuplicated'),
      maxLayerBlocked: t('toast.rowDuplicateMaxLayer'),
    })
  }

  function handleDeleteToggle() {
    runToggleDeleteRow(entry, {
      delete: t('history.deleteRow'),
      restore: t('history.restoreRow'),
    })
  }

  // Font-name override chip — only shown when the row carries an explicit
  // per-row fontId (most rows inherit the project default, so the row stays
  // uncluttered).  Editing the font still lives in the Inspector / Bulk bar.
  const hasFontOverride = isFontId(entry.fontId) && entry.fontId !== activeFontId
  const rowFontDisplayName = hasFontOverride
    ? getFontMeta(entry.fontId as NonNullable<SubtitleEntry['fontId']>).displayName
    : null

  const startTc = compactTimecode(formatEditedTimecode(entry.startSec, cuts))
  const endTc = compactTimecode(formatEditedTimecode(entry.endSec, cuts))
  const durSec = editedDurationOfEntry(entry, cuts)

  const rowBg = cn(
    'group grid items-stretch gap-0 border-b border-line/50 transition-colors duration-150',
    TABLE_GRID_COLS,
    isUserSelected
      ? 'border-l-2 border-l-primary'
      : isSelected
        ? 'border-l-2 border-l-[hsl(var(--row-selected-border))]'
        : 'border-l-2 border-l-transparent',
    isUserSelected && rowState !== 'edited' && rowState !== 'overflow' && 'bg-surface-2/50',
    !isUserSelected && !isSelected && 'hover:bg-surface-2/20',
    rowState === 'deleted' && 'opacity-40',
    !isSelected && rowState === 'edited' && 'bg-warning-soft/[0.04]',
    !isSelected && rowState === 'overflow' && 'bg-destructive/[0.04]'
  )

  const anyBadge =
    clipStatus === 'manuallyDeleted' ||
    clipStatus === 'trimDeleted' ||
    entry.isEdited ||
    clipStatus === 'edited' ||
    warnings.timeInvalid ||
    warnings.overlap ||
    warnings.overDuration ||
    warnings.overflow ||
    warnings.verticalOverflow ||
    warnings.emptyText ||
    warnings.invalidSize

  return (
    <div
      className={rowBg}
      style={
        isSelected && !isUserSelected
          ? { backgroundColor: 'hsl(var(--row-selected) / var(--row-selected-alpha))' }
          : undefined
      }
      onClick={() => {
        onSelect(entry.id)
        useUiStore.getState().setVideoSeekRequest(entry.startSec)
      }}
      role="row"
      aria-selected={isUserSelected}
    >
      {/* Selection checkbox — 34px column, centred.  min tap area kept via the
          full-height flex container (REQ-0471 §2: density must not shrink the
          checkbox hit region). */}
      <div
        className="flex items-center justify-center"
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
      <div className="flex items-center justify-center py-1 text-body-sm text-fg-muted font-mono tabular-nums">
        {displayIndex}
      </div>

      {/* Meta — time "start → end · dur" (click = TimeEditorDialog), badges,
          and a font-override chip.  REQ-0471 §1 (c): inline time inputs are
          gone; the whole time line opens the shared modal editor. */}
      <div className="flex flex-col justify-center gap-0.5 py-1 px-1 min-w-0">
        <button
          type="button"
          data-testid="adjust-time"
          onClick={(e) => { e.stopPropagation(); onAdjustTime(entry.id) }}
          disabled={isFrozen}
          title={
            isStartExceedsDuration || isEndExceedsDuration
              ? t('warning.exceedsDuration')
              : t('action.adjustTime')
          }
          className={cn(
            'flex items-center gap-1 rounded px-1 -mx-1 text-micro font-mono tabular-nums',
            'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-100',
            'disabled:opacity-40 disabled:pointer-events-none min-w-0',
            (isStartExceedsDuration || isEndExceedsDuration) && 'text-warning-soft'
          )}
        >
          <Clock className="h-3 w-3 flex-shrink-0 text-fg-muted" />
          <span className="truncate">{startTc}</span>
          <ArrowRight className="h-2.5 w-2.5 flex-shrink-0 text-fg-muted" />
          <span className="truncate">{endTc}</span>
          <span className="text-fg-muted flex-shrink-0">· {durSec.toFixed(2)}s</span>
        </button>

        {anyBadge && (
          <div className="flex flex-wrap items-center gap-1">
            {clipStatus === 'manuallyDeleted' && (
              <Badge variant="danger">{t('state.deleted')}</Badge>
            )}
            {clipStatus === 'trimDeleted' && (
              <Badge variant="danger">{t('state.trimDeleted')}</Badge>
            )}
            {(entry.isEdited || clipStatus === 'edited') && (
              <Badge variant="default">{t('state.edited')}</Badge>
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.timeInvalid && (
              <Badge variant="danger">{t('badge.timeInvalid')}</Badge>
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overlap && (
              <Badge variant="warning">{t('badge.overlap')}</Badge>
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overDuration && (
              <Badge variant="danger">{t('badge.overDuration')}</Badge>
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overflow && (
              <Badge variant="warning">{t('badge.overflow')}</Badge>
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.verticalOverflow && (
              <Badge variant="warning">{t('badge.verticalOverflow')}</Badge>
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.emptyText && (
              <Badge variant="warning">{t('badge.emptyText')}</Badge>
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.invalidSize && (
              <Badge variant="danger">{t('badge.invalidSize')}</Badge>
            )}
          </div>
        )}

        {rowFontDisplayName && (
          <span
            title={rowFontDisplayName}
            className="text-micro text-fg-muted truncate leading-none"
          >
            {rowFontDisplayName}
          </span>
        )}
      </div>

      {/* Text — style-faithful preview (case A) that is click-to-edit.
          REQ-0471 §1: clicking selects + seeks + enters edit (unless frozen).
          Hover reveals the row action cluster (duplicate / delete) which does
          not occupy layout otherwise. */}
      <div
        className={cn(
          'relative flex items-center py-1 px-2 min-w-0 min-h-[22px] rounded transition-colors duration-150',
          !isFrozen && 'cursor-text',
          !editingText && isUserSelected && 'bg-surface-2/10',
          !editingText && !isFrozen && 'group-hover:bg-surface-2/20',
          editingText && 'bg-surface-2/20 ring-1 ring-inset ring-primary/40'
        )}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(entry.id)
          useUiStore.getState().setVideoSeekRequest(entry.startSec)
          if (!isFrozen && !editingText) setEditingText(true)
        }}
      >
        {editingText ? (
          <CellEditor
            value={entry.text.replace(/\\N/g, '\n')}
            onCommit={handleTextCommit}
            onCancel={handleTextCancel}
            onPreview={(text) => updateEntryPreview(entry.id, { text: text.replace(/\n/g, '\\N') })}
            multiline
          />
        ) : isFrozen ? (
          <span className="w-full text-body-sm leading-relaxed break-words whitespace-pre-wrap line-clamp-3 line-through text-fg-muted select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        ) : isAudioOnly ? (
          <span className="w-full text-body-sm leading-relaxed break-words whitespace-pre-wrap line-clamp-3 text-fg-primary select-text">
            {entry.text.replace(/\\N/g, '\n')}
          </span>
        ) : (
          <RowStylePreview
            entry={entry}
            videoWidthPx={videoWidthPx}
            containerWidthPx={textColWidthPx}
            lightweight={isScrolling}
          />
        )}

        {/* Hover action cluster — duplicate / delete (or restore).  Absolutely
            positioned so it never occupies row width (REQ-0471 §1 "常時occupy
            しない"); pointer-events only on the buttons themselves. */}
        {!editingText && (
          <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100">
            {!isFrozen && (
              <button
                type="button"
                title={t('action.duplicateRow')}
                aria-label={t('action.duplicateRow')}
                onClick={(e) => { e.stopPropagation(); handleDuplicate() }}
                className="pointer-events-auto flex h-6 w-6 items-center justify-center rounded bg-surface-1/90 text-fg-muted hover:bg-surface-2 hover:text-fg-secondary transition-colors"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            )}
            {!isTrimDeleted && (
              <button
                type="button"
                title={entry.isDeleted ? t('action.restoreRow') : t('action.deleteRow')}
                aria-label={entry.isDeleted ? t('action.restoreRow') : t('action.deleteRow')}
                onClick={(e) => { e.stopPropagation(); handleDeleteToggle() }}
                className={cn(
                  'pointer-events-auto flex h-6 w-6 items-center justify-center rounded bg-surface-1/90 transition-colors',
                  entry.isDeleted
                    ? 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
                    : 'text-fg-muted hover:bg-destructive/15 hover:text-destructive'
                )}
              >
                {entry.isDeleted ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Milliseconds after a manual scroll during which auto-scroll is suppressed. */
const AUTO_SCROLL_DEBOUNCE_MS = 3000

/**
 * REQ-0471 §3 — how long after the last scroll event the row previews stay in
 * the lightweight (CSS-only) mode before settling back to the full canvas
 * overlay.  Short enough that a stopped list snaps to full fidelity almost
 * immediately; long enough that a continuous fling never thrashes canvases.
 */
const SCROLL_SETTLE_MS = 140

/**
 * REQ-0345 §3-2 / REQ-0471 §2 — seed height for a row not yet measured.
 *
 * Lowered from 52 to 34 with the denser REQ-0471 row (tighter padding, single
 * compact meta line).  Only a starting guess: every mounted row is measured
 * for real via `measureElement`, and the virtualizer corrects total height and
 * offsets from those measurements.  Deliberately NOT derived from `overflowMap`
 * (that measures burn-in frame overflow, a different question).
 */
const ROW_ESTIMATED_HEIGHT_PX = 34

/** How long a newly-inserted row animates in (REQ-0345 §3-3). */
const ROW_ENTER_ANIM_MS = 150

export function SubtitleTable({
  overflowMap,
  warningsMap,
  videoDurationSec,
  onAdjustTime,
  visibleEntries,
}: {
  overflowMap: ReadonlyMap<string, number>
  warningsMap: ReadonlyMap<string, EntryWarnings>
  videoDurationSec: number
  onAdjustTime: (entryId: string) => void
  visibleEntries: readonly SubtitleEntry[]
}) {
  const { t } = useTranslation(['step2'])
  const cuts = useProjectStore((s) => s.cuts)
  // REQ-0471 §0.4 — native video width feeds the preview's `scale`
  // (containerWidth / videoWidth); fallback 1920 before a video loads.
  const videoWidthPx = useProjectStore((s) => s.video?.widthPx) ?? FALLBACK_VIDEO_WIDTH_PX
  const tableFilter = useUiStore((s) => s.tableFilter)
  const selectedEntryId = useUiStore((s) => s.selectedEntryId)
  const setSelectedEntryId = useUiStore((s) => s.setSelectedEntryId)
  const scrollToRowId = useUiStore((s) => s.scrollToRowId)
  const setScrollToRowId = useUiStore((s) => s.setScrollToRowId)
  const selectedRowIds = useUiStore((s) => s.selectedRowIds)
  const setRowSelection = useUiStore((s) => s.setRowSelection)
  const toggleRowSelected = useUiStore((s) => s.toggleRowSelected)
  const selectRowRange = useUiStore((s) => s.selectRowRange)

  // The scroll viewport — also what the virtualizer measures against.
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const lastUserScrollAt = useRef<number>(0)
  const isAutoScrollingRef = useRef(false)
  const autoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // REQ-0471 §0.4 — measured width of the text column, shared by every row's
  // style preview so the scale (and therefore the relative type size) is
  // identical across rows.  Measured once via ResizeObserver on the header's
  // text cell (same grid column as the body rows), so N rows do NOT each spin
  // up their own observer.
  const textColHeaderRef = useRef<HTMLDivElement>(null)
  const [textColWidthPx, setTextColWidthPx] = useState(0)
  useEffect(() => {
    const el = textColHeaderRef.current
    if (!el) return
    const obs = new ResizeObserver(() => setTextColWidthPx(el.clientWidth))
    obs.observe(el)
    setTextColWidthPx(el.clientWidth)
    return () => obs.disconnect()
  }, [])

  // REQ-0471 §3 — lightweight-preview toggle during active scrolling.  Flipped
  // ON on the first scroll event of a gesture and OFF SCROLL_SETTLE_MS after
  // the last, so the canvas ring's dep-array-less layout-effect never runs
  // during a fling.  Row height is identical in both modes, so the swap causes
  // no remeasure jump.
  const [isScrolling, setIsScrolling] = useState(false)
  const scrollSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let prevFocused = useUiStore.getState().focusedRowId
    const runAutoScroll = (focusedRowId: string | null) => {
      if (!focusedRowId) return
      if (Date.now() - lastUserScrollAt.current < AUTO_SCROLL_DEBOUNCE_MS) return
      const index = indexByIdRef.current.get(focusedRowId)
      if (index === undefined) return
      if (autoScrollTimerRef.current !== null) clearTimeout(autoScrollTimerRef.current)
      isAutoScrollingRef.current = true
      virtualizerRef.current.scrollToIndex(index, { align: 'auto', behavior: 'smooth' })
      autoScrollTimerRef.current = setTimeout(() => {
        isAutoScrollingRef.current = false
        autoScrollTimerRef.current = null
      }, 600)
    }
    runAutoScroll(prevFocused)
    return useUiStore.subscribe((s) => {
      if (s.focusedRowId === prevFocused) return
      prevFocused = s.focusedRowId
      runAutoScroll(s.focusedRowId)
    })
  }, [])

  function handleScroll() {
    // Skip scroll events that originate from our own scrollToIndex() calls.
    if (isAutoScrollingRef.current) return
    lastUserScrollAt.current = Date.now()
    // REQ-0471 §3 — engage lightweight previews for the duration of the gesture.
    if (!isScrolling) setIsScrolling(true)
    if (scrollSettleTimerRef.current !== null) clearTimeout(scrollSettleTimerRef.current)
    scrollSettleTimerRef.current = setTimeout(() => {
      setIsScrolling(false)
      scrollSettleTimerRef.current = null
    }, SCROLL_SETTLE_MS)
  }

  useEffect(() => {
    if (!scrollToRowId) return
    const targetId = scrollToRowId
    const timer = setTimeout(() => {
      const index = indexByIdRef.current.get(targetId)
      if (index !== undefined) {
        if (autoScrollTimerRef.current !== null) clearTimeout(autoScrollTimerRef.current)
        isAutoScrollingRef.current = true
        virtualizerRef.current.scrollToIndex(index, { align: 'center', behavior: 'smooth' })
        autoScrollTimerRef.current = setTimeout(() => {
          isAutoScrollingRef.current = false
          autoScrollTimerRef.current = null
        }, 600)
      }
      setScrollToRowId(null)
    }, 200)
    return () => clearTimeout(timer)
  }, [scrollToRowId, setScrollToRowId])

  const filtered = visibleEntries

  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ROW_ESTIMATED_HEIGHT_PX,
    getItemKey: (index) => filtered[index]?.id ?? index,
    overscan: 8,
  })

  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    for (let i = 0; i < filtered.length; i++) m.set(filtered[i].id, i)
    return m
  }, [filtered])
  const indexByIdRef = useRef(indexById)
  indexByIdRef.current = indexById
  const virtualizerRef = useRef(rowVirtualizer)
  virtualizerRef.current = rowVirtualizer

  const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(() => new Set())
  const knownIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const current = new Set(filtered.map((e) => e.id))
    const known = knownIdsRef.current
    knownIdsRef.current = current
    if (known === null) return
    const fresh: string[] = []
    for (const id of current) if (!known.has(id)) fresh.push(id)
    if (fresh.length === 0) return
    setEnteringIds(new Set(fresh))
    const timer = setTimeout(() => setEnteringIds(new Set()), ROW_ENTER_ANIM_MS)
    return () => clearTimeout(timer)
  }, [filtered])

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
    if (shiftKey) selectRowRange(id, selectableIds)
    else toggleRowSelected(id)
  }

  return (
    <div className="flex flex-col h-full">
      <div className={headerCols}>
        <div
          className="flex items-center justify-center py-1.5"
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
        <div className="py-1.5 px-1 text-caption font-normal text-fg-secondary text-center">{t('table.colIndex')}</div>
        <div className="py-1.5 px-1 text-caption font-normal text-fg-secondary">{t('table.colTime')}</div>
        {/* Ref target: this cell shares the body rows' text column width, so a
            single ResizeObserver here feeds every row's preview scale. */}
        <div ref={textColHeaderRef} className="py-1.5 px-2 text-caption font-normal text-fg-secondary">{t('table.colText')}</div>
      </div>
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto" onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex flex-col items-center justify-center gap-3 py-16"
          >
            <FileText className="h-8 w-8 text-fg-disabled" />
            <p className="text-body font-medium text-fg-tertiary">{t(emptyKey)}</p>
          </motion.div>
        ) : (
          <div
            style={{ height: rowVirtualizer.getTotalSize(), position: 'relative' }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const entry = filtered[virtualRow.index]
              if (!entry) return null
              const isEntering = enteringIds.has(entry.id)
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <div
                    className={cn(
                      isEntering && 'motion-safe:animate-in motion-safe:fade-in',
                    )}
                    style={isEntering ? { animationDuration: `${ROW_ENTER_ANIM_MS}ms` } : undefined}
                  >
                    <SubtitleRow
                      entry={entry}
                      displayIndex={virtualRow.index + 1}
                      overflowStartIndex={overflowMap.get(entry.id) ?? -1}
                      isUserSelected={selectedEntryId === entry.id}
                      onSelect={setSelectedEntryId}
                      warnings={warningsMap.get(entry.id) ?? NO_WARNINGS}
                      isStartExceedsDuration={entry.startSec > videoDurationSec}
                      isEndExceedsDuration={entry.endSec > videoDurationSec}
                      onAdjustTime={onAdjustTime}
                      isSelected={selectedRowIds.has(entry.id)}
                      onCheckboxClick={handleRowCheckboxClick}
                      clipStatus={effectiveEntryState(entry, cuts).status}
                      cuts={cuts}
                      videoWidthPx={videoWidthPx}
                      textColWidthPx={textColWidthPx}
                      isScrolling={isScrolling}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
