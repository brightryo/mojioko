import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Trash2, Undo2, Eraser, WrapText, AlignJustify, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { RowFontSelector } from '@/components/subtitle-table/row-font-selector'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { type EntryWarnings } from '@/lib/entry-warnings'
import {
  autoLineBreakRow as runAutoLineBreakRow,
  overflowWrapRow as runOverflowWrapRow,
  resetRow as runResetRow,
  toggleDeleteRow as runToggleDeleteRow
} from '@/lib/entry-row-actions'
import { formatEditedTimecode, editedDurationOfEntry } from '@/lib/time'
import { effectiveEntryState } from '../../../shared/cuts'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'
import type { FontId } from '../../../shared/fonts'
import type { SubtitleEntry } from '../../../shared/types'

interface TimelineBlockInspectorProps {
  entry: SubtitleEntry
  warnings: EntryWarnings | null
  /** Open the shared TimeEditorDialog (step2 owns it; we just forward the id). */
  onAdjustTime: (entryId: string) => void
  /** Close request from inside the inspector (e.g. after Adjust time click, X click). */
  onClose: () => void
}

/**
 * Popover body shown when a timeline block is clicked.  The layout
 * (REQ-061 #3) is, top → bottom:
 *
 *   1. Action icons (auto-line-break / delete-toggle / reset) on the
 *      left, X-close on the right.  All three actions reuse the shared
 *      `entry-row-actions` lib so the inspector and the subtitle-table
 *      drive identical history shapes and side effects.
 *   2. Status badges — `state.edited` plus every active warning, from
 *      the same source-of-truth `warningsMap` the table reads.
 *   3. Style controls (size / textColour / outlineColour / outlineWidth /
 *      fade) — hidden in audio-only mode.
 *   4. Per-row font (RowFontSelector) — same component the table cell uses.
 *   5. Text editor — blur commits the typed value (Ctrl+Enter / Esc
 *      shortcuts removed by REQ-082); `\n` ↔ `\N` round-trip retained.
 *   6. Time row — start / end / duration display plus "Adjust time" CTA
 *      that opens the shared TimeEditorDialog.
 *
 * The inspector NEVER auto-focuses the textarea (REQ-061 #2(a)): opening
 * a block highlights it but does not enter edit mode.  The parent
 * PopoverContent passes `onOpenAutoFocus={preventDefault}` so Radix
 * itself does not focus the first child either.
 */
