import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, WrapText, AlignJustify, ChevronDown, AlertCircle, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { Switch } from '@/components/ui/switch'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { useSettingsStore } from '@/stores/settings-store'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { loadSubtitleFont } from '@/lib/font-metrics'
import { useInstalledFontIds } from '@/lib/use-installed-fonts'
import { toast } from 'sonner'
import type { SubtitleEntry } from '../../../shared/types'
import { effectiveEntryState } from '../../../shared/cuts'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'
import { FONT_REGISTRY, getFontMeta, type FontId } from '../../../shared/fonts'

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
 * Same seeding pattern as pickFirstSelectedColor but for the font size.
 * Returns '' for an empty selection so the input renders its placeholder
 * naturally on first mount when nothing is selected.
 */
function pickFirstSelectedSize(selectedIds: ReadonlySet<string>): string {
  if (selectedIds.size === 0) return ''
  const entries = useProjectStore.getState().entries
  for (const e of entries) {
    if (selectedIds.has(e.id)) return String(e.fontSizePx)
  }
  return ''
}

/**
 * REQ-20260613-016 Phase 5 — seed the bulk-edit-bar's per-row layout +
 * background drafts from the first selected row.  Returns undefined when
 * the selection is empty so the caller can decide on a sensible fallback.
 */
