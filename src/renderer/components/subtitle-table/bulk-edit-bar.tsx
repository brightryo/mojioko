import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, WrapText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { toast } from 'sonner'
import type { SubtitleEntry } from '../../../shared/types'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'

interface BulkEditBarProps {
  /**
   * Notify the parent that a bulk op was just applied so it can surface
   * an inline "applied / undo" affordance (typically a toast).  Called
   * with the number of rows actually written and the history label that
   * was pushed.
   */
  onApplied: (rowCount: number, label: string) => void
}

/**
 * Read the first selected row's current colour for the given field, used
 * to seed the colour drafts when the selection changes.  Returns null if
 * no row in `selectedRowIds` is found in the project store (empty
 * selection, or rows were removed mid-render).
 *
 * Reads `entries` via `useProjectStore.getState()` rather than subscribing
 * so the caller can invoke this from a useEffect / useState initialiser
 * without triggering re-renders on every entry mutation.
 */
function pickFirstSelectedColor(
  selectedIds: ReadonlySet<string>,
  field: 'text' | 'outline'
): string | null {
  if (selectedIds.size === 0) return null
  const entries = useProjectStore.getState().entries
  for (const e of entries) {
    if (selectedIds.has(e.id)) {
      return field === 'text' ? e.textColorHex : e.outlineColorHex
    }
  }
  return null
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
export function BulkEditBar({ onApplied }: BulkEditBarProps) {
  const { t } = useTranslation(['step2'])
  const selectedRowIds = useUiStore((s) => s.selectedRowIds)
  const clearRowSelection = useUiStore((s) => s.clearRowSelection)

  // Local drafts.  Pickers/inputs operate on these so a saturation drag
  // or a stepped number input does not poll the project store; the bulk
  // op only fires on commit, at which point the draft is read.
  //
  // Colour drafts are SEEDED from the first selected row's current values
  // (not a `'#FFFFFF'` / `'#000000'` constant) for two reasons:
  //   1. ColorPicker.onCommit fires only when the value *changed* during
  //      the popover session.  If the open-time value were a constant
  //      fallback, picking that same colour (e.g. white) would look like
  //      "no change" and silently swallow the apply.  Seeding from real
  //      row state means picking the seed colour is a genuine no-op and
  //      picking anything else commits.
  //   2. After a bulk apply, the swatch should keep showing the colour
  //      the user just chose — surfacing what was applied is a useful
  //      affordance.  Clearing back to a constant after every apply
  //      would erase that signal.
  const [colorDraftText, setColorDraftText] = useState<string | null>(() =>
    pickFirstSelectedColor(selectedRowIds, 'text')
  )
  const [colorDraftOutline, setColorDraftOutline] = useState<string | null>(() =>
    pickFirstSelectedColor(selectedRowIds, 'outline')
  )
  // Slider value is now owned by OutlineThicknessSlider internally.  We
  // keep this draft only to remember the LAST APPLIED value across the
  // current selection session so the slider thumb stays where the user
  // left it (same pattern as colorDraftText/Outline above).
  const [outlineSliderDraft, setOutlineSliderDraft] = useState<number>(0)

  // Re-seed colour drafts when the selection itself changes.  Reads
  // `entries` via getState() so the effect only fires on selection
  // change — not on every entry mutation (which would otherwise reset
  // the user's in-progress pick whenever a row's text was edited).
  useEffect(() => {
    setColorDraftText(pickFirstSelectedColor(selectedRowIds, 'text'))
    setColorDraftOutline(pickFirstSelectedColor(selectedRowIds, 'outline'))
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
    // Intentionally do NOT clear the draft here — the swatch should keep
    // showing the colour the user just applied so they have a clear visual
    // record of "what was last set on the selection".
    setColorDraftText(hex)
  }

  function handleOutlineColorCommit(hex: string) {
    applyBulk(
      { outlineColorHex: hex },
      t('bulk.history.outlineColor', { count: selectedRowIds.size })
    )
    setColorDraftOutline(hex)
  }

  function handleOutlineWidthCommit(v: number) {
    // Mirror the colour-commit handlers: persist the just-applied value as
    // the swatch / slider position so the bar visually records "what was
    // last set on the current selection" instead of snapping back.
    setOutlineSliderDraft(v)
    applyBulk(
      { outlineThicknessPx: v },
      t('bulk.history.outlineWidth', { count: selectedRowIds.size })
    )
  }

  function handleFadeChange(checked: boolean) {
    applyBulk(
      { fadeEnabled: checked },
      t('bulk.history.fade', { count: selectedRowIds.size })
    )
  }

  // Bulk auto line-break — strip every existing \N from each selected
  // row's text and rewrap with the row's CURRENT fontSizePx /
  // outlineThicknessPx (which may have been bumped via the bulk size or
  // outline controls above on the same selection).  Existing manual \N
  // are intentionally cleared: this button is documented as a "re-wrap"
  // action — the user's safety net is the one-click undo on the toast.
  //
  // The whole batch goes through one history op (snapshots-by-id Map +
  // single push) so undo restores every changed row's text + isEdited
  // state in a single step, matching applyBulk's contract above.
  // No-op rows (where rewrap === current text) are excluded so an
  // unchanged row neither bloats the history nor inflates the "applied
  // to N rows" toast count.
  async function handleAutoLineBreakApply() {
    // Await loadSubtitleFont() so applyAutoLineBreak runs the glyph-
    // accurate path rather than the character-class fallback (which
    // over-estimates wide-glyph widths by ~45 % and lands breaks too
    // early).  Module cache + in-flight promise de-dupe means this
    // resolves immediately when the font is already loaded (typical
    // case in Step 2).
    const font = await loadSubtitleFont().catch(() => null)
    const ids = Array.from(selectedRowIds)
    if (ids.length === 0) return

    const all = useProjectStore.getState().entries
    const videoWidthPx = useProjectStore.getState().video?.widthPx ?? 1920

    const snapshots = new Map<string, SubtitleEntry>()
    const patches = new Map<string, string>()

    for (const id of ids) {
      const e = all.find((x) => x.id === id)
      if (!e || e.isDeleted) continue
      const stripped = e.text.replace(/\\N/g, '')
      const rewrapped = applyAutoLineBreak(
        stripped,
        e.fontSizePx,
        e.outlineThicknessPx,
        videoWidthPx,
        font
      )
      if (rewrapped !== e.text) {
        snapshots.set(id, { ...e })
        patches.set(id, rewrapped)
      }
    }

    if (snapshots.size === 0) {
      // No row's text would change — surface that explicitly so the
      // user knows their click was acknowledged, but skip the history
      // pressure and the "applied / undo" toast.  Info-level, no
      // action button.
      toast.info(t('bulk.autoLineBreakNoChange'))
      return
    }

    const apply = () => {
      const s = useProjectStore.getState()
      for (const [id, newText] of patches) {
        s.updateEntry(id, { text: newText, isEdited: true })
      }
    }
    const revert = () => {
      const s = useProjectStore.getState()
      for (const [id, snap] of snapshots) {
        s.updateEntry(id, snap)
      }
    }

    const label = t('bulk.history.autoLineBreak', { count: snapshots.size })
    useHistoryStore.getState().push({ label, undo: revert, redo: apply })
    apply()
    onApplied(snapshots.size, label)
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  // Selection count string — hidden-row counts no longer occur because
  // step2 prunes the selection to the visible set whenever the filter
  // changes, so the bar can always read the count straight off the store.
  const countLabel = t('bulk.countLabel', { count: selectedRowIds.size })

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

        {/* Text color — seed comes from the first selected row.  The
            fallback to white is now only the empty-selection safety net
            (BulkEditBar does not render while empty); during normal use
            this branch never runs. */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.textColor')}</span>
          <ColorPicker
            value={colorDraftText ?? '#FFFFFF'}
            onChange={setColorDraftText}
            onCommit={handleTextColorCommit}
            swatchOnly
          />
        </label>

        {/* Outline color — same seeding contract as text color above. */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.outlineColor')}</span>
          <ColorPicker
            value={colorDraftOutline ?? '#000000'}
            onChange={setColorDraftOutline}
            onCommit={handleOutlineColorCommit}
            swatchOnly
          />
        </label>

        {/* Outline thickness — shared with Step 2's per-row slider via
            OutlineThicknessSlider.  Commit semantics, accent-color
            sourcing, readout width and disabled handling all live in
            that component so the two surfaces cannot drift. */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.outlineWidth')}</span>
          <OutlineThicknessSlider
            value={outlineSliderDraft}
            onCommit={handleOutlineWidthCommit}
            ariaLabel={t('bulk.outlineWidth')}
          />
        </label>

        {/* Fade */}
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t('bulk.fade')}</span>
          <Switch onCheckedChange={handleFadeChange} />
        </label>

        {/* Separator + Auto-wrap action.  Visually distinct from the
            value-controls above: this one is a single-shot action that
            recomputes line breaks on the selected rows using each row's
            current font size + outline thickness.  Pre-existing manual
            \N are cleared as part of the recompute — undo restores both
            text and isEdited in one click. */}
        <div
          className="h-5 w-px flex-shrink-0"
          style={{ backgroundColor: 'hsl(var(--separator) / var(--separator-alpha))' }}
          aria-hidden="true"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={handleAutoLineBreakApply}
          title={t('bulk.autoLineBreakHelp')}
          aria-label={t('bulk.autoLineBreakHelp')}
        >
          <WrapText className="h-3.5 w-3.5 mr-1.5" />
          {t('bulk.autoLineBreak')}
        </Button>
      </div>
    </div>
  )
}