export function TimelineBlockInspector({
  entry,
  warnings,
  onAdjustTime,
  onClose
}: TimelineBlockInspectorProps) {
  const { t } = useTranslation(['step2', 'common', 'step1'])
  const updateEntry = useProjectStore((s) => s.updateEntry)
  const pushHistory = useHistoryStore((s) => s.push)
  const isAudioOnly = useIsAudioOnly()

  // Local draft so typing doesn't dispatch on every keystroke.  Initial
  // value uses `\n` so the textarea renders multi-line correctly; we
  // convert back to `\N` on commit.
  const initialDraft = entry.text.replace(/\\N/g, '\n')
  const [draft, setDraft] = useState(initialDraft)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [sizeOutOfRange, setSizeOutOfRange] = useState(false)
  // REQ-20260612-004: same dirty / composing pattern as CellEditor in
  // subtitle-table.tsx.  The Inspector's textarea is always mounted
  // (unlike CellEditor, which is gated by `editingText`), so without
  // these guards an external `updateEntry({text})` (e.g. from the
  // 敷き詰め改行 / はみ出し改行 buttons immediately above this
  // textarea) writes to the store but never reaches `draft`, the
  // textarea keeps displaying the pre-wrap text, and the next blur
  // silently overwrites the wrap with that stale value.  See
  // RES-20260612-004 §3 for the full root-cause analysis.
  const dirtyRef = useRef(false)
  const isComposingRef = useRef(false)

  // Accept external entry.text updates while the inspector is open
  // and the textarea is mounted, gated by:
  //   - dirtyRef.current === false → user hasn't typed since the
  //     last commit, so there's nothing to lose by re-syncing
  //   - isComposingRef.current === false → mid-IME composition
  //     would have the candidate window wiped if we touched value
  useEffect(() => {
    if (dirtyRef.current) return
    if (isComposingRef.current) return
    setDraft(entry.text.replace(/\\N/g, '\n'))
  }, [entry.text])

  function commitText(next: string) {
    // Round-trip newlines back to ASS \N
    const normalized = next.replace(/\n/g, '\\N')
    if (normalized === entry.text) {
      // No actual change to commit, but we still clear the dirty flag
      // so a subsequent external update is allowed to sync into draft.
      dirtyRef.current = false
      return
    }
    const snapshot = { ...entry }
    const patch = { text: normalized, isEdited: true }
    pushHistory({
      label: t('history.editText'),
      undo: () => updateEntry(entry.id, snapshot),
      redo: () => updateEntry(entry.id, { ...snapshot, ...patch })
    })
    updateEntry(entry.id, patch)
    dirtyRef.current = false
  }

  /**
   * History-aware style patch.  Mirrors subtitle-table.tsx's `withHistory`
   * helper so Inspector edits and table edits share both the history
   * shape and the auto-mark-edited side effect.  Time fields are
   * deliberately NOT supported here — those flow through the dedicated
   * TimeEditorDialog or drag handlers in TimelineView.
   */
  function applyStyleEdit(label: string, patch: Partial<SubtitleEntry>) {
    const snapshot = { ...entry }
    pushHistory({
      label,
      undo: () => updateEntry(entry.id, snapshot),
      redo: () => updateEntry(entry.id, { ...snapshot, ...patch, isEdited: true })
    })
    updateEntry(entry.id, { ...patch, isEdited: true })
  }

  function handleSizeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10)
    setSizeOutOfRange(!isNaN(v) && (v < FONT_SIZE_MIN_PX || v > FONT_SIZE_MAX_PX))
  }
  function handleSizeBlur(e: React.FocusEvent<HTMLInputElement>) {
    setSizeOutOfRange(false)
    const v = parseInt(e.target.value, 10)
    if (isNaN(v)) return
    const clamped = Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, v))
    if (clamped === entry.fontSizePx) return
    applyStyleEdit(t('history.editSize'), { fontSizePx: clamped })
  }
  function handleTextColorChange(hex: string) {
    applyStyleEdit(t('history.editColor'), { textColorHex: hex })
  }
  function handleOutlineColorChange(hex: string) {
    applyStyleEdit(t('history.editColor'), { outlineColorHex: hex })
  }
  function handleColorPairApply(text: string, outline: string) {
    applyStyleEdit(t('history.editColor'), {
      textColorHex: text,
      outlineColorHex: outline
    })
  }
  function handleOutlineThicknessCommit(v: number) {
    applyStyleEdit(t('history.editStroke'), { outlineThicknessPx: v })
  }
  function handleFadeChange(checked: boolean) {
    applyStyleEdit(t('history.editFade'), { fadeEnabled: checked })
  }
  function handleFontChange(next: FontId | undefined) {
    if (next === entry.fontId) return
    applyStyleEdit(t('history.editFont'), { fontId: next })
  }

  // REQ-082: Ctrl+Enter / Esc removed.  handleBlur (= focus leaves the
  // textarea — click elsewhere or close the inspector) commits the
  // text.  The inspector itself closes via its X button.

  // REQ-20260612-004: only commit on blur when the user has actually
  // typed since the last commit / sync.  Without this, blur would
  // unconditionally write `draft` (which may be stale relative to a
  // just-applied wrap on entry.text) back into the store, undoing
  // the wrap.  The change handler sets dirtyRef on every keystroke;
  // commitText / the value-sync effect clear it.
  function handleBlur() {
    if (!dirtyRef.current) return
    commitText(draft)
  }
  function handleDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    dirtyRef.current = true
    setDraft(e.target.value)
  }
  function handleCompositionStart() {
    isComposingRef.current = true
  }
  function handleCompositionEnd(e: React.CompositionEvent<HTMLTextAreaElement>) {
    isComposingRef.current = false
    // Treat a committed IME composition as a user edit so the next
    // blur flushes the converted text.  `e.target.value` already
    // reflects the post-composition value when this fires.
    dirtyRef.current = true
    setDraft((e.target as HTMLTextAreaElement).value)
  }

  // -------------------------------------------------------------------------
  // Top-bar action handlers — REQ-061 #3.  All three reuse the shared
  // `entry-row-actions` lib so the inspector and subtitle-table commit
  // identical history ops.
  // -------------------------------------------------------------------------

  async function handleAutoLineBreak() {
    // Commit any pending text edit first so the rewrap starts from the
    // committed value rather than a stale draft.
    commitText(draft)
    await runAutoLineBreakRow(entry, {
      history: t('history.autoLineBreak'),
      noChangeToast: t('bulk.autoLineBreakNoChange')
    })
  }

  async function handleOverflowWrap() {
    // Same commit-first pattern as handleAutoLineBreak so the rewrap
    // sees the committed text rather than a stale draft.
    commitText(draft)
    await runOverflowWrapRow(entry, {
      history: t('history.overflowWrap'),
      noChangeToast: t('bulk.overflowWrapNoChange')
    })
  }

  function handleDeleteToggle() {
    runToggleDeleteRow(entry, {
      delete: t('history.deleteRow'),
      restore: t('history.restoreRow')
    })
  }

  function handleReset() {
    runResetRow(entry, { reset: t('history.resetRow') })
  }

  function handleAdjustTime() {
    // Commit any pending text edit first so blur doesn't race with
    // the dialog opening.
    commitText(draft)
    onClose()
    onAdjustTime(entry.id)
  }

  // REQ-115 — duration shown to the user is the visible-on-Edited-axis
  // duration so a middle-cut entry reads as the actual surviving length
  // (= what the burnin video will show), not the pre-cut span.
  const cuts = useProjectStore((s) => s.cuts)
  const durationSec = editedDurationOfEntry(entry, cuts)
  // REQ-118 [2] — mirror the subtitle-table freeze rule: trim-deleted
  // entries are read-only and the Delete affordance hands a hint
  // toast instead of toggling `entry.isDeleted` (which would silently
  // swap the row from trimDeleted to manuallyDeleted).
  const isTrimDeleted = effectiveEntryState(entry, cuts).status === 'trimDeleted'
  const isFrozen = entry.isDeleted || isTrimDeleted
  // REQ-119 [2] — Reset is an EDIT (= wipe per-row overrides back to
  // `entry.original`).  A frozen row only accepts the Restore button
  // next to it; the table chrome already rejects the Reset for the
  // same row, this keeps the inspector aligned.  Live rows still need
  // `entry.isEdited` to have something to reset.
  const canReset = !isFrozen && entry.isEdited

  // Aggregate "any warning visible" so §2 (badge row) only renders when
  // there's actually something to show.  Empty-text is included because
  // the table's badge row shows it; matching behaviour keeps both views
  // consistent for users alternating between them.
  const hasAnyBadge =
    entry.isEdited ||
    (warnings != null &&
      (warnings.timeInvalid ||
        warnings.overlap ||
        warnings.overDuration ||
        warnings.overflow ||
        warnings.emptyText ||
        warnings.invalidSize))

  return (
    <div className="flex flex-col gap-3 w-[320px] text-zinc-100 max-h-[70vh] overflow-y-auto pr-1">
      {/* § 1 — Action icons + close.  REQ-20260612-003 §2 §3:
          icon-only buttons in order 敷き詰め改行 → はみ出し改行 →
          削除/復元 → リセット, then the X close on the right.  Both
          wrap buttons are suppressed in audio-only mode (no burn-in
          pipeline consumes the rewrap). */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {!isAudioOnly && (
            <>
              <button
                type="button"
                title={t('action.autoLineBreakRowHelp')}
                aria-label={t('action.autoLineBreakRowHelp')}
                onClick={handleAutoLineBreak}
                disabled={isFrozen}
                className={cn(
                  'flex items-center justify-center h-7 w-7 rounded',
                  'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
                  'transition-colors duration-150',
                  'disabled:opacity-30 disabled:pointer-events-none'
                )}
              >
                <AlignJustify className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                title={t('action.overflowWrapRowHelp')}
                aria-label={t('action.overflowWrapRowHelp')}
                onClick={handleOverflowWrap}
                disabled={isFrozen}
                className={cn(
                  'flex items-center justify-center h-7 w-7 rounded',
                  'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
                  'transition-colors duration-150',
                  'disabled:opacity-30 disabled:pointer-events-none'
                )}
              >
                <WrapText className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {/* REQ-118 [2] — same three-branch rule as the subtitle-table
              row.  Trim-deleted entries show the restore glyph in
              zinc and surface a hint toast on click; the storage
              state never toggles. */}
          <button
            type="button"
            title={
              isTrimDeleted
                ? t('action.trimDeletedHint')
                : entry.isDeleted
                  ? t('action.restoreRow')
                  : t('action.deleteRow')
            }
            aria-label={
              isTrimDeleted
                ? t('action.trimDeletedHint')
                : entry.isDeleted
                  ? t('action.restoreRow')
                  : t('action.deleteRow')
            }
            onClick={() => {
              if (isTrimDeleted) {
                toast.info(t('toast.trimDeletedRestoreHint'))
                return
              }
              handleDeleteToggle()
            }}
            className={cn(
              'flex items-center justify-center h-7 w-7 rounded',
              'transition-colors duration-150 hover:bg-zinc-800',
              entry.isDeleted && !isTrimDeleted
                ? 'text-green-400 hover:text-green-300'
                : 'text-zinc-400 hover:text-zinc-100'
            )}
          >
            {isTrimDeleted || entry.isDeleted
              ? <Undo2 className="h-3.5 w-3.5" />
              : <Trash2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            title={t('action.resetRow')}
            aria-label={t('action.resetRow')}
            onClick={handleReset}
            disabled={!canReset}
            className={cn(
              'flex items-center justify-center h-7 w-7 rounded',
              'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
              'transition-colors duration-150',
              'disabled:opacity-30 disabled:pointer-events-none'
            )}
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
        </div>
        <button
          type="button"
          title={t('common:action.close')}
          aria-label={t('common:action.close')}
          onClick={onClose}
          className={cn(
            'flex items-center justify-center h-7 w-7 rounded',
            'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
            'transition-colors duration-150'
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* § 2 — Status badges.  `state.edited` first, then warnings in the
          same order the table uses (matches user expectations across
          views). */}
      {hasAnyBadge && (
        <div className="flex flex-wrap gap-1">
          {entry.isEdited && !entry.isDeleted && (
            <Badge variant="default">{t('state.edited')}</Badge>
          )}
          {/* REQ-121 — errors (timeInvalid / overDuration / invalidSize)
              wear the danger variant; warnings (overlap / overflow /
              emptyText) keep the warning amber. */}
          {warnings?.timeInvalid  && <Badge variant="danger">{t('badge.timeInvalid')}</Badge>}
          {warnings?.overlap      && <Badge variant="warning">{t('badge.overlap')}</Badge>}
          {warnings?.overDuration && <Badge variant="danger">{t('badge.overDuration')}</Badge>}
          {warnings?.overflow     && <Badge variant="warning">{t('badge.overflow')}</Badge>}
          {warnings?.emptyText    && <Badge variant="warning">{t('badge.emptyText')}</Badge>}
          {warnings?.invalidSize  && <Badge variant="danger">{t('badge.invalidSize')}</Badge>}
        </div>
      )}

      {/* § 3 — Style.  Hidden in audio-only mode (REQ-028) because none
          of these fields reach text/SRT export. */}
      {!isAudioOnly && (
        <div className="space-y-2 border-t border-zinc-800 pt-2">
          {/* Size */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-zinc-300">{t('styleCell.size')}</label>
            <input
              type="number"
              min={FONT_SIZE_MIN_PX}
              max={FONT_SIZE_MAX_PX}
              defaultValue={entry.fontSizePx}
              key={entry.fontSizePx}
              onChange={handleSizeChange}
              onBlur={handleSizeBlur}
              disabled={isFrozen}
              title={t('step1:subtitleDefaults.sizeHint', {
                min: FONT_SIZE_MIN_PX,
                max: FONT_SIZE_MAX_PX
              })}
              className={cn(
                // Phase 3.5: size input bumped to `body` (15) so the numeric
                // value reads at the same scale as the screen's body content
                // instead of sitting one tier below the field label
                // (callout 13/600).
                'w-20 h-7 rounded border bg-zinc-950 px-1.5 text-center text-body text-zinc-100',
                'focus:outline-none focus:ring-1',
                '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                sizeOutOfRange
                  ? 'border-amber-400/60 focus:ring-amber-400/30'
                  : 'border-zinc-700 focus:border-zinc-600 focus:ring-green-500/30'
              )}
            />
          </div>

          {/* Text colour */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-zinc-300">{t('styleCell.textColor')}</label>
            <ColorPicker
              value={entry.textColorHex}
              onChange={handleTextColorChange}
              onPairApply={handleColorPairApply}
              disabled={isFrozen}
              swatchOnly
            />
          </div>

          {/* Outline colour */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-zinc-300">{t('styleCell.outlineColor')}</label>
            <ColorPicker
              value={entry.outlineColorHex}
              onChange={handleOutlineColorChange}
              onPairApply={handleColorPairApply}
              disabled={isFrozen}
              swatchOnly
            />
          </div>

          {/* Outline width — shared slider component (same as subtitle-table
              per-row + bulk-edit-bar). */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-zinc-300">{t('styleCell.outlineWidth')}</label>
            <div className="w-[160px]" onClick={(e) => e.stopPropagation()}>
              <OutlineThicknessSlider
                value={entry.outlineThicknessPx}
                onCommit={handleOutlineThicknessCommit}
                disabled={isFrozen}
                ariaLabel={t('styleCell.outlineWidth')}
              />
            </div>
          </div>

          {/* Fade */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-zinc-300">{t('styleCell.fade')}</label>
            <Switch
              checked={entry.fadeEnabled}
              onCheckedChange={handleFadeChange}
              disabled={isFrozen}
              className="scale-75 origin-right"
            />
          </div>
        </div>
      )}

      {/* § 4 — Font.  Per-row override via the shared RowFontSelector. */}
      {!isAudioOnly && (
        <div className="space-y-1 border-t border-zinc-800 pt-2">
          <label className="text-callout font-semibold text-zinc-300 block">{t('bulkRowFont.label')}</label>
          <RowFontSelector
            value={entry.fontId}
            onChange={handleFontChange}
            disabled={isFrozen}
          />
        </div>
      )}

      {/* § 5 — Text editor.  Blur commits the typed value
          (Ctrl+Enter / Esc shortcuts removed by REQ-082).  No
          auto-focus on mount — see PopoverContent's
          `onOpenAutoFocus={preventDefault}` upstream. */}
      <div className="border-t border-zinc-800 pt-2">
        <label className="block text-label text-zinc-500 mb-1">
          {t('timeline.inspector.textLabel')}
        </label>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleDraftChange}
          onBlur={handleBlur}
          onCompositionStart={handleCompositionStart}
          onCompositionEnd={handleCompositionEnd}
          rows={3}
          disabled={isFrozen}
          spellCheck={false}
          className={cn(
            'w-full rounded-md bg-zinc-950 border border-zinc-700 px-2 py-1.5',
            'text-body text-zinc-50 leading-snug resize-none',
            'focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500/30',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
        {/* REQ-082: "Ctrl+Enter to commit · Esc to cancel" hint
            removed — both shortcuts have been deleted. */}
      </div>

      {/* § 6 — Time row.  Read-only display + adjust-time CTA at the
          bottom of the inspector to match the visual hierarchy "act
          first → see status → tweak content → finally time" agreed for
          REQ-061.
          Phase 3.5: the timecode row was lifted 11 → body-sm (13) in
          Phase 3 and stopped fitting on a single line beside the
          adjust-time chip inside the 320-px popover (the JP label
          「時間を調整」 wraps to「時間/を調」at 13-px mono + chip width).
          Split into two stacked rows: timecodes top, chip bottom-right.
          flex-col + self-end keeps the chip aligned to the popover's
          right edge so the affordance still feels "next to" the
          time it modifies. */}
      <div className="flex flex-col gap-1.5 border-t border-zinc-800 pt-2">
        <div className="flex items-baseline gap-1 text-body-sm font-mono tabular-nums text-zinc-400">
          <span>{formatEditedTimecode(entry.startSec, cuts)}</span>
          <span className="text-zinc-600">→</span>
          <span>{formatEditedTimecode(entry.endSec, cuts)}</span>
          <span className="ml-1 text-zinc-500">
            ({durationSec.toFixed(2)}s)
          </span>
        </div>
        {/* Phase 3.7-C: button moved self-end -> self-start (left-aligned)
            per owner directive; trailing ellipsis removed from the locale
            string because the dialog opens immediately without further
            confirmation, so the "…" promised more steps than there are. */}
        <button
          type="button"
          onClick={handleAdjustTime}
          className={cn(
            'self-start flex items-center gap-1 h-6 px-2 rounded text-caption text-zinc-400',
            'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150'
          )}
        >
          <Clock className="h-3 w-3" />
          {t('timeline.inspector.adjustTime')}
        </button>
      </div>
    </div>
  )
}
