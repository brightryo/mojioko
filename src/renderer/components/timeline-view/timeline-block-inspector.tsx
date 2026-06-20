import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Trash2, Undo2, Eraser, WrapText, AlignJustify, CopyPlus, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { HelpIcon } from '@/components/help-icon'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { RowFontSelector } from '@/components/subtitle-table/row-font-selector'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { type EntryWarnings } from '@/lib/entry-warnings'
import {
  autoLineBreakRow as runAutoLineBreakRow,
  overflowWrapRow as runOverflowWrapRow,
  resetRow as runResetRow,
  toggleDeleteRow as runToggleDeleteRow,
  duplicateRow as runDuplicateRow
} from '@/lib/entry-row-actions'
import { formatEditedTimecode, editedDurationOfEntry } from '@/lib/time'
import { getAnchorAssPosition, clampAssPosition } from '@/lib/preview-coords'
import { effectiveEntryState } from '../../../shared/cuts'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'
import type { FontId } from '../../../shared/fonts'
import type { SubtitleEntry } from '../../../shared/types'

interface TimelineBlockInspectorProps {
  entry: SubtitleEntry
  warnings: EntryWarnings | null
  /** Open the shared TimeEditorDialog (step2 owns it; we just forward the id). */
  onAdjustTime: (entryId: string) => void
}

/**
 * REQ-20260615-014 B: inline single-select segmented control used by the
 * Layout (horizontal / vertical) and Background (colour) rows in place of
 * the native `<select>` triggers.  Kept local to the inspector since it is
 * the only consumer; mira-style compact (h-7, rounded-md track with
 * rounded-[3px] pills, text-caption labels).
 *
 * REQ-20260615-015: target width is ~40% of the row with `min-w-fit` as a
 * floor so labels like "中央" / "Center" never truncate.  Pills keep
 * `flex-1` but drop `min-w-0` — without that escape hatch each pill's
 * content (the label text) sets its own minimum width.
 */