function pickFirstSelectedLayout(selectedIds: ReadonlySet<string>): {
  horizontalPosition: 'left' | 'center' | 'right'
  verticalPosition: 'top' | 'bottom'
  verticalMarginPx: number
  bgEnabled: boolean
  bgColor: 'black' | 'white'
  bgOpacityPercent: number
} | null {
  if (selectedIds.size === 0) return null
  const entries = useProjectStore.getState().entries
  for (const e of entries) {
    if (selectedIds.has(e.id)) {
      return {
        horizontalPosition: e.horizontalPosition,
        verticalPosition: e.verticalPosition,
        verticalMarginPx: e.verticalMarginPx,
        bgEnabled: e.subtitleBackground.enabled,
        bgColor: e.subtitleBackground.color,
        bgOpacityPercent: e.subtitleBackground.opacityPercent,
      }
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
  // step1 included so the size input's `title` tooltip can reuse the
  // `subtitleDefaults.sizeHint` string defined for STEP 1 (REQ-034 #3).
  const { t } = useTranslation(['step2', 'step1'])
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

  // REQ-047 #1: same persist-then-re-seed pattern as the colour drafts.
  // Previously the size input was uncontrolled and cleared on blur
  // (`e.target.value = ''`), which made it look like the apply had
  // been lost even though the toast confirmed N rows changed.  Now
  // the value stays visible after commit and only re-seeds when the
  // selection itself changes — matching the colour swatches' "shows
  // what was last applied to the current selection" affordance.
  const [sizeDraft, setSizeDraft] = useState<string>(() =>
    pickFirstSelectedSize(selectedRowIds)
  )

  // REQ-20260613-016 Phase 5 — per-row layout + background drafts.  Seed
  // from the first selected row so the initial values show "what the
  // selection currently has" and a re-pick of the seed is a genuine
  // no-op (same contract as colourDraftText/Outline).  When the
  // selection is empty fall back to safe defaults (the bar is hidden
  // while empty so users won't see these).
  const initialLayout = pickFirstSelectedLayout(selectedRowIds)
  const [hPosDraft,   setHPosDraft]   = useState<'left' | 'center' | 'right'>(initialLayout?.horizontalPosition ?? 'center')
  const [vPosDraft,   setVPosDraft]   = useState<'top' | 'bottom'>(initialLayout?.verticalPosition ?? 'bottom')
  const [marginDraft, setMarginDraft] = useState<string>(String(initialLayout?.verticalMarginPx ?? 40))
  const [bgEnabledDraft, setBgEnabledDraft]     = useState<boolean>(initialLayout?.bgEnabled ?? false)
  const [bgColorDraft, setBgColorDraft]         = useState<'black' | 'white'>(initialLayout?.bgColor ?? 'black')
  const [bgOpacityDraft, setBgOpacityDraft]     = useState<string>(String(initialLayout?.bgOpacityPercent ?? 50))

  // Re-seed every draft when the selection itself changes.  Reads
  // `entries` via getState() so the effect only fires on selection
  // change — not on every entry mutation (which would otherwise reset
  // the user's in-progress pick whenever a row's text was edited).
  useEffect(() => {
    setColorDraftText(pickFirstSelectedColor(selectedRowIds, 'text'))
    setColorDraftOutline(pickFirstSelectedColor(selectedRowIds, 'outline'))
    setOutlineSliderDraft(0)
    setSizeDraft(pickFirstSelectedSize(selectedRowIds))
    const layout = pickFirstSelectedLayout(selectedRowIds)
    if (layout !== null) {
      setHPosDraft(layout.horizontalPosition)
      setVPosDraft(layout.verticalPosition)
      setMarginDraft(String(layout.verticalMarginPx))
      setBgEnabledDraft(layout.bgEnabled)
      setBgColorDraft(layout.bgColor)
      setBgOpacityDraft(String(layout.bgOpacityPercent))
    }
  }, [selectedRowIds])

  // ---------------------------------------------------------------------
  // Core history op — snapshot every selected entry in full, apply patch
  // to all of them with isEdited:true, register one undo/redo pair.
  // ---------------------------------------------------------------------
  function applyBulk(patch: Partial<SubtitleEntry>, label: string) {
    const ids = Array.from(selectedRowIds)
    if (ids.length === 0) return

    const all = useProjectStore.getState().entries
    // REQ-119 [1] — bulk-edit cannot touch frozen rows (manual delete OR
    // trim delete per REQ-118 spec §2.1).  The subtitle-table chrome
    // already blocks frozen rows from entering the selection; this
    // belt-and-braces filter catches any selection that pre-dates a
    // status change (e.g. the user selected a normal row, then a cut
    // turned it into trimDeleted while it was still in the selection set).
    const cuts = useProjectStore.getState().cuts
    const snapshots = new Map<string, SubtitleEntry>()
    for (const id of ids) {
      const e = all.find((x) => x.id === id)
      if (!e) continue
      if (e.isDeleted) continue
      if (effectiveEntryState(e, cuts).status === 'trimDeleted') continue
      snapshots.set(id, { ...e })
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
    // REQ-047 #1: persist the just-applied (clamped) value as the
    // visible draft so the input doesn't blank out.  Surfaces "what
    // was applied", and if the typed value was out of range the user
    // sees the clamped result it landed on.
    setSizeDraft(String(clamped))
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

  // REQ-033: pair click in the popover sets BOTH halves on every
  // selected row via a single applyBulk patch + single history op.  Two
  // updates squashed into one undo / redo step matches the user's mental
  // model of "I picked a pair".
  function handleColorPairCommit(textHex: string, outlineHex: string) {
    applyBulk(
      { textColorHex: textHex, outlineColorHex: outlineHex },
      t('bulk.history.colorPair', { count: selectedRowIds.size })
    )
    setColorDraftText(textHex)
    setColorDraftOutline(outlineHex)
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

  // REQ-20260613-016 Phase 5 — per-row layout / background bulk handlers.
  // Layout fields (horizontal / vertical / margin) commit independently
  // since each row's existing value of the other two should stay put.
  // Background commits as a single object with the bulk bar's full draft
  // (enabled + color + opacity), matching how the user mentally configures
  // a background as "ON, black, 70%" all at once.

  function handleHPosCommit(v: 'left' | 'center' | 'right') {
    setHPosDraft(v)
    applyBulk(
      { horizontalPosition: v },
      t('bulk.history.layout', { count: selectedRowIds.size })
    )
  }
  function handleVPosCommit(v: 'top' | 'bottom') {
    setVPosDraft(v)
    applyBulk(
      { verticalPosition: v },
      t('bulk.history.layout', { count: selectedRowIds.size })
    )
  }
  function handleMarginCommit(raw: string) {
    const v = parseInt(raw, 10)
    if (isNaN(v)) return
    const clamped = Math.max(0, Math.min(300, v))
    applyBulk(
      { verticalMarginPx: clamped },
      t('bulk.history.margin', { count: selectedRowIds.size })
    )
    setMarginDraft(String(clamped))
  }
  function applyBackgroundFromDrafts(next: {
    enabled: boolean
    color: 'black' | 'white'
    opacityPercent: number
  }) {
    applyBulk(
      { subtitleBackground: next },
      t('bulk.history.background', { count: selectedRowIds.size })
    )
  }
  function handleBgEnabledToggle(checked: boolean) {
    setBgEnabledDraft(checked)
    applyBackgroundFromDrafts({
      enabled: checked,
      color: bgColorDraft,
      opacityPercent: Math.max(0, Math.min(100, parseInt(bgOpacityDraft, 10) || 50)),
    })
  }
  function handleBgColorChange(color: 'black' | 'white') {
    setBgColorDraft(color)
    applyBackgroundFromDrafts({
      enabled: bgEnabledDraft,
      color,
      opacityPercent: Math.max(0, Math.min(100, parseInt(bgOpacityDraft, 10) || 50)),
    })
  }
  function handleBgOpacityCommit(raw: string) {
    const v = parseInt(raw, 10)
    if (isNaN(v)) return
    const clamped = Math.max(0, Math.min(100, v))
    setBgOpacityDraft(String(clamped))
    applyBackgroundFromDrafts({
      enabled: bgEnabledDraft,
      color: bgColorDraft,
      opacityPercent: clamped,
    })
  }

  // Bulk font change — `undefined` means "fall back to project default"
  // on every selected row (clears any per-row override).  We pass the
  // value through applyBulk so undo restores each row's *individual*
  // prior fontId in one step, which is critical because the rows might
  // have had heterogeneous overrides before the bulk apply.
  // REQ-022 step 2.
  function handleFontChange(next: FontId | undefined) {
    applyBulk(
      { fontId: next },
      t('bulk.history.font', { count: selectedRowIds.size })
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
  // REQ-20260612-003 §1: bulk wrap apply, shared between 敷き詰め改行
  // (mode='pack') and はみ出し改行 (mode='overflow').  Width / font /
  // outline measurement passes through the same `applyAutoLineBreak`
  // call regardless of mode — only the pre-strip step differs, so the
  // two bulk buttons can never disagree on break positions for a given
  // single line (= §6 #8 共通幅基準の確認).
  async function runBulkWrap(
    mode: 'pack' | 'overflow',
    labels: { historyKey: 'autoLineBreak' | 'overflowWrap'; noChangeKey: 'autoLineBreakNoChange' | 'overflowWrapNoChange' }
  ) {
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
    // REQ-119 [1] — same freeze filter as `applyBulk` so the wrap pass
    // never rewraps a trim-deleted row mid-bulk.
    const cuts = useProjectStore.getState().cuts

    const snapshots = new Map<string, SubtitleEntry>()
    const patches = new Map<string, string>()

    for (const id of ids) {
      const e = all.find((x) => x.id === id)
      if (!e || e.isDeleted) continue
      if (effectiveEntryState(e, cuts).status === 'trimDeleted') continue
      // Only difference between the two modes: pack pre-strips so
      // applyAutoLineBreak sees a single long line; overflow passes
      // the text through with existing `\N` intact.
      const input = mode === 'pack' ? e.text.replace(/\\N/g, '') : e.text
      // Per-row fontId (REQ-021): bulk-applied breaks must respect each
      // row's own font, otherwise rows whose fontId differs from the
      // active selection would break at positions that don't match the
      // burned-in result.
      const rewrapped = applyAutoLineBreak(
        input,
        e.fontSizePx,
        e.outlineThicknessPx,
        videoWidthPx,
        font,
        e.fontId
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
      toast.info(t(`bulk.${labels.noChangeKey}`))
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

    const label = t(`bulk.history.${labels.historyKey}`, { count: snapshots.size })
    useHistoryStore.getState().push({ label, undo: revert, redo: apply })
    apply()
    onApplied(snapshots.size, label)
  }

  function handleAutoLineBreakApply() {
    return runBulkWrap('pack', {
      historyKey: 'autoLineBreak',
      noChangeKey: 'autoLineBreakNoChange'
    })
  }

  function handleOverflowWrapApply() {
    return runBulkWrap('overflow', {
      historyKey: 'overflowWrap',
      noChangeKey: 'overflowWrapNoChange'
    })
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
        <span className="text-body-sm font-medium text-foreground tabular-nums">
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
        {/* Font size — REQ-047 #1: controlled input that seeds from the
            first selected row and persists the user's applied value
            after blur.  onFocus selects the existing content so re-
            typing replaces in one keystroke (vs. clicking + manually
            highlighting before typing). */}
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('bulk.size')}</span>
          <input
            type="number"
            min={FONT_SIZE_MIN_PX}
            max={FONT_SIZE_MAX_PX}
            placeholder={t('bulk.placeholder')}
            value={sizeDraft}
            onChange={(e) => setSizeDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            // REQ-034 #3: tooltip surfaces the clamp range so a user
            // typing 700 sees the cause when the input snaps back to
            // 600 on blur (cap raised from 200 to 600 in REQ-041).
            title={t('step1:subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
            onBlur={(e) => {
              if (e.target.value === '') return
              handleSizeCommit(e.target.value)
            }}
            /* REQ-082: Enter handler removed.  Blur commits the value. */
            className={cn(
              'w-16 h-7 rounded border bg-input px-2 text-center text-body-sm text-foreground',
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
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('bulk.textColor')}</span>
          <ColorPicker
            value={colorDraftText ?? '#FFFFFF'}
            onChange={setColorDraftText}
            onCommit={handleTextColorCommit}
            onPairApply={handleColorPairCommit}
            swatchOnly
          />
        </label>

        {/* Outline color — same seeding contract as text color above. */}
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('bulk.outlineColor')}</span>
          <ColorPicker
            value={colorDraftOutline ?? '#000000'}
            onChange={setColorDraftOutline}
            onCommit={handleOutlineColorCommit}
            onPairApply={handleColorPairCommit}
            swatchOnly
          />
        </label>

        {/* Outline thickness — shared with Step 2's per-row slider via
            OutlineThicknessSlider.  Commit semantics, accent-color
            sourcing, readout width and disabled handling all live in
            that component so the two surfaces cannot drift. */}
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('bulk.outlineWidth')}</span>
          <OutlineThicknessSlider
            value={outlineSliderDraft}
            onCommit={handleOutlineWidthCommit}
            ariaLabel={t('bulk.outlineWidth')}
          />
        </label>

        {/* Fade */}
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('bulk.fade')}</span>
          <Switch onCheckedChange={handleFadeChange} />
        </label>

        {/* REQ-20260613-016 Phase 5 / 機能A — bulk layout + background.
            Drafts seeded from the first selected row so the displayed
            values reflect "what the selection looks like now".  Layout
            fields commit independently; background commits the full
            object from drafts so toggling enabled mid-edit captures
            the user's intended color + opacity in one step. */}
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('styleCell.layoutH')}</span>
          <select
            value={hPosDraft}
            onChange={(e) => handleHPosCommit(e.target.value as 'left' | 'center' | 'right')}
            className={cn(
              'h-7 rounded border bg-input px-1.5 text-body-sm text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-ring/30',
              'border-border'
            )}
            aria-label={t('subtitlePosition.horizontal')}
          >
            <option value="left">{t('subtitlePosition.left')}</option>
            <option value="center">{t('subtitlePosition.center')}</option>
            <option value="right">{t('subtitlePosition.right')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('styleCell.layoutV')}</span>
          <select
            value={vPosDraft}
            onChange={(e) => handleVPosCommit(e.target.value as 'top' | 'bottom')}
            className={cn(
              'h-7 rounded border bg-input px-1.5 text-body-sm text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-ring/30',
              'border-border'
            )}
            aria-label={t('subtitlePosition.vertical')}
          >
            <option value="top">{t('subtitlePosition.top')}</option>
            <option value="bottom">{t('subtitlePosition.bottom')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('styleCell.marginV')}</span>
          <input
            type="number"
            min={0}
            max={300}
            value={marginDraft}
            onChange={(e) => setMarginDraft(e.target.value)}
            onBlur={(e) => {
              if (e.target.value === '') return
              handleMarginCommit(e.target.value)
            }}
            className={cn(
              'w-16 h-7 rounded border bg-input px-2 text-center text-body-sm text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-ring/30',
              'border-border',
              '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'
            )}
            aria-label={t('subtitlePosition.margin')}
          />
        </label>
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('styleCell.bgEnabled')}</span>
          <Switch checked={bgEnabledDraft} onCheckedChange={handleBgEnabledToggle} aria-label={t('styleCell.bgEnabled')} />
        </label>
        <label className={cn(
          'flex items-center gap-2 text-callout font-semibold text-muted-foreground',
          !bgEnabledDraft && 'opacity-40'
        )}>
          <span>{t('styleCell.bgColor')}</span>
          <select
            value={bgColorDraft}
            onChange={(e) => handleBgColorChange(e.target.value as 'black' | 'white')}
            disabled={!bgEnabledDraft}
            className={cn(
              'h-7 rounded border bg-input px-1.5 text-body-sm text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-ring/30',
              'border-border',
              'disabled:cursor-not-allowed'
            )}
            aria-label={t('styleCell.bgColor')}
          >
            <option value="black">{t('background.black')}</option>
            <option value="white">{t('background.white')}</option>
          </select>
        </label>
        <label className={cn(
          'flex items-center gap-2 text-callout font-semibold text-muted-foreground',
          !bgEnabledDraft && 'opacity-40'
        )}>
          <span>{t('styleCell.bgOpacity')}</span>
          <input
            type="number"
            min={0}
            max={100}
            value={bgOpacityDraft}
            disabled={!bgEnabledDraft}
            onChange={(e) => setBgOpacityDraft(e.target.value)}
            onBlur={(e) => {
              if (e.target.value === '') return
              handleBgOpacityCommit(e.target.value)
            }}
            className={cn(
              'w-16 h-7 rounded border bg-input px-2 text-center text-body-sm text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-ring/30',
              'border-border',
              'disabled:cursor-not-allowed',
              '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none'
            )}
            aria-label={t('styleCell.bgOpacity')}
          />
        </label>

        {/* Bulk font (REQ-022 step 2).  Same popover content as the
            per-row picker (RowFontSelector) but with a static "フォント"
            trigger label — selection here applies to every row in the
            current bulk selection. */}
        <label className="flex items-center gap-2 text-callout font-semibold text-muted-foreground">
          <span>{t('bulkRowFont.label')}</span>
          <BulkFontPicker onPick={handleFontChange} />
        </label>

        {/* Separator + Wrap actions.  REQ-20260612-003 §1 / §2:
            two single-shot wrap buttons that recompute line breaks on
            the selected rows using each row's own font size +
            outline thickness.  Both are icon-only square pills with a
            native title tooltip (= name + description), matching the
            adjacent row-end action icons in subtitle-table.tsx.
            Order: 敷き詰め改行 (pack, AlignJustify) →
            はみ出し改行 (overflow, WrapText). */}
        <div
          className="h-5 w-px flex-shrink-0"
          style={{ backgroundColor: 'hsl(var(--separator) / var(--separator-alpha))' }}
          aria-hidden="true"
        />
        <button
          type="button"
          onClick={handleAutoLineBreakApply}
          title={t('bulk.autoLineBreakHelp')}
          aria-label={t('bulk.autoLineBreakHelp')}
          className={cn(
            'inline-flex items-center justify-center',
            'h-7 w-7 rounded border bg-input text-foreground',
            'border-border hover:border-zinc-700 transition-colors duration-150',
            'focus:outline-none focus-visible:outline-none'
          )}
        >
          <AlignJustify className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleOverflowWrapApply}
          title={t('bulk.overflowWrapHelp')}
          aria-label={t('bulk.overflowWrapHelp')}
          className={cn(
            'inline-flex items-center justify-center',
            'h-7 w-7 rounded border bg-input text-foreground',
            'border-border hover:border-zinc-700 transition-colors duration-150',
            'focus:outline-none focus-visible:outline-none'
          )}
        >
          <WrapText className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bulk font picker — Popover content mirrors RowFontSelector's, but the
// trigger is a fixed "Font" pill with no row-specific state.  Kept inline
// because pulling it into its own file would duplicate the use-installed-
// fonts + font-registry filter logic without giving any new abstraction.
// ---------------------------------------------------------------------------
function BulkFontPicker({ onPick }: { onPick: (next: FontId | undefined) => void }) {
  const { t } = useTranslation(['step2', 'step1'])
  const [open, setOpen] = useState(false)
  const installed = useInstalledFontIds()
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  const selectable = FONT_REGISTRY.filter((m) => installed.has(m.id))

  function pick(next: FontId | undefined) {
    onPick(next)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-between gap-1.5',
            'h-7 px-2 rounded border bg-input text-body-sm text-foreground',
            'border-border hover:border-zinc-700',
            'focus:outline-none focus-visible:outline-none'
          )}
          aria-label={t('bulkRowFont.label')}
        >
          <span>{t('bulkRowFont.label')}</span>
          <ChevronDown className="h-3 w-3 text-zinc-500" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1">
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => pick(undefined)}
            className="flex items-center gap-2 px-2 py-1.5 rounded text-body-sm text-left text-zinc-100 hover:bg-accent/40 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">
              <span className="block leading-tight">{t('bulkRowFont.useDefault')}</span>
              <span className="block text-caption text-zinc-500 truncate">
                {getFontMeta(activeFontId).displayName}
              </span>
            </span>
          </button>

          <div className="my-1 h-px bg-zinc-800" />

          {selectable.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => pick(m.id)}
              className="flex items-center gap-2 px-2 py-1.5 rounded text-body-sm text-left text-zinc-300 hover:bg-accent/40"
            >
              <span className="h-2 w-2 rounded-full bg-zinc-600 shrink-0" aria-hidden="true" />
              <span
                className="flex-1 min-w-0 truncate"
                style={{ fontFamily: `'${m.cssFontFamily}'`, fontWeight: m.weight }}
              >
                {m.displayName}
              </span>
              {m.lacksRareKanji && (
                <span
                  className="inline-flex items-center shrink-0 text-amber-400/80"
                  title={t('step1:fontPicker.note.missingRareKanjiHelp')}
                >
                  <AlertCircle className="h-3 w-3" aria-hidden="true" />
                </span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
