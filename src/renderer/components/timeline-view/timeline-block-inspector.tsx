import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Trash2, Undo2 } from 'lucide-react'
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
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'
import type { FontId } from '../../../shared/fonts'
import type { SubtitleEntry } from '../../../shared/types'

/**
 * Format seconds as `HH:MM:SS.cc` — the same shape used by the existing
 * TimeInput in the table.  Local because the project's `time.ts` formatter
 * targets a slightly different format and threading both through one
 * helper would invite drift.
 */
function formatTimecode(sec: number): string {
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const cc = Math.floor((s - Math.floor(s)) * 100)
  return [h, m, ss].map((v) => String(v).padStart(2, '0')).join(':') + '.' + String(cc).padStart(2, '0')
}

interface TimelineBlockInspectorProps {
  entry: SubtitleEntry
  warnings: EntryWarnings | null
  /** Open the shared TimeEditorDialog (step2 owns it; we just forward the id). */
  onAdjustTime: (entryId: string) => void
  /** Close request from inside the inspector (e.g. after Adjust time click). */
  onClose: () => void
}

/**
 * Popover body shown when a timeline block is clicked.  Lets the user
 * read the entry's text + timing and edit the text inline; cosmetic /
 * style edits stay in the subtitle-table for now (Phase 2 scope).
 *
 * Text-commit rules mirror subtitle-table.CellEditor exactly so the user
 * gets identical keyboard behaviour across the two views:
 *
 *   - `Ctrl+Enter` commits.
 *   - `Esc` cancels.
 *   - Blur commits.
 *   - Real newlines in the textarea round-trip through ASS `\N` markers
 *     on save / display.
 *
 * History: the text-edit op pushes a single inverse-action pair via
 * useHistoryStore — same shape SubtitleRow.handleTextCommit uses — so
 * `Ctrl+Z` in either view undoes either edit transparently.
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

  // When the inspector mounts for a new entry (the parent re-renders this
  // component for each id), focus the textarea + select-all so users can
  // overwrite without an extra Ctrl+A.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.focus()
    el.select()
  }, [entry.id])

  function commitText(next: string) {
    // Round-trip newlines back to ASS \N
    const normalized = next.replace(/\n/g, '\\N')
    if (normalized === entry.text) return
    const snapshot = { ...entry }
    const patch = { text: normalized, isEdited: true }
    pushHistory({
      label: t('history.editText'),
      undo: () => updateEntry(entry.id, snapshot),
      redo: () => updateEntry(entry.id, { ...snapshot, ...patch })
    })
    updateEntry(entry.id, patch)
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      commitText(draft)
      onClose()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      // Cancel — restore draft to last-committed value but do NOT commit.
      setDraft(entry.text.replace(/\\N/g, '\n'))
      onClose()
    }
  }

  function handleBlur() {
    // Blur fires when the user clicks any of the inspector's other
    // controls too — commit so the edit is not lost.  No-op fast path is
    // inside commitText().
    commitText(draft)
  }

  function handleDeleteToggle() {
    const snapshot = { ...entry }
    const patch = { isDeleted: !entry.isDeleted }
    pushHistory({
      label: entry.isDeleted
        ? t('history.restoreRow')
        : t('history.deleteRow'),
      undo: () => updateEntry(entry.id, snapshot),
      redo: () => updateEntry(entry.id, { ...snapshot, ...patch })
    })
    updateEntry(entry.id, patch)
  }

  function handleAdjustTime() {
    // Commit any pending text edit first so blur doesn't race with
    // the dialog opening.
    commitText(draft)
    onClose()
    onAdjustTime(entry.id)
  }

  const durationSec = Math.max(0, entry.endSec - entry.startSec)

  return (
    <div className="flex flex-col gap-2 w-[320px] text-zinc-100 max-h-[70vh] overflow-y-auto pr-1">
      {/* Time row — read-only display + Adjust-time CTA */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1 text-[11px] font-mono tabular-nums text-zinc-400">
          <span>{formatTimecode(entry.startSec)}</span>
          <span className="text-zinc-600">→</span>
          <span>{formatTimecode(entry.endSec)}</span>
          <span className="ml-1 text-zinc-500">
            ({durationSec.toFixed(2)}s)
          </span>
        </div>
        <button
          type="button"
          onClick={handleAdjustTime}
          className={cn(
            'flex items-center gap-1 h-6 px-2 rounded text-[11px] text-zinc-400',
            'hover:bg-zinc-800 hover:text-zinc-100 transition-colors duration-150'
          )}
        >
          <Clock className="h-3 w-3" />
          {t('timeline.inspector.adjustTime')}
        </button>
      </div>

      {/* Warning badges — same source-of-truth as the table */}
      {warnings && (
        <div className="flex flex-wrap gap-1">
          {warnings.timeInvalid  && <Badge variant="danger">{t('badge.timeInvalid')}</Badge>}
          {warnings.overlap      && <Badge variant="warning">{t('badge.overlap')}</Badge>}
          {warnings.overDuration && <Badge variant="warning">{t('badge.overDuration')}</Badge>}
          {warnings.overflow     && <Badge variant="warning">{t('badge.overflow')}</Badge>}
          {warnings.emptyText    && <Badge variant="warning">{t('badge.emptyText')}</Badge>}
          {warnings.invalidSize  && <Badge variant="warning">{t('badge.invalidSize')}</Badge>}
        </div>
      )}

      {/* Text editor */}
      <div>
        <label className="block text-[10px] uppercase tracking-wider text-zinc-500 mb-1">
          {t('timeline.inspector.textLabel')}
        </label>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          rows={3}
          disabled={entry.isDeleted}
          spellCheck={false}
          className={cn(
            'w-full rounded-md bg-zinc-950 border border-zinc-700 px-2 py-1.5',
            'text-[13px] text-zinc-50 leading-snug resize-none',
            'focus:outline-none focus:border-green-500 focus:ring-1 focus:ring-green-500/30',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
        <p className="mt-1 text-[10px] text-zinc-500 select-none">
          {t('timeline.inspector.commitHint')}
        </p>
      </div>

      {/* Style section — reuses the same shadcn primitives the subtitle-
          table per-row cells and BulkEditBar drive against the same
          fields (size / colours / outline / fade / font), so editing
          either surface stays visually + behaviourally consistent.
          Hidden in audio-only mode (REQ-028 / REQ-055 — style edits
          don't reach text/SRT export). */}
      {!isAudioOnly && (
        <div className="space-y-2 border-t border-zinc-800 pt-2">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 select-none">
            {t('timeline.inspector.styleLabel')}
          </p>

          {/* Size */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-zinc-400">{t('styleCell.size')}</label>
            <input
              type="number"
              min={FONT_SIZE_MIN_PX}
              max={FONT_SIZE_MAX_PX}
              defaultValue={entry.fontSizePx}
              key={entry.fontSizePx}
              onChange={handleSizeChange}
              onBlur={handleSizeBlur}
              disabled={entry.isDeleted}
              title={t('step1:subtitleDefaults.sizeHint', {
                min: FONT_SIZE_MIN_PX,
                max: FONT_SIZE_MAX_PX
              })}
              className={cn(
                'w-20 h-7 rounded border bg-zinc-950 px-1.5 text-center text-[12px] text-zinc-100',
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
            <label className="text-[11px] text-zinc-400">{t('styleCell.textColor')}</label>
            <ColorPicker
              value={entry.textColorHex}
              onChange={handleTextColorChange}
              onPairApply={handleColorPairApply}
              disabled={entry.isDeleted}
              swatchOnly
            />
          </div>

          {/* Outline colour */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-zinc-400">{t('styleCell.outlineColor')}</label>
            <ColorPicker
              value={entry.outlineColorHex}
              onChange={handleOutlineColorChange}
              onPairApply={handleColorPairApply}
              disabled={entry.isDeleted}
              swatchOnly
            />
          </div>

          {/* Outline width — shared slider component (same as subtitle-table
              per-row + bulk-edit-bar). */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-zinc-400">{t('styleCell.outlineWidth')}</label>
            <div className="w-[160px]" onClick={(e) => e.stopPropagation()}>
              <OutlineThicknessSlider
                value={entry.outlineThicknessPx}
                onCommit={handleOutlineThicknessCommit}
                disabled={entry.isDeleted}
                ariaLabel={t('styleCell.outlineWidth')}
              />
            </div>
          </div>

          {/* Fade */}
          <div className="flex items-center justify-between gap-2">
            <label className="text-[11px] text-zinc-400">{t('styleCell.fade')}</label>
            <Switch
              checked={entry.fadeEnabled}
              onCheckedChange={handleFadeChange}
              disabled={entry.isDeleted}
              className="scale-75 origin-right"
            />
          </div>

          {/* Font — per-row override, shared RowFontSelector. */}
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-400 block">{t('bulkRowFont.label')}</label>
            <RowFontSelector
              value={entry.fontId}
              onChange={handleFontChange}
              disabled={entry.isDeleted}
            />
          </div>
        </div>
      )}

      {/* Footer — delete / restore action */}
      <div className="flex items-center justify-end pt-1 border-t border-zinc-800">
        <button
          type="button"
          onClick={handleDeleteToggle}
          className={cn(
            'flex items-center gap-1 h-6 px-2 rounded text-[11px] transition-colors duration-150',
            entry.isDeleted
              ? 'text-green-400 hover:bg-zinc-800 hover:text-green-300'
              : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
          )}
        >
          {entry.isDeleted ? <Undo2 className="h-3 w-3" /> : <Trash2 className="h-3 w-3" />}
          {entry.isDeleted
            ? t('timeline.inspector.restore')
            : t('timeline.inspector.delete')}
        </button>
      </div>
    </div>
  )
}