function SegmentGroup<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: T
  onChange: (next: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  ariaLabel: string
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'flex h-7 w-[40%] min-w-fit items-stretch gap-0.5 rounded-md border border-line-strong bg-surface-0 p-0.5',
        disabled && 'opacity-40 pointer-events-none'
      )}
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'flex-1 inline-flex items-center justify-center rounded-[3px] px-2 text-caption font-medium transition-colors duration-150',
              'focus:outline-none focus-visible:outline-none',
              selected
                ? 'bg-primary text-fg-inverse'
                : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-2'
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Editor body shown in STEP 2's always-on right-pane Inspector
 * (REQ-20260614-001 補遺③).  Sections top → bottom:
 *
 *   1. Action icons (敷き詰め改行 / はみ出し改行 / 削除-復元 / リセット /
 *      複製) — × close button retired in 補遺③.
 *   2. Status badges (`state.edited` / pinned / per-warning).
 *   3. Time display + Adjust time CTA.
 *   4. Text editor (3-row textarea, blur to commit).
 *   5. Font selector (RowFontSelector).
 *   6.–16. Style cluster (size / text colour / outline colour / outline
 *      width / fade / horizontal / vertical / margin / background
 *      enabled / background colour / background opacity).
 *
 * The inspector NEVER auto-focuses the textarea (REQ-061 #2(a)): opening
 * an entry highlights it but does not enter edit mode.
 */
export function TimelineBlockInspector({
  entry,
  warnings,
  onAdjustTime,
}: TimelineBlockInspectorProps) {
  const { t } = useTranslation(['step2', 'common', 'step1'])
  const updateEntry = useProjectStore((s) => s.updateEntry)
  const pushHistory = useHistoryStore((s) => s.push)
  const isAudioOnly = useIsAudioOnly()
  // REQ-20260615-033: offset row needs the output video resolution to
  // compute the alignment-based anchor.  `video` is null while a project
  // is still loading; the offset row hides itself in that case.
  const video = useProjectStore((s) => s.video)

  // REQ-20260615-033 — derive the offset row's display values from the
  // alignment-based anchor.  When `posX`/`posY` are undefined the row
  // is unpinned and offsets display as 0; entering non-zero values
  // pins it via `applyOffset` below.  Recomputes whenever the entry
  // changes (drag, undo/redo) OR a layout field changes (anchor moves),
  // so the displayed offset always reflects the live distance from the
  // current anchor (= the home position the row would snap back to on
  // unpin).
  const isPinned = entry.posX !== undefined && entry.posY !== undefined
  const showOffsetRow = !isAudioOnly && !!video && video.hasVideoStream
  let offsetX = 0
  let offsetY = 0
  if (showOffsetRow && video) {
    const anchor = getAnchorAssPosition(
      entry.horizontalPosition,
      entry.verticalPosition,
      entry.verticalMarginPx,
      video.widthPx,
      video.heightPx,
    )
    offsetX = isPinned ? Math.round((entry.posX as number) - anchor.x) : 0
    offsetY = isPinned ? Math.round((entry.posY as number) - anchor.y) : 0
  }

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
  /** REQ-20260615-017: ±10 stepper buttons flanking the size input. */
  function handleSizeStep(delta: number) {
    const next = Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, entry.fontSizePx + delta))
    if (next === entry.fontSizePx) return
    applyStyleEdit(t('history.editSize'), { fontSizePx: next })
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

  // REQ-20260613-016 Phase 5 — per-row layout / background handlers
  // mirror subtitle-table.tsx so the inspector and the list view drive
  // identical history shapes for the new fields (機能A).
  function handleHorizontalPositionChange(v: 'left' | 'center' | 'right') {
    if (v === entry.horizontalPosition) return
    applyStyleEdit(t('history.editLayout'), { horizontalPosition: v })
  }
  function handleVerticalPositionChange(v: 'top' | 'bottom') {
    if (v === entry.verticalPosition) return
    applyStyleEdit(t('history.editLayout'), { verticalPosition: v })
  }
  function handleVerticalMarginBlur(e: React.FocusEvent<HTMLInputElement>) {
    const raw = parseInt(e.target.value, 10)
    if (isNaN(raw)) return
    const clamped = Math.max(0, Math.min(300, raw))
    if (clamped === entry.verticalMarginPx) return
    applyStyleEdit(t('history.editMargin'), { verticalMarginPx: clamped })
  }

  // REQ-20260615-033 — Offset X/Y row.
  //
  // Storage is absolute (`posX` / `posY` are ASS pixel coords); the UI
  // surfaces them as `offset = pos - anchor` so the owner's mental model
  // ("how far from the alignment-based home position") matches what they
  // see.  Both posX/posY are set together (libass needs both for `\pos`)
  // and cleared together (unpin → row falls back to alignment-based
  // layout).  Reset = unpin without touching anything else.
  function applyOffset(nextOffsetX: number, nextOffsetY: number) {
    if (!video || !video.hasVideoStream) return
    if (nextOffsetX === 0 && nextOffsetY === 0) {
      if (entry.posX === undefined && entry.posY === undefined) return
      applyStyleEdit(t('history.editOffset'), { posX: undefined, posY: undefined })
      return
    }
    const anchor = getAnchorAssPosition(
      entry.horizontalPosition,
      entry.verticalPosition,
      entry.verticalMarginPx,
      video.widthPx,
      video.heightPx,
    )
    const clamped = clampAssPosition(
      anchor.x + nextOffsetX,
      anchor.y + nextOffsetY,
      video.widthPx,
      video.heightPx,
    )
    const newPosX = Math.round(clamped.x)
    const newPosY = Math.round(clamped.y)
    if (newPosX === entry.posX && newPosY === entry.posY) return
    applyStyleEdit(t('history.editOffset'), { posX: newPosX, posY: newPosY })
  }
  function handleOffsetXBlur(e: React.FocusEvent<HTMLInputElement>) {
    const raw = parseInt(e.target.value, 10)
    if (isNaN(raw)) return
    applyOffset(raw, offsetY)
  }
  function handleOffsetYBlur(e: React.FocusEvent<HTMLInputElement>) {
    const raw = parseInt(e.target.value, 10)
    if (isNaN(raw)) return
    applyOffset(offsetX, raw)
  }
  function handleResetOffset() {
    if (entry.posX === undefined && entry.posY === undefined) return
    applyStyleEdit(t('history.editOffset'), { posX: undefined, posY: undefined })
  }
  function handleBackgroundEnabledChange(checked: boolean) {
    if (checked === entry.subtitleBackground.enabled) return
    applyStyleEdit(t('history.editBackground'), {
      subtitleBackground: { ...entry.subtitleBackground, enabled: checked },
    })
  }
  function handleBackgroundColorChange(color: 'black' | 'white') {
    if (color === entry.subtitleBackground.color) return
    applyStyleEdit(t('history.editBackground'), {
      subtitleBackground: { ...entry.subtitleBackground, color },
    })
  }
  function handleBackgroundOpacityBlur(e: React.FocusEvent<HTMLInputElement>) {
    const raw = parseInt(e.target.value, 10)
    if (isNaN(raw)) return
    const clamped = Math.max(0, Math.min(100, raw))
    if (clamped === entry.subtitleBackground.opacityPercent) return
    applyStyleEdit(t('history.editBackground'), {
      subtitleBackground: { ...entry.subtitleBackground, opacityPercent: clamped },
    })
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

  function handleDuplicate() {
    // REQ-20260612-004 pattern: commit any pending text edit first so
    // the duplicate captures the just-typed value rather than the
    // last-committed text from the store.
    commitText(draft)
    runDuplicateRow(entry, {
      history: t('history.duplicateRow'),
      successToast: t('toast.rowDuplicated')
    })
  }

  function handleAdjustTime() {
    // Commit any pending text edit first so blur doesn't race with
    // the dialog opening.
    commitText(draft)
    // REQ-20260614-001 補遺③ — `onClose` was retired alongside the ×
    // button.  Adjust time just opens the dialog while the Inspector
    // stays put on the same entry (selected).
    onAdjustTime(entry.id)
  }

  // REQ-115 — duration shown to the user is the visible-on-Edited-axis
  // duration so a middle-cut entry reads as the actual surviving length
  // (= what the burnin video will show), not the pre-cut span.
  // REQ-20260614-001 補遺⑧ — 補遺⑦ で Inspector 内に新設した「トリミング
  // 中の一時マーカー読み取り」セクション (§3.5) は撤去した。トリミングは
  // クリップ単位ではなくタイムライン / 動画レベルの操作であり、per-clip
  // Inspector に混ぜると「クリップ情報とトリミング情報の混在」になる、
  // という前提訂正を受けて元の Inspector (= クリップ情報のみ) に戻した。
  // 始点・終点の数値表示はタイムラインツールバー 2 行目に移管済み
  // (timeline-view.tsx Row 2 trim cluster)。
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

  // REQ-20260615-018 A: the §2 badge row is always rendered (with min-h-5)
  // so the layout below doesn't shift when a badge appears mid-edit, so
  // the previous `hasAnyBadge` gate is gone.

  return (
    // REQ-20260614-001 補遺③ — single scroll container is the parent
    // (step2.tsx wraps with `overflow-y-auto`).  This inner div used to
    // set its own `max-h-[70vh] overflow-y-auto pr-1` for the legacy
    // popover sizing; both were stripped so the always-on right-pane
    // Inspector has exactly one scroll axis end-to-end.  `w-full`
    // replaces the legacy `w-[320px]` popover width.
    <div className="flex flex-col gap-3 w-full text-fg-primary">
      {/* § 1 — Action icons.  REQ-20260614-001 補遺③: × close button
          retired.  Common cluster: 敷き詰め改行 → はみ出し改行 →
          削除/復元 → リセット → 複製.  Wrap buttons suppressed in
          audio-only mode. */}
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
                  'text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary',
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
                  'text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary',
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
              'transition-colors duration-150 hover:bg-surface-2',
              entry.isDeleted && !isTrimDeleted
                ? 'text-primary-soft hover:text-primary-faint'
                : 'text-fg-tertiary hover:text-fg-primary'
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
              'text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary',
              'transition-colors duration-150',
              'disabled:opacity-30 disabled:pointer-events-none'
            )}
          >
            <Eraser className="h-3.5 w-3.5" />
          </button>
          {/* REQ-20260613-001 §2-5: Duplicate is the last icon in the
              action cluster, sitting to the right of Reset and to the
              left of the X close.  Per REQ-20260613-001 §2-5 the user
              asked for "the very last" position — interpreted here as
              "last in the action cluster" since the X is a navigation
              affordance rather than a row action.  Disabled on frozen
              rows mirroring the wrap-button gate. */}
          <button
            type="button"
            title={t('action.duplicateRowHelp')}
            aria-label={t('action.duplicateRowHelp')}
            onClick={handleDuplicate}
            disabled={isFrozen}
            className={cn(
              'flex items-center justify-center h-7 w-7 rounded',
              'text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary',
              'transition-colors duration-150',
              'disabled:opacity-30 disabled:pointer-events-none'
            )}
          >
            <CopyPlus className="h-3.5 w-3.5" />
          </button>
      </div>

      {/* § 2 — Status badges.  `state.edited` first, then warnings in the
          same order the table uses (matches user expectations across
          views).  REQ-20260613-016 Phase 6: pin badge surfaces when the
          row has been free-positioned via preview drag (\pos).
          REQ-20260615-018 A: the wrapper renders unconditionally with
          `min-h-5` so a freshly-edited row's "編集済み" badge appearing
          does not shift the rows below it.  Badge primitive itself is
          h-5 so the placeholder height matches the populated row. */}
      <div className="flex flex-wrap gap-1 min-h-5">
        {entry.posX !== undefined && entry.posY !== undefined && (
          <Badge variant="default" title={t('state.pinnedTitle')}>
            {t('state.pinned')}
          </Badge>
        )}
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

      {/* § 3 — Time (display + Adjust time CTA).  REQ-20260614-001 補遺③
          moved this block FROM the bottom of the inspector TO right
          after badges, matching the new ordering "actions → status →
          time → content → style". */}
      <div className="flex flex-col gap-1.5 border-t border-line pt-2">
        <div className="flex items-baseline gap-1 text-body-sm font-mono tabular-nums text-fg-tertiary">
          <span>{formatEditedTimecode(entry.startSec, cuts)}</span>
          <span className="text-fg-disabled">→</span>
          <span>{formatEditedTimecode(entry.endSec, cuts)}</span>
          <span className="ml-1 text-fg-muted">
            ({durationSec.toFixed(2)}s)
          </span>
        </div>
        <button
          type="button"
          onClick={handleAdjustTime}
          className={cn(
            'self-start flex items-center gap-1 h-6 px-2 rounded text-caption text-fg-tertiary',
            'hover:bg-surface-2 hover:text-fg-primary transition-colors duration-150'
          )}
        >
          <Clock className="h-3 w-3" />
          {t('timeline.inspector.adjustTime')}
        </button>
      </div>

      {/* § 4 — 字幕 section (REQ-20260614-001 補遺⑪).
          補遺⑪で「テキスト」セクションの label を「字幕」に改名し、
          かつフォントとスタイル一式 (Size / Text colour / Outline colour
          / Outline width / Fade) を同じ「字幕」セクション内に統合した。
          フォントの label は削除し、プルダウン本体のみ表示する。
          audio-only mode (REQ-028) では textarea のみ表示し、font /
          style 一式は出さない。 */}
      <div className="space-y-2 border-t border-line pt-2">
        <div className="text-body font-semibold text-fg-secondary">
          {t('timeline.inspector.subtitleSection')}
        </div>
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
          aria-label={t('timeline.inspector.textLabel')}
          className={cn(
            'w-full rounded-md bg-surface-0 border border-line-strong px-2 py-1.5',
            'text-body text-fg-primary leading-snug resize-none',
            'focus:outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/30',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
        {!isAudioOnly && (
          <>
            {/* Font dropdown — label 削除 (補遺⑪)、プルダウン本体のみ。
                aria-label は accessibility のため残す。 */}
            <RowFontSelector
              value={entry.fontId}
              onChange={handleFontChange}
              disabled={isFrozen}
            />
            {/* Size — REQ-20260615-017: ±10 chevron stepper flanks the
                number input.  Direct typing still works (input keeps its
                onChange / onBlur), and both the buttons and the typed
                value clamp to [FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX]. */}
            <div className="flex items-center justify-between gap-2">
              <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.size')}</label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleSizeStep(-10)}
                  disabled={isFrozen || entry.fontSizePx <= FONT_SIZE_MIN_PX}
                  aria-label={t('styleCell.size') + ' −10'}
                  className={cn(
                    'h-7 w-6 inline-flex items-center justify-center rounded border border-line-strong bg-surface-0 text-fg-secondary',
                    'hover:text-fg-primary hover:bg-surface-2 transition-colors duration-150',
                    'focus:outline-none focus-visible:outline-none',
                    'disabled:opacity-40 disabled:cursor-not-allowed'
                  )}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
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
                  title={t('step1:subtitleDefaults.sizeHint', {
                    min: FONT_SIZE_MIN_PX,
                    max: FONT_SIZE_MAX_PX
                  })}
                  className={cn(
                    'w-14 h-7 rounded border bg-surface-0 px-1.5 text-center text-body text-fg-primary',
                    'focus:outline-none focus-visible:ring-1',
                    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    sizeOutOfRange
                      ? 'border-warning-soft/60 focus-visible:ring-warning-soft/30'
                      : 'border-line-strong focus-visible:border-surface-4 focus-visible:ring-primary/30'
                  )}
                />
                <button
                  type="button"
                  onClick={() => handleSizeStep(10)}
                  disabled={isFrozen || entry.fontSizePx >= FONT_SIZE_MAX_PX}
                  aria-label={t('styleCell.size') + ' +10'}
                  className={cn(
                    'h-7 w-6 inline-flex items-center justify-center rounded border border-line-strong bg-surface-0 text-fg-secondary',
                    'hover:text-fg-primary hover:bg-surface-2 transition-colors duration-150',
                    'focus:outline-none focus-visible:outline-none',
                    'disabled:opacity-40 disabled:cursor-not-allowed'
                  )}
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            {/* Text colour */}
            <div className="flex items-center justify-between gap-2">
              <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.textColor')}</label>
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
              <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.outlineColor')}</label>
              <ColorPicker
                value={entry.outlineColorHex}
                onChange={handleOutlineColorChange}
                onPairApply={handleColorPairApply}
                disabled={isFrozen}
                swatchOnly
              />
            </div>
            {/* Outline width — REQ-20260615-016: slider column narrowed to
                ~50% so the row's left side has enough breathing room for
                the "アウトライン幅" label to stay on a single line.  Label
                gets `whitespace-nowrap` as a belt-and-braces against
                inspector-pane width changes. */}
            <div className="flex items-center justify-between gap-2">
              <label className="text-callout font-semibold text-fg-secondary whitespace-nowrap">{t('styleCell.outlineWidth')}</label>
              <div className="w-[50%]" onClick={(e) => e.stopPropagation()}>
                <OutlineThicknessSlider
                  value={entry.outlineThicknessPx}
                  onCommit={handleOutlineThicknessCommit}
                  disabled={isFrozen}
                  ariaLabel={t('styleCell.outlineWidth')}
                  fullWidth
                />
              </div>
            </div>
            {/* Fade */}
            <div className="flex items-center justify-between gap-2">
              <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.fade')}</label>
              <Switch
                checked={entry.fadeEnabled}
                onCheckedChange={handleFadeChange}
                disabled={isFrozen}
                className="scale-75 origin-right"
              />
            </div>
          </>
        )}
      </div>

      {/* § 5 — レイアウト section (REQ-20260614-001 補遺⑪).
          水平 / 垂直 / マージン。audio-only 非表示。 */}
      {!isAudioOnly && (
        <div className="space-y-2 border-t border-line pt-2">
          <div className="text-body font-semibold text-fg-secondary">
            {t('timeline.inspector.layoutSection')}
          </div>
          {/* REQ-20260615-014 B: horizontal / vertical lift from native
              <select> to a single-select SegmentGroup so all options are
              visible up-front.  Value bindings are unchanged. */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-fg-secondary shrink-0">{t('styleCell.layoutH')}</label>
            <SegmentGroup<'left' | 'center' | 'right'>
              value={entry.horizontalPosition}
              onChange={handleHorizontalPositionChange}
              disabled={isFrozen}
              ariaLabel={t('subtitlePosition.horizontal')}
              options={[
                { value: 'left', label: t('subtitlePosition.left') },
                { value: 'center', label: t('subtitlePosition.center') },
                { value: 'right', label: t('subtitlePosition.right') },
              ]}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-fg-secondary shrink-0">{t('styleCell.layoutV')}</label>
            <SegmentGroup<'top' | 'bottom'>
              value={entry.verticalPosition}
              onChange={handleVerticalPositionChange}
              disabled={isFrozen}
              ariaLabel={t('subtitlePosition.vertical')}
              options={[
                { value: 'top', label: t('subtitlePosition.top') },
                { value: 'bottom', label: t('subtitlePosition.bottom') },
              ]}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.marginV')}</label>
            <input
              type="number"
              min={0}
              max={300}
              defaultValue={entry.verticalMarginPx}
              key={entry.verticalMarginPx}
              onBlur={handleVerticalMarginBlur}
              disabled={isFrozen}
              aria-label={t('subtitlePosition.margin')}
              className={cn(
                'w-20 h-7 rounded border border-line-strong bg-surface-0 px-1.5 text-center text-body text-fg-primary',
                'focus:outline-none focus-visible:border-surface-4 focus-visible:ring-1 focus-visible:ring-primary/30',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'
              )}
            />
          </div>
          {/* REQ-20260615-033 — オフセット行.  Displays `posX-anchor.x` /
              `posY-anchor.y`; entering values writes back
              posX=anchor.x+offset, posY=anchor.y+offset.  X=Y=0 unpins
              (clears posX/posY).  Reset button = explicit unpin.  Hidden
              when video has no video stream (audio-only) or is still
              loading.

              REQ-20260615-034 B: the constant-visible pinned-state note
              is gone; the same content moved into a `?` tooltip next to
              the "オフセット" label so users can still learn the rule
              without permanent UI clutter. */}
          {showOffsetRow && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 shrink-0">
                <label className="text-callout font-semibold text-fg-secondary">
                  {t('styleCell.offset')}
                </label>
                <HelpIcon content={t('styleCell.offsetHelp')} />
              </div>
              <div className="flex items-center gap-1">
                <span className="text-caption text-fg-tertiary">X</span>
                <input
                  type="number"
                  defaultValue={offsetX}
                  key={`offsetX-${entry.id}-${offsetX}`}
                  onBlur={handleOffsetXBlur}
                  disabled={isFrozen}
                  aria-label={t('styleCell.offsetX')}
                  className={cn(
                    'w-14 h-7 rounded border border-line-strong bg-surface-0 px-1.5 text-center text-body text-fg-primary',
                    'focus:outline-none focus-visible:border-surface-4 focus-visible:ring-1 focus-visible:ring-primary/30',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'
                  )}
                />
                <span className="text-caption text-fg-tertiary ml-1">Y</span>
                <input
                  type="number"
                  defaultValue={offsetY}
                  key={`offsetY-${entry.id}-${offsetY}`}
                  onBlur={handleOffsetYBlur}
                  disabled={isFrozen}
                  aria-label={t('styleCell.offsetY')}
                  className={cn(
                    'w-14 h-7 rounded border border-line-strong bg-surface-0 px-1.5 text-center text-body text-fg-primary',
                    'focus:outline-none focus-visible:border-surface-4 focus-visible:ring-1 focus-visible:ring-primary/30',
                    'disabled:opacity-40 disabled:cursor-not-allowed',
                    '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'
                  )}
                />
                <button
                  type="button"
                  title={t('styleCell.offsetResetTitle')}
                  aria-label={t('styleCell.offsetResetTitle')}
                  onClick={handleResetOffset}
                  disabled={isFrozen || !isPinned}
                  className={cn(
                    'flex items-center justify-center h-7 w-7 rounded ml-0.5',
                    'text-fg-tertiary hover:bg-surface-2 hover:text-fg-primary',
                    'transition-colors duration-150',
                    'disabled:opacity-30 disabled:pointer-events-none'
                  )}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* § 6 — 背景色 section (REQ-20260614-001 補遺⑪).
          背景 ON/OFF / 背景色 / 透過率。セクション名「背景色」と
          フィールド名「背景色」が重なるが、REQ 補遺⑪ で明示的に
          確認済 (指定どおり「背景色」で実装)。audio-only 非表示。 */}
      {!isAudioOnly && (
        <div className="space-y-2 border-t border-line pt-2">
          <div className="text-body font-semibold text-fg-secondary">
            {t('timeline.inspector.backgroundSection')}
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.bgEnabled')}</label>
            <Switch
              checked={entry.subtitleBackground.enabled}
              onCheckedChange={handleBackgroundEnabledChange}
              disabled={isFrozen}
              className="scale-75 origin-right"
              aria-label={t('styleCell.bgEnabled')}
            />
          </div>
          <div className={cn(
            'flex items-center justify-between gap-2',
            !entry.subtitleBackground.enabled && 'opacity-40 pointer-events-none'
          )}>
            <label className="text-callout font-semibold text-fg-secondary shrink-0">{t('styleCell.bgColor')}</label>
            {/* REQ-20260615-014 B: black / white SegmentGroup replaces the
                native <select>.  Value binding unchanged. */}
            <SegmentGroup<'black' | 'white'>
              value={entry.subtitleBackground.color}
              onChange={handleBackgroundColorChange}
              disabled={isFrozen || !entry.subtitleBackground.enabled}
              ariaLabel={t('styleCell.bgColor')}
              options={[
                { value: 'black', label: t('background.black') },
                { value: 'white', label: t('background.white') },
              ]}
            />
          </div>
          <div className={cn(
            'flex items-center justify-between gap-2',
            !entry.subtitleBackground.enabled && 'opacity-40 pointer-events-none'
          )}>
            <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.bgOpacity')}</label>
            <input
              type="number"
              min={0}
              max={100}
              defaultValue={entry.subtitleBackground.opacityPercent}
              key={`${entry.subtitleBackground.opacityPercent}-${entry.subtitleBackground.enabled}`}
              onBlur={handleBackgroundOpacityBlur}
              disabled={isFrozen || !entry.subtitleBackground.enabled}
              aria-label={t('styleCell.bgOpacity')}
              className={cn(
                'w-20 h-7 rounded border border-line-strong bg-surface-0 px-1.5 text-center text-body text-fg-primary',
                'focus:outline-none focus-visible:border-surface-4 focus-visible:ring-1 focus-visible:ring-primary/30',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'
              )}
            />
          </div>
        </div>
      )}

    </div>
  )
}
