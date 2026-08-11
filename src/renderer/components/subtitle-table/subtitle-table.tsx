import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  FileText, Clock, ArrowRight, Copy, Trash2, RotateCcw,
  Pencil, Scissors, CircleAlert, Layers, Hourglass, Ban, Ruler, MoveVertical, WrapText,
  type LucideIcon,
} from 'lucide-react'
import { motion } from 'framer-motion'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
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
 * REQ-0473 §1 — two-tier list row.
 *
 * The REQ-0471 single-line 4-column row squeezed the time into a 184px meta
 * column, so on a real (narrow) window the timecode truncated to "00:…→00:…".
 * The row is now `[checkbox | content]`, with `content` a two-tier stack that
 * gives the top tier the FULL row width:
 *
 *   ┌ top tier (small):  #  time "start → end · dur" (full) │ font name │ [dup][del]
 *   └ bottom tier:        [state badges]                     │ text preview
 *
 * The checkbox column spans both tiers (grid row, vertically centred).  The
 * text preview area is deliberately narrower than before — the freed width
 * goes to the badge/state area on the left (owner spec §1).
 */
const TABLE_GRID_COLS = 'grid-cols-[34px_1fr]'

/**
 * REQ-0473 §1 / REQ-0474 §2 — fixed width of the bottom-tier state area (left
 * of the text preview).  Narrowed from 150 to 120 once the badges became
 * ICON-ONLY (REQ-0474 §2): ~16px per icon packs the common 1-3 states on one
 * row and even the worst case (all states) into two, while the preview stays
 * aligned across rows (fixed width) and gains the freed space.
 */
/**
 * REQ-0474 §2 / REQ-0478 §2 — fixed width of the bottom-tier state area.  Moved
 * to the RIGHT of the row (roughly under the top-tier duplicate/delete buttons)
 * in REQ-0478.  ICON-ONLY (REQ-0474 §2): ~16px per icon packs the common 1-3
 * states on one row.  ALWAYS reserved (even when a row has no badges) so the
 * text area's right edge is constant across rows.  Owner "黄枠" measured ~100px;
 * kept at 120 as a starting point — tune here if the difference reads.
 */
const BADGE_AREA_PX = 120
/** Horizontal gap (px) between the text area and the (now right-hand) badges. */
const BOTTOM_TIER_GAP_PX = 12
/** Checkbox column width (px) — mirrors TABLE_GRID_COLS col 1. */
const CHECKBOX_COL_PX = 34
/**
 * Content column's right padding (px) — the `pr-2` on the content div.  The
 * top-tier actions AND the bottom-tier badges both sit this far from the row's
 * right edge, so the badges land under the actions (REQ-0478 §2).
 */
const CONTENT_PR_PX = 8
/**
 * REQ-0478 §1 — OPTIONAL upper bound on the text area width.  Default `null` =
 * NO cap: the text area is the whole remaining bottom-tier width (checkbox →
 * badges).  Set a number to re-introduce a cap.  (Superseded REQ-0477's 545px
 * right-aligned cap; the block is now left-anchored and fills the row.)
 */
const TEXT_COL_MAX_PX: number | null = null

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

/**
 * REQ-0474 §2 — a compact state indicator: a distinct-SHAPE lucide icon plus a
 * native `title` tooltip carrying the full label.  Meaning is carried by the
 * icon shape (+ tooltip), never by colour alone — colour only grades severity
 * (danger / warning / neutral).  Icon-only packs the state area far tighter
 * than the old text badges, which wrapped raggedly at a fixed 150px.
 */
