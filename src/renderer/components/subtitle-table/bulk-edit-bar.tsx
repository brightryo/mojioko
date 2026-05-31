import { useMemo, useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { Switch } from '@/components/ui/switch'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import type { SubtitleEntry } from '../../../shared/types'
import {
  FONT_SIZE_MIN_PX,
  FONT_SIZE_MAX_PX,
  OUTLINE_THICKNESS_MAX_PX
} from '../../../shared/constants'

interface BulkEditBarProps {
  /**
   * Row ids currently visible under the active table filter, in display
   * order.  Used to compute the "hidden selected" count so the bar can
   * surface selections the user can't see at this moment.
   */
  visibleIds: readonly string[]
  /**
   * Notify the parent that a bulk op was just applied so it can surface
   * an inline "applied / undo" affordance (typically a toast).  Called
   * with the number of rows actually written and the history label that
   * was pushed.
   */
  onApplied: (rowCount: number, label: string) => void
}

/**
 * Bulk-edit bar for Step 2.
 *
 * Renders above the subtitle table when any rows are selected.  Each
 * control commits exactly one history op (per the design discussion):
 *   - font size input → commit on blur
 *   - color pickers   → commit on popover close (ColorPicker.onCommit)
 *   - outline slider  → commit on mouseup / keyup (native range input)
 *   - fade switch     → commit on toggle
 *
 * Every op snapshots the *full* SubtitleEntry of each selected row so
 * undo restores the exact prior state (including isEdited) — matching
 * the convention established by withHistory() in subtitle-table.tsx.
 */
export function BulkEditBar({ visibleIds, onApplied }: BulkEditBarProps) {
  const { t } = useTranslation(['step2'])
  const selectedRowIds = useUiStore((s) => s.selectedRowIds)
  const clearRowSelection = useUiStore((s) => s.clearRowSelection)

  // Derived counts.  hiddenCount > 0 means the user has selections under
  // a filter that does not currently show them — surfacing this avoids
  // "ghost selection" surprises ("I clicked Apply on 12 rows, but the
  // toast says 17?").
  const { visibleSelected, hiddenSelected, totalSelected } = useMemo(() => {
    const visible = new Set(visibleIds)
    let v = 0
    for (const id of selectedRowIds) if (visible.has(id)) v++
    return {
      visibleSelected: v,
      hiddenSelected: selectedRowIds.size - v,
      totalSelected: selectedRowIds.size
    }
  }, [visibleIds, selectedRowIds])

  // Local drafts.  Pickers/inputs operate on these so a saturation drag
  // or a stepped number input does not poll the project store; the bulk
  // op only fires on commit, at which point the draft is read.
  const [colorDraftText, setColorDraftText] = useState<string | null>(null)
  const [colorDraftOutline, setColorDraftOutline] = useState<string | null>(null)
  const [outlineSliderDraft, setOutlineSliderDraft] = useState<number>(0)
  const sliderInteractingRef = useRef(false)

  // Reset drafts whenever the selection changes — otherwise a stale draft
  // from the previous selection could flash into the swatches before the
  // user touches them.
  useEffect(() => {
    setColorDraftText(null)
    setColorDraftOutline(null)
    setOutlineSliderDraft(0)
  }, [selectedRowIds])

  // ---------------------------------------------------------------------
  // Core history op — snapshot every selected entry in full, apply patch
  // to all of them with isEdited:true, register one undo/redo pair.
  // ---------------------------------------------------------------------
  function applyBulk(patch: Partial<SubtitleEntry>, label: string) {
    const ids = Array.from(selectedRowIds)
    if (ids.length === 0) return

    const all = useProjectStore.getState().entries
    const snapshots = new Map<string, SubtitleEntry>()
    for (const id of ids) {
      const e = all.find((x) => x.id === id)
      if (e) snapshots.set(id, { ...e })
    }
    if (snapshots.size === 0) return

    const apply = () => {
      const s = useProjectStore.getState()
      for (const id of snapshots.keys()) {
        s.updateEntry(id, { ...patch, isEdited: true })
      }
    }
    const revert = () => {
      const s = useProjectStore.getState()
      for (const [id, snap] of snapshots) {
        s.updateEntry(id, snap)
      }
    }

    useHistoryStore.getState().push({ label, undo: revert, redo: apply })
    apply()
    onApplied(snapshots.size, label)
  }

  // ---------------------------------------------------------------------
  // Per-control handlers
  // ---------------------------------------------------------------------

  function handleSizeCommit(raw: string) {
    const v = parseInt(raw, 10)
    if (isNaN(v)) return
    const clamped = Math.min(FONT_SIZE_MAX_PX, Math.max(FONT_SIZE_MIN_PX, v))
    applyBulk(
      { fontSizePx: clamped },
      t('bulk.history.size', { count: selectedRowIds.size })
    )
  }

  function handleTextColorCommit(hex: string) {
    applyBulk(
      { textColorHex: hex },
      t('bulk.history.textColor', { count: selectedRowIds.size })
    )
    setColorDraftText(null)
  }

  function handleOutlineColorCommit(hex: string) {
    applyBulk(
      { outlineColorHex: hex },
      t('bulk.history.outlineColor', { count: selectedRowIds.size })
    )
    setColorDraftOutline(null)
  }

  // Slider only commits on mouseup / keyup — onChange runs every frame
  // during drag but feeds the local draft (visual feedback) without
  // touching the store.  sliderInteractingRef guards against the
  // initial controlled-value sync triggering a spurious commit.
  function handleOutlineSliderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10)
    if (!isNaN(v)) setOutlineSliderDraft(v)
    sliderInteractingRef.current = true
  }
  function commitOutlineSlider() {
    if (!sliderInteractingRef.current) return
    sliderInteractingRef.current = false
    applyBulk(
      { outlineThicknessPx: outlineSliderDraft },
      t('bulk.history.outlineWidth', { count: selectedRowIds.size })
    )
  }

  function handleFadeChange(checked: boolean) {
    applyBulk(
      { fadeEnabled: checked },
      t('bulk.history.fade', { count: selectedRowIds.size })
    )
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  // Selection count string — only mention hidden rows when there are some
  // (cleaner copy for the common case of "all selected rows visible").
  const countLabel =
    hiddenSelected > 0
      ? t('bulk.countLabelWithHidden', {
          count: totalSelected,
          visible: visibleSelected,
          hidden: hiddenSelected
        })
      : t('bulk.countLabel', { count: totalSelected })

  return (
    <div
      role="region"
      aria-label={t('bulk.regionLabel')}
      className={cn(
        'flex items-center gap-4 flex-shrink-0',
        'rounded-lg border px-3 py-2',
        'bg-[hsl(var(--row-selected)/0.08)] border-[hsl(var(--row-selected)/0.30)]'
      )}
    >
      {/* Left: count + clear */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-[12px] font-medium text-foreground tabular-nums">
          {countLabel}
        </span>
        <button
          type="button"
          onClick={clearRowSelection}
          className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors duration-150"
          aria-label={t('bulk.clearSelection')}
          title={t('bulk.clearSelection')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div
        className="h-5 w-px flex-shrink-0"
        style={{ backgroundColor: 'hsl(var(--separator) / var(--separator-alpha))' }}
        aria-hidden="true"
      />

      {/* Controls cluster */}
      <div className="flex items-center gap-5 flex-wrap min-w-0">
        {/* Font size */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.size')}</span>
          <input
            type="number"
            min={FONT_SIZE_MIN_PX}
            max={FONT_SIZE_MAX_PX}
            placeholder={t('bulk.placeholder')}
            onBlur={(e) => {
              if (e.target.value === '') return
              handleSizeCommit(e.target.value)
              e.target.value = ''
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className={cn(
              'w-16 h-7 rounded border bg-input px-2 text-center text-[12px] text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-ring/30',
              'border-border',
              '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'
            )}
          />
        </label>

        {/* Text color */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.textColor')}</span>
          <ColorPicker
            value={colorDraftText ?? '#FFFFFF'}
            onChange={setColorDraftText}
            onCommit={handleTextColorCommit}
            swatchOnly
          />
        </label>

        {/* Outline color */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.outlineColor')}</span>
          <ColorPicker
            value={colorDraftOutline ?? '#000000'}
            onChange={setColorDraftOutline}
            onCommit={handleOutlineColorCommit}
            swatchOnly
          />
        </label>

        {/* Outline thickness — slider commits on mouseup/keyup.  Native
            <input type="range"> uses the `accent-color` CSS property for
            its thumb/track tint; routing it through --primary keeps the
            slider on-brand without hardcoding green-500. */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.outlineWidth')}</span>
          <input
            type="range"
            min={0}
            max={OUTLINE_THICKNESS_MAX_PX}
            step={1}
            value={outlineSliderDraft}
            onChange={handleOutlineSliderChange}
            onMouseUp={commitOutlineSlider}
            onKeyUp={commitOutlineSlider}
            onTouchEnd={commitOutlineSlider}
            className="w-24"
            style={{ accentColor: 'hsl(var(--primary))' }}
            aria-label={t('bulk.outlineWidth')}
          />
          <span className="w-4 text-[11px] text-muted-foreground font-mono tabular-nums">
            {outlineSliderDraft}
          </span>
        </label>

        {/* Fade */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.fade')}</span>
          <Switch onCheckedChange={handleFadeChange} />
        </label>
      </div>
    </div>
  )
}