function StatusIcon({
  Icon,
  label,
  severity,
}: {
  Icon: LucideIcon
  label: string
  severity: 'danger' | 'warning' | 'neutral'
}) {
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={cn(
        'flex h-4 w-4 items-center justify-center',
        severity === 'danger' && 'text-destructive',
        severity === 'warning' && 'text-warning-soft',
        severity === 'neutral' && 'text-fg-secondary'
      )}
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  )
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
  /** Measured text-column width, shared by every row (see table JSDoc). */
  textColWidthPx: number
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
  textColWidthPx,
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

  // REQ-0473 §1 — font name is shown for EVERY row in the top tier (centre),
  // resolving the per-row override or the inherited project default.  Editing
  // the font still lives in the Inspector / Bulk bar.
  const resolvedFontId = isFontId(entry.fontId) ? entry.fontId : activeFontId
  const rowFontDisplayName = getFontMeta(resolvedFontId).displayName

  // REQ-0473 §1 — FULL timecodes (no compaction / truncation): the top tier
  // has the whole row width, so "00:00:00.00 → 00:00:07.36" fits.
  const startTc = formatEditedTimecode(entry.startSec, cuts)
  const endTc = formatEditedTimecode(entry.endSec, cuts)
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

  const timeExceeds = isStartExceedsDuration || isEndExceedsDuration

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
      {/* Selection checkbox — 34px column spanning BOTH tiers (grid row,
          vertically centred).  Full tap area via the full-height flex box. */}
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

      {/* Content — two tiers (REQ-0473 §1).  Tight vertical padding to keep the
          density loss from the second tier minimal (§3). */}
      <div className="flex flex-col min-w-0 py-0.5 pr-2">
        {/* ── Top tier: # + full time (left) | font (centre) | actions (right) ── */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0 flex-shrink-0">
            <span className="text-micro text-fg-muted font-mono tabular-nums">{displayIndex}</span>
            <button
              type="button"
              data-testid="adjust-time"
              onClick={(e) => { e.stopPropagation(); onAdjustTime(entry.id) }}
              disabled={isFrozen}
              title={timeExceeds ? t('warning.exceedsDuration') : t('action.adjustTime')}
              className={cn(
                'flex items-center gap-1 rounded px-1 -ml-1 text-micro font-mono tabular-nums whitespace-nowrap',
                'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary transition-colors duration-100',
                'disabled:opacity-40 disabled:pointer-events-none',
                timeExceeds && 'text-warning-soft'
              )}
            >
              <Clock className="h-3 w-3 flex-shrink-0 text-fg-muted" />
              <span>{startTc}</span>
              <ArrowRight className="h-2.5 w-2.5 flex-shrink-0 text-fg-muted" />
              <span>{endTc}</span>
              <span className="text-fg-muted">· {durSec.toFixed(2)}s</span>
            </button>
          </div>

          {/* Centre: font name (always shown, truncates when long). */}
          <span
            title={rowFontDisplayName}
            className="flex-1 min-w-0 text-center truncate text-micro text-fg-muted"
          >
            {isAudioOnly ? '' : rowFontDisplayName}
          </span>

          {/* Right: duplicate / delete — ALWAYS visible (REQ-0473 §1: no hover
              dependency, better discoverability). */}
          <div className="flex items-center gap-0.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            {!isFrozen && (
              <button
                type="button"
                title={t('action.duplicateRow')}
                aria-label={t('action.duplicateRow')}
                onClick={(e) => { e.stopPropagation(); handleDuplicate() }}
                className="flex h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg-secondary transition-colors"
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
                  'flex h-5 w-5 items-center justify-center rounded transition-colors',
                  entry.isDeleted
                    ? 'text-fg-muted hover:bg-surface-2 hover:text-fg-secondary'
                    : 'text-fg-muted hover:bg-destructive/15 hover:text-destructive'
                )}
              >
                {entry.isDeleted ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
              </button>
            )}
          </div>
        </div>

        {/* ── Bottom tier: text preview (left, full width) | … gap … | state
            badges (right, REQ-0478) ── */}
        <div className="flex items-start min-w-0 mt-0.5 gap-3">
          {/* Text preview — LEFT-anchored, fills the remaining width (REQ-0478
              §1).  Fixed width = `textColWidthPx` so it matches the
              `containerWidthPx` the shrink-to-fit maths uses (REQ-0476); no
              horizontal padding so the fit-content block's left edge is constant
              across rows.  Click to select + edit (unless frozen). */}
          <div
            style={{ width: `${textColWidthPx}px` }}
            className={cn(
              'flex items-center flex-shrink-0 min-w-0 min-h-[22px] rounded transition-colors duration-150',
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
              <RowStylePreview entry={entry} containerWidthPx={textColWidthPx} />
            )}
          </div>

          {/* State — compact icon-only indicators (REQ-0474 §2), moved to the
              RIGHT (REQ-0478 §2, under the top-tier actions).  Fixed width,
              ALWAYS reserved so the text area's right edge is constant even on
              rows with no badges. */}
          <div
            className="flex flex-wrap items-center justify-end gap-1 flex-shrink-0 self-center"
            style={{ width: `${BADGE_AREA_PX}px` }}
          >
            {clipStatus === 'manuallyDeleted' && (
              <StatusIcon Icon={Trash2} label={t('state.deleted')} severity="danger" />
            )}
            {clipStatus === 'trimDeleted' && (
              <StatusIcon Icon={Scissors} label={t('state.trimDeleted')} severity="danger" />
            )}
            {(entry.isEdited || clipStatus === 'edited') && (
              <StatusIcon Icon={Pencil} label={t('state.edited')} severity="neutral" />
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.timeInvalid && (
              <StatusIcon Icon={CircleAlert} label={t('badge.timeInvalid')} severity="danger" />
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overlap && (
              <StatusIcon Icon={Layers} label={t('badge.overlap')} severity="warning" />
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overDuration && (
              <StatusIcon Icon={Hourglass} label={t('badge.overDuration')} severity="danger" />
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.overflow && (
              <StatusIcon Icon={WrapText} label={t('badge.overflow')} severity="warning" />
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.verticalOverflow && (
              <StatusIcon Icon={MoveVertical} label={t('badge.verticalOverflow')} severity="warning" />
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.emptyText && (
              <StatusIcon Icon={Ban} label={t('badge.emptyText')} severity="warning" />
            )}
            {clipStatus !== 'manuallyDeleted' && clipStatus !== 'trimDeleted' && warnings.invalidSize && (
              <StatusIcon Icon={Ruler} label={t('badge.invalidSize')} severity="danger" />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Milliseconds after a manual scroll during which auto-scroll is suppressed. */
const AUTO_SCROLL_DEBOUNCE_MS = 3000

/**
 * REQ-0345 §3-2 / REQ-0473 §3 — seed height for a row not yet measured.
 *
 * Raised to ~48 for the two-tier row (top meta tier ~18px + bottom preview tier
 * ~26px + padding).  Only a starting guess: every mounted row is measured for
 * real via `measureElement`, and the virtualizer corrects total height and
 * offsets from those measurements.  Deliberately NOT derived from `overflowMap`
 * (that measures burn-in frame overflow, a different question).
 */
const ROW_ESTIMATED_HEIGHT_PX = 48

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
  // REQ-0473 §1 — the text-preview area is the bottom-tier remainder after the
  // checkbox column and the fixed-width badge area.  Derived from the scroll
  // viewport width (one ResizeObserver, shared by every row) rather than a
  // per-row measurement.
  const [textColWidthPx, setTextColWidthPx] = useState(0)
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const recompute = () => {
      // REQ-0478 §1 — the text area is the FULL remaining bottom-tier width:
      // viewport − checkbox − content-right-pad − gap − badges (badges now on
      // the right).  Left-anchored, no right margin (the badge area IS the right
      // region).  Optional TEXT_COL_MAX_PX cap; default null = no cap.
      const avail =
        el.clientWidth -
        CHECKBOX_COL_PX -
        CONTENT_PR_PX -
        BOTTOM_TIER_GAP_PX -
        BADGE_AREA_PX
      const capped = TEXT_COL_MAX_PX === null ? avail : Math.min(TEXT_COL_MAX_PX, avail)
      setTextColWidthPx(Math.max(80, capped))
    }
    const obs = new ResizeObserver(recompute)
    obs.observe(el)
    recompute()
    return () => obs.disconnect()
  }, [])

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
      {/* REQ-0473 §1 — two-column header: select-all checkbox + a single label
          band (the per-column labels no longer map onto the two-tier row). */}
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
        <div className="flex items-center gap-3 py-1.5 pr-2 text-caption font-normal text-fg-secondary">
          <span>{t('table.colTime')}</span>
          <span className="flex-1" />
          <span>{t('table.colText')}</span>
        </div>
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
                      textColWidthPx={textColWidthPx}
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
