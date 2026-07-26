import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, WrapText, AlignJustify } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { Switch } from '@/components/ui/switch'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { FadeDurationSlider } from '@/components/subtitle-table/fade-duration-slider'
import { NumberStepperInput } from '@/components/subtitle-table/number-stepper-input'
import { ShadowDepthSlider } from '@/components/subtitle-table/shadow-depth-slider'
import { FamilyWeightSelector } from '@/components/subtitle-table/family-weight-selector'
import { StyleRow } from '@/components/subtitle-table/style-row'
import { useSettingsStore } from '@/stores/settings-store'
import { useAppEnvStore } from '@/stores/app-env-store'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../../shared/karaoke-gate'
// REQ-0308 §3 — only the wrap-measurement helpers are imported now; the bulk
// emphasis controls (and the constants they needed) are gone.
import {
  resolveEmphasisRanges,
  mapRangesAcrossBreakCollapse,
  clampEmphasisScalePercent,
} from '../../../shared/emphasis'
import { OpacityPercentSlider } from '@/components/subtitle-table/opacity-percent-slider'
import { OPACITY_DEFAULT_PERCENT } from '../../../shared/alpha'
import { HelpIcon } from '@/components/help-icon'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { useUiStore } from '@/stores/ui-store'
import { applyAutoLineBreak } from '@/lib/auto-line-break'
import { loadSubtitleFont, loadSubtitleFontFor } from '@/lib/font-metrics'
import { toast } from 'sonner'
import type { SubtitleEntry } from '../../../shared/types'
import { effectiveEntryState } from '../../../shared/cuts'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, MARGIN_V_MIN_PX, MARGIN_V_MAX_PX } from '../../../shared/constants'
import { isFontId, type FontId } from '../../../shared/fonts'
import { recomputePinnedPosForAnchorChange } from '@/lib/preview-coords'

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
  verticalPosition: 'top' | 'center' | 'bottom'
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
 * REQ-20260615-059 C — uniform-field detector for the bulk-edit
 * segmented controls.  Returns the shared value when every selected
 * row agrees on `horizontalPosition` / `verticalPosition`, or `null`
 * when the rows disagree (= "mixed" — render no segment highlighted
 * and treat a click as "apply this value to all").
 */
function pickUniformLayoutSegments(selectedIds: ReadonlySet<string>): {
  horizontalPosition: 'left' | 'center' | 'right' | null
  verticalPosition: 'top' | 'center' | 'bottom' | null
} {
  if (selectedIds.size === 0) return { horizontalPosition: null, verticalPosition: null }
  const entries = useProjectStore.getState().entries
  let hp: 'left' | 'center' | 'right' | null = null
  let vp: 'top' | 'center' | 'bottom' | null = null
  let hpSeen = false
  let vpSeen = false
  let hpMixed = false
  let vpMixed = false
  for (const e of entries) {
    if (!selectedIds.has(e.id)) continue
    if (!hpSeen) { hp = e.horizontalPosition; hpSeen = true } else if (e.horizontalPosition !== hp) hpMixed = true
    if (!vpSeen) { vp = e.verticalPosition;   vpSeen = true } else if (e.verticalPosition !== vp)   vpMixed = true
    if (hpMixed && vpMixed) break
  }
  return {
    horizontalPosition: hpMixed ? null : hp,
    verticalPosition:   vpMixed ? null : vp,
  }
}

/**
 * REQ-20260615-059 C — local segmented control matching the inspector's
 * shape (see `timeline-block-inspector.tsx:50`) but accepting `null` as
 * the "no segment selected" state for mixed bulk selections.  Clicking
 * a segment fires `onChange` with the non-null value; the parent
 * commits to every selected row and clears the mixed state.
 */
function BulkSegmentGroup<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
}: {
  value: T | null
  onChange: (next: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  ariaLabel: string
}) {
  // REQ-20260615-060 A — width + per-segment flex match the inspector's
  // SegmentGroup (`timeline-block-inspector.tsx:50`):
  //   - container: `w-[40%] min-w-fit` so H ([左][中央][右]) and V
  //     ([上][下]) share the same total width across the bar row.
  //   - each segment: `flex-1` so the available width is split equally
  //     within a group — V's two cells are now wider than H's three
  //     instead of all four cells shrinking to their text content.
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'flex h-7 w-[40%] min-w-fit items-stretch gap-0.5 rounded-md border border-line-strong bg-surface-0 p-0.5',
        disabled && 'opacity-40 pointer-events-none',
      )}
    >
      {options.map((o) => {
        const selected = value === o.value
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
                : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-2',
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
  const { t } = useTranslation(['step2', 'step1', 'common'])
  const selectedRowIds = useUiStore((s) => s.selectedRowIds)
  // REQ-0275 §5 / REQ-0298 §1 — the FamilyWeightSelector value is
  // driven by a LOCAL draft (`fontDraft`) that seeds from the
  // project's active font at mount / selection-change and updates
  // itself whenever the user picks a new font.  Pre-REQ-0298 the
  // selector was bound directly to `settingsStore.activeFontId`,
  // which the bulk font-change handler never wrote to — so the
  // display swatch stayed on the seed font forever even though the
  // rows were correctly re-fonted via `applyBulk({ fontId })`.
  // Same fix pattern as REQ-0292 §3 (bulk rotation stuck-at-0):
  // the draft is the SOLE binding for what the user sees, and the
  // handler updates BOTH the draft and the store.
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  // REQ-0125 — history-less preview writer used from the color picker's
  // drag path.  See handleTextColorPreview / handleOutlineColorPreview.
  const updateEntriesPreview = useProjectStore((s) => s.updateEntriesPreview)
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
  // REQ-0310 §1 — bulk opacity drafts.  These seed at 100 (fully opaque, the
  // field's own default) rather than 0 like the outline/fade drafts, because
  // 0 % here means "invisible" and a bar that opened on 0 would read as
  // "everything is about to disappear".
  const [textAlphaDraft, setTextAlphaDraft] = useState<number>(OPACITY_DEFAULT_PERCENT)
  const [outlineAlphaDraft, setOutlineAlphaDraft] = useState<number>(OPACITY_DEFAULT_PERCENT)
  // REQ-20260615-050 — bulk fade draft.  Same "remember last applied"
  // semantics as the colour / outline drafts so the slider thumb stays
  // where the user left it across selection changes.  Initial value
  // matches the legacy "fade OFF" semantics (= 0 = no fade).
  const [fadeSliderDraft, setFadeSliderDraft] = useState<number>(0)
  // REQ-0292 §1 — bulk shadow-depth draft.  Same pattern as the other
  // slider drafts: the thumb shows the last-applied value across the
  // current selection session so the user can see "what I set on
  // these rows".  Starts at the neutral default (4) which matches
  // the ass-generator fallback and the inspector's toggle-on seed.
  const [shadowSliderDraft, setShadowSliderDraft] = useState<number>(4)
  // REQ-0292 §3 — bulk rotation draft.  Fixes the stuck-at-0 bug
  // where `NumberStepperInput value={0}` never advanced past the
  // first click: the stepper computes `next = clamp(value + step)`
  // so with value permanently 0 every click applied 15° again and
  // the minus button stayed disabled (value <= min).  Draft state
  // increments alongside each commit so subsequent clicks step
  // relative to the last-applied value, matching the size / margin
  // bulk-draft pattern above.
  const [rotationDraft, setRotationDraft] = useState<number>(0)
  // REQ-0292 §2 / REQ-0293 §2 — bulk karaoke highlight-colour draft
  // only.  The base-colour draft was removed with REQ-0293 because
  // the karaoke sweep now always uses each row's own `textColorHex`
  // for the unspoken half — there's no per-cue override to bulk-set.
  const [karaokeHighlightDraft, setKaraokeHighlightDraft] = useState<string>(KARAOKE_DEFAULT_HIGHLIGHT_COLOR)

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

  // REQ-0298 §1 — bulk font-and-weight draft.  Seeds from the project's
  // active font at mount; the font-change handler writes back to this
  // draft so the FamilyWeightSelector display reflects the last picked
  // font.  Pre-REQ-0298 the selector was bound directly to
  // `settingsStore.activeFontId` which never mutated during bulk font
  // apply — so the swatch stayed on the seed font even though
  // `applyBulk({ fontId })` did re-font every selected row correctly.
  // The bug was purely display-side (identical to the REQ-0292 §3
  // rotation stuck-at-0 bug: read-only binding to an unrelated
  // source-of-truth).
  const [fontDraft, setFontDraft] = useState<FontId>(activeFontId)

  // REQ-20260613-016 Phase 5 — per-row layout + background drafts.  Seed
  // from the first selected row so the initial values show "what the
  // selection currently has" and a re-pick of the seed is a genuine
  // no-op (same contract as colourDraftText/Outline).  When the
  // selection is empty fall back to safe defaults (the bar is hidden
  // while empty so users won't see these).
  const initialLayout = pickFirstSelectedLayout(selectedRowIds)
  const initialSegments = pickUniformLayoutSegments(selectedRowIds)
  // REQ-20260615-059 C — `null` represents the "selection has mixed
  // values for this field" state.  The BulkSegmentGroup renders no
  // segment highlighted in that case; on click the chosen value is
  // committed to every selected row and the local draft flips to the
  // non-null value (selection is now uniform).
  const [hPosDraft,   setHPosDraft]   = useState<'left' | 'center' | 'right' | null>(initialSegments.horizontalPosition)
  const [vPosDraft,   setVPosDraft]   = useState<'top' | 'center' | 'bottom' | null>(initialSegments.verticalPosition)
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
    setFadeSliderDraft(0)
    // REQ-0310 §1 — back to fully opaque on every selection change, matching
    // the field default so the bar never opens primed to hide the subtitles.
    setTextAlphaDraft(OPACITY_DEFAULT_PERCENT)
    setOutlineAlphaDraft(OPACITY_DEFAULT_PERCENT)
    // REQ-0292 §1/§3/§2 — reset the new bulk-effect drafts on every
    // selection change so the controls read as "fresh" for the newly
    // selected rows.  Rotation resets to 0 (any drift from previous
    // selection would be misleading), shadow depth to the same
    // toggle-on default the inspector uses, karaoke colours to the
    // same seeds the inspector shows before the user picks.
    // REQ-0293 §1 — shadow starts at 0 (OFF) after selection change so
    // the slider reads as "no bulk shadow set yet".  Pre-REQ-0293 it
    // seeded at 4 to match the toggle-ON default, but with the Switch
    // gone that seed would visibly apply a shadow to every row the
    // moment the bar mounts.
    setShadowSliderDraft(0)
    setRotationDraft(0)
    setKaraokeHighlightDraft(KARAOKE_DEFAULT_HIGHLIGHT_COLOR)
    // REQ-0298 §1 — re-seed fontDraft from the project's active font
    // on selection change.  Consistent with the "fresh selection ⇒
    // fresh draft" convention every other bulk draft follows.
    setFontDraft(activeFontId)
    setSizeDraft(pickFirstSelectedSize(selectedRowIds))
    const layout = pickFirstSelectedLayout(selectedRowIds)
    if (layout !== null) {
      // REQ-20260615-059 C — h/v drafts come from the uniformity probe
      // so a mixed selection lands on `null` (no segment highlighted)
      // instead of "first row's value" which would have read as
      // "everyone agrees on this" misleadingly.
      const seg = pickUniformLayoutSegments(selectedRowIds)
      setHPosDraft(seg.horizontalPosition)
      setVPosDraft(seg.verticalPosition)
      setMarginDraft(String(layout.verticalMarginPx))
      setBgEnabledDraft(layout.bgEnabled)
      setBgColorDraft(layout.bgColor)
      setBgOpacityDraft(String(layout.bgOpacityPercent))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: activeFontId re-seed happens on selection change only, not on unrelated activeFont mutations.
  }, [selectedRowIds])

  // ---------------------------------------------------------------------
  // Core history op — snapshot every selected entry in full, apply patch
  // to all of them with isEdited:true, register one undo/redo pair.
  // ---------------------------------------------------------------------
  function applyBulk(
    patch: Partial<SubtitleEntry>,
    label: string,
    // REQ-0125 — per-entry field snapshots captured BEFORE the color
    // picker's preview stream mutated the store, so Undo rewinds each
    // row to its individual pre-drag value.  Not needed for other bulk
    // paths (font size, layout, etc.) since they don't stream previews.
    preBeforeSnapshots?: ReadonlyMap<string, Partial<SubtitleEntry>>
  ) {
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

    // REQ-20260615-037 — if this bulk op touches horizontal / vertical /
    // margin, the per-row pinned position (posX/posY) must shift with the
    // new anchor so the user's offset value stays put.  Layout fields can
    // be present in the patch in any combination; we compute the recomputed
    // pos per row and merge it into a per-row patch.  Rows without a pinned
    // pos and rows whose layout fields didn't change return null from the
    // helper and fall through to the plain patch.
    const layoutTouched =
      'horizontalPosition' in patch ||
      'verticalPosition' in patch ||
      'verticalMarginPx' in patch
    const video = useProjectStore.getState().video
    const apply = () => {
      const s = useProjectStore.getState()
      for (const [id, snap] of snapshots) {
        let perRowPatch: Partial<SubtitleEntry> = patch
        if (layoutTouched && video && video.hasVideoStream) {
          const recomputed = recomputePinnedPosForAnchorChange({
            currentHorizontalPosition: snap.horizontalPosition,
            currentVerticalPosition: snap.verticalPosition,
            currentVerticalMarginPx: snap.verticalMarginPx,
            currentPosX: snap.posX,
            currentPosY: snap.posY,
            nextHorizontalPosition: patch.horizontalPosition,
            nextVerticalPosition: patch.verticalPosition,
            nextVerticalMarginPx: patch.verticalMarginPx,
            videoWidthPx: video.widthPx,
            videoHeightPx: video.heightPx,
          })
          if (recomputed) {
            perRowPatch = { ...patch, posX: recomputed.posX, posY: recomputed.posY }
          }
        }
        s.updateEntry(id, { ...perRowPatch, isEdited: true })
      }
    }
    const revert = () => {
      const s = useProjectStore.getState()
      for (const [id, snap] of snapshots) {
        // REQ-0125 — when the caller provided pre-drag field snapshots,
        // override those fields on the naive per-entry snapshot so undo
        // doesn't restore the after-drag values that the color picker's
        // preview stream would otherwise have baked in.
        const beforeOverride = preBeforeSnapshots?.get(id)
        s.updateEntry(id, beforeOverride ? { ...snap, ...beforeOverride } : snap)
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

  // REQ-0125 — refs holding per-entry pre-drag colour values for the
  // current color-picker session.  Populated on the first onChange fire
  // (before the preview mutation lands) so applyBulk's undo path can
  // rewind each row to its own individual pre-drag value.  Cleared on
  // commit so a fresh session snapshots afresh.
  const bulkTextColorBeforeRef = useRef<Map<string, string> | null>(null)
  const bulkOutlineColorBeforeRef = useRef<Map<string, string> | null>(null)
  // REQ-0311 §5 — same per-row "before" bookkeeping for the opacity sliders, so
  // a live drag still collapses to one undo entry.
  const bulkTextAlphaBeforeRef = useRef<Map<string, number | undefined> | null>(null)
  const bulkOutlineAlphaBeforeRef = useRef<Map<string, number | undefined> | null>(null)

  function handleTextColorPreview(hex: string) {
    if (bulkTextColorBeforeRef.current === null) {
      const map = new Map<string, string>()
      const all = useProjectStore.getState().entries
      for (const id of selectedRowIds) {
        const e = all.find((x) => x.id === id)
        if (e) map.set(id, e.textColorHex)
      }
      bulkTextColorBeforeRef.current = map
    }
    setColorDraftText(hex)
    updateEntriesPreview(Array.from(selectedRowIds), { textColorHex: hex })
  }

  function handleTextColorCommit(hex: string) {
    const beforeMap = bulkTextColorBeforeRef.current
    bulkTextColorBeforeRef.current = null
    const preSnapshots = beforeMap
      ? new Map<string, Partial<SubtitleEntry>>(
          Array.from(beforeMap.entries()).map(([id, v]) => [id, { textColorHex: v }])
        )
      : undefined
    applyBulk(
      { textColorHex: hex },
      t('bulk.history.textColor', { count: selectedRowIds.size }),
      preSnapshots
    )
    // Intentionally do NOT clear the draft here — the swatch should keep
    // showing the colour the user just applied so they have a clear visual
    // record of "what was last set on the selection".
    setColorDraftText(hex)
  }

  function handleOutlineColorPreview(hex: string) {
    if (bulkOutlineColorBeforeRef.current === null) {
      const map = new Map<string, string>()
      const all = useProjectStore.getState().entries
      for (const id of selectedRowIds) {
        const e = all.find((x) => x.id === id)
        if (e) map.set(id, e.outlineColorHex)
      }
      bulkOutlineColorBeforeRef.current = map
    }
    setColorDraftOutline(hex)
    updateEntriesPreview(Array.from(selectedRowIds), { outlineColorHex: hex })
  }

  function handleOutlineColorCommit(hex: string) {
    const beforeMap = bulkOutlineColorBeforeRef.current
    bulkOutlineColorBeforeRef.current = null
    const preSnapshots = beforeMap
      ? new Map<string, Partial<SubtitleEntry>>(
          Array.from(beforeMap.entries()).map(([id, v]) => [id, { outlineColorHex: v }])
        )
      : undefined
    applyBulk(
      { outlineColorHex: hex },
      t('bulk.history.outlineColor', { count: selectedRowIds.size }),
      preSnapshots
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

  // REQ-0311 §5 — bulk opacity now streams during the drag so the selection
  // updates live in the preview, instead of only snapping on release.
  //
  // This adopts the colour pickers' per-row "before" snapshot: the preview
  // stream writes through `updateEntriesPreview` (no history), and the single
  // commit at the end carries `preSnapshots` so undo restores each row's own
  // prior value in ONE history entry — not one per rAF frame, and not a single
  // wrong value smeared across rows that started out different.
  //
  // `textAlpha` / `outlineAlpha` are optional (undefined === 100 %, REQ-0310),
  // so the snapshot deliberately stores `undefined` rather than normalising to
  // 100 — otherwise undo would rewrite an untouched row's field to a literal.
  function snapshotAlpha(
    ref: React.MutableRefObject<Map<string, number | undefined> | null>,
    read: (e: SubtitleEntry) => number | undefined,
  ) {
    if (ref.current !== null) return
    const map = new Map<string, number | undefined>()
    const all = useProjectStore.getState().entries
    for (const id of selectedRowIds) {
      const e = all.find((x) => x.id === id)
      if (e) map.set(id, read(e))
    }
    ref.current = map
  }

  function commitAlpha(
    ref: React.MutableRefObject<Map<string, number | undefined> | null>,
    key: 'textAlpha' | 'outlineAlpha',
    v: number,
    label: string,
  ) {
    const beforeMap = ref.current
    ref.current = null
    const preSnapshots = beforeMap
      ? new Map<string, Partial<SubtitleEntry>>(
          Array.from(beforeMap.entries()).map(([id, prev]) => [id, { [key]: prev }]),
        )
      : undefined
    applyBulk({ [key]: v }, label, preSnapshots)
  }

  function handleTextAlphaBulkPreview(v: number) {
    snapshotAlpha(bulkTextAlphaBeforeRef, (e) => e.textAlpha)
    setTextAlphaDraft(v)
    updateEntriesPreview(Array.from(selectedRowIds), { textAlpha: v })
  }
  function handleTextAlphaBulkCommit(v: number) {
    setTextAlphaDraft(v)
    commitAlpha(bulkTextAlphaBeforeRef, 'textAlpha', v,
      t('bulk.history.textColor', { count: selectedRowIds.size }))
  }
  function handleOutlineAlphaBulkPreview(v: number) {
    snapshotAlpha(bulkOutlineAlphaBeforeRef, (e) => e.outlineAlpha)
    setOutlineAlphaDraft(v)
    updateEntriesPreview(Array.from(selectedRowIds), { outlineAlpha: v })
  }
  function handleOutlineAlphaBulkCommit(v: number) {
    setOutlineAlphaDraft(v)
    commitAlpha(bulkOutlineAlphaBeforeRef, 'outlineAlpha', v,
      t('bulk.history.outlineColor', { count: selectedRowIds.size }))
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

  function handleFadeDurationCommit(next: number) {
    setFadeSliderDraft(next)
    applyBulk(
      { fadeDurationSec: next },
      t('bulk.history.fade', { count: selectedRowIds.size })
    )
  }

  // REQ-0277 Phase A — bulk-apply of the style effects.  Each handler
  // pushes a single applyBulk call so every selected row's fields flip
  // together with one Undo entry.  Turning shadow ON without specifying
  // the sub-values seeds neutral defaults (depth 4, black, opaque) so
  // the effect is visible immediately — matches the inspector's
  // toggle-on behaviour.  REQ-0278 dropped the glow bulk-toggle here
  // (see SPECIFICATION.md §11).
  function handleCasingBulk(on: boolean) {
    applyBulk(
      { casing: on ? 'uppercase' : 'none' },
      t('bulk.history.casing', { count: selectedRowIds.size }),
    )
  }
  // REQ-0293 §1 — the pre-REQ-0293 `handleShadowBulkToggle` Switch
  // handler was removed.  Bulk shadow is now driven by the slider
  // alone: depth = 0 turns shadow off across the selection; depth > 0
  // turns it on with the picked value.  The commit seeds neutral
  // colour + alpha defaults on the first non-zero commit so a fresh
  // drag from 0 lands on a visible black shadow rather than an
  // invisible one — same courtesy the pre-REQ-0293 toggle-on path
  // provided.
  function handleShadowDepthBulkCommit(depth: number) {
    setShadowSliderDraft(depth)
    const patch: Partial<SubtitleEntry> = { shadowDepth: depth }
    if (depth > 0) {
      patch.shadowColor = '#000000'
      patch.shadowAlpha = 100
    }
    applyBulk(
      patch,
      t('bulk.history.shadow', { count: selectedRowIds.size }),
    )
  }
  function handleRotationBulk(deg: number) {
    const normalized = ((deg % 360) + 360) % 360
    // REQ-0292 §3 — write the normalised value back into the local
    // draft so the NumberStepperInput's `value` prop advances with
    // each click.  Fixes the pre-REQ-0292 bug where `value={0}` was
    // hardcoded, causing the stepper to compute `next = 0 + 15`
    // every click (always applying 15) with the minus button
    // permanently disabled (`value <= min`).
    setRotationDraft(normalized)
    applyBulk(
      { rotation: normalized },
      t('bulk.history.rotation', { count: selectedRowIds.size }),
    )
  }

  // REQ-0286 §5 — karaoke bulk toggle.  Seeds ONLY the highlight
  // colour (yellow accent) so every selected row gets a visible sweep
  // in one operation.  Base (unspoken) colour is deliberately NOT set:
  // each selected row falls back to its own `textColorHex` at render
  // time (REQ-0290 §1) rather than being clobbered by a uniform
  // default.  Free tier: the row is hidden entirely (tier gate above),
  // so this handler is unreachable on NSIS builds.
  function handleKaraokeBulkToggle(on: boolean) {
    applyBulk(
      on
        ? {
            karaokeEnabled: true,
            karaokeHighlightColor: karaokeHighlightDraft,
          }
        : { karaokeEnabled: false },
      t('bulk.history.karaoke', { count: selectedRowIds.size }),
    )
  }

  // REQ-0292 §2 / REQ-0293 §2 — bulk karaoke highlight picker only.
  // Same preview/commit pattern as the text / outline colour bulk
  // pickers above so a drag in the popover streams live updates to
  // every selected row's overlay, and one history op fires at
  // popover close.  The base-colour bulk picker (and its pre-ref)
  // were removed with REQ-0293 — base now tracks each row's
  // `textColorHex` directly.
  const bulkKaraokeHighlightBeforeRef = useRef<Map<string, string | undefined> | null>(null)

  function handleKaraokeHighlightBulkPreview(hex: string) {
    if (bulkKaraokeHighlightBeforeRef.current === null) {
      const map = new Map<string, string | undefined>()
      const all = useProjectStore.getState().entries
      for (const id of selectedRowIds) {
        const e = all.find((x) => x.id === id)
        if (e) map.set(id, e.karaokeHighlightColor)
      }
      bulkKaraokeHighlightBeforeRef.current = map
    }
    setKaraokeHighlightDraft(hex)
    updateEntriesPreview(Array.from(selectedRowIds), { karaokeHighlightColor: hex })
  }
  function handleKaraokeHighlightBulkCommit(hex: string) {
    const beforeMap = bulkKaraokeHighlightBeforeRef.current
    bulkKaraokeHighlightBeforeRef.current = null
    const preSnapshots = beforeMap
      ? new Map<string, Partial<SubtitleEntry>>(
          Array.from(beforeMap.entries()).map(([id, v]) => [id, { karaokeHighlightColor: v }]),
        )
      : undefined
    applyBulk(
      { karaokeHighlightColor: hex },
      t('bulk.history.karaoke', { count: selectedRowIds.size }),
      preSnapshots,
    )
    setKaraokeHighlightDraft(hex)
  }

  // REQ-0293 §2 — bulk karaoke base-colour handlers removed along
  // with the base picker.  The base half of the karaoke sweep now
  // tracks each row's `textColorHex` at render time; there is no
  // per-cue override to bulk-set.

  // REQ-0308 §3 — the bulk keyword-emphasis handlers were removed along with
  // their row.  See the comment at the (now absent) row in the JSX below.

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
  function handleVPosCommit(v: 'top' | 'center' | 'bottom') {
    setVPosDraft(v)
    applyBulk(
      { verticalPosition: v },
      t('bulk.history.layout', { count: selectedRowIds.size })
    )
  }
  function handleMarginCommit(raw: string) {
    const v = parseInt(raw, 10)
    if (isNaN(v)) return
    const clamped = Math.max(MARGIN_V_MIN_PX, Math.min(MARGIN_V_MAX_PX, v))
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
    // REQ-0298 §1 — update the draft so the FamilyWeightSelector
    // reflects the newly picked font.  `undefined` means "fall back
    // to project default" — visualise that as the project's active
    // font (same seed we use at selection-change re-init).
    setFontDraft(next ?? activeFontId)
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

    // REQ-087 — make sure every per-row font referenced by the selection
    // is in the opentype.js cache before we measure.  `loadSubtitleFont`
    // above only covers the active font; bulk-applied breaks must respect
    // each row's own font (e.g. half-width punctuation in Dela Gothic
    // One vs full-width in Noto), and the fallback path would otherwise
    // overestimate widths by ~45 % and produce broken break positions
    // baked into the saved text.  Best-effort: per-font load failures
    // degrade only that row to the fallback path.
    const uniqueFontIds = new Set<FontId>()
    for (const id of ids) {
      const e = all.find((x) => x.id === id)
      if (e && isFontId(e.fontId)) uniqueFontIds.add(e.fontId)
    }
    await Promise.all(
      Array.from(uniqueFontIds).map((fid) =>
        loadSubtitleFontFor(fid).catch(() => null)
      )
    )

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
        e.fontId,
        // REQ-0306 §2 / REQ-0307 — respect each row's keyword emphasis size
        // when bulk-wrapping.  In "pack" mode `input` has had every `\N`
        // deleted, so the span ranges are shifted onto packed coordinates.
        e.keywordEmphasisEnabled === true
          ? {
              ranges: mode === 'pack'
                ? mapRangesAcrossBreakCollapse(e.text, resolveEmphasisRanges(e), 0)
                : resolveEmphasisRanges(e),
              scale: clampEmphasisScalePercent(e.emphasisScalePercent) / 100,
            }
          : undefined
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
    // REQ-20260614-001 補遺⑤ (C) — BulkEditBar relocated to the right-pane
    // Inspector area.  Outer chrome changed from horizontal `flex items-
    // center gap-4 rounded-lg border bg-...` to a vertical `flex flex-col`
    // stack so the controls fit a ~300-px wide column.  The decorative
    // tint background was dropped since the inspector pane already
    // provides chrome.
    <div
      role="region"
      aria-label={t('bulk.regionLabel')}
      className="flex flex-col gap-3 w-full"
    >
      {/* Top: count + clear */}
      <div className="flex items-center justify-between gap-2">
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

      {/* REQ-20260615-060 B — auto-line-break + overflow-wrap action row.
          Relocated from the bottom of the panel to the very top, just
          under the count/clear row, so it mirrors the inspector pattern
          where action icons sit at the top of the section.  Wrapped
          with `border-y` so a hairline sits both above and below the
          icon row, visually marking it as "actions that apply across
          the selection" before the styled-property sections below. */}
      <div className="flex items-center gap-2 border-y border-border/60 py-2">
        <button
          type="button"
          onClick={handleAutoLineBreakApply}
          title={t('bulk.autoLineBreakHelp')}
          aria-label={t('bulk.autoLineBreakHelp')}
          className={cn(
            'inline-flex items-center justify-center',
            'h-7 w-7 rounded border bg-input text-foreground',
            'border-border hover:border-line-strong transition-colors duration-150',
            'focus:outline-none focus-visible:outline-none',
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
            'border-border hover:border-line-strong transition-colors duration-150',
            'focus:outline-none focus-visible:outline-none',
          )}
        >
          <WrapText className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Controls cluster — REQ-20260614-001 補遺⑪ で 字幕 / レイアウト /
          背景色 の 3 セクションにグルーピングし、単一選択 Inspector の
          並びを bulk 側でも踏襲する。Font picker は補遺⑪ までは下の方に
          並んでいたが、字幕セクションの先頭に移して Inspector 側と
          整合させた。各セクションは `border-t border-border/60 pt-2`
          で区切り線、見出しは `text-body font-semibold text-foreground`
          で表示。 */}
      <div className="flex flex-col">
        {/* § 字幕 — Font, Size, Text colour, Outline colour, Outline
            width, Fade.  BulkFontPicker のトリガはアフォーダンス上 label
            兼用なので、ここでは外側 label を出さず picker 単体を置く。
            REQ-20260615-060 B: the leading `border-t` was retired here
            because the wrap-actions row above us now wears a
            `border-y`, which would otherwise double up with this top
            border into a 2-px line. */}
        <div className="flex flex-col gap-2 pt-2">
          <div className="text-body font-semibold text-foreground">
            {t('timeline.inspector.subtitleSection')}
          </div>
          {/* REQ-0275 §5 — two-tier family + weight picker for bulk.
              Uses activeFontId as the display seed when no rows are
              selected or a heterogeneous selection collapses.  Bulk
              application still goes through `applyBulk({ fontId })`
              (via handleFontChange) so a single Undo restores every
              affected row's prior fontId in one step. */}
          <FamilyWeightSelector
            value={fontDraft}
            onChange={(nextId) => handleFontChange(nextId)}
            // REQ-0296 §3 — show "フォント" / "ウェイト" left labels so
            // the two font rows line up with size / colours / etc.
            showLabels
          />
          {/* Font size — REQ-0298 §4-2 wrapped in shared StyleRow. */}
          <StyleRow label={t('bulk.size')}>
            <NumberStepperInput
              value={parseInt(sizeDraft, 10) || 100}
              min={FONT_SIZE_MIN_PX}
              max={FONT_SIZE_MAX_PX}
              step={10}
              onCommit={(next) => {
                setSizeDraft(String(next))
                handleSizeCommit(String(next))
              }}
              ariaLabel={t('bulk.size')}
              title={t('step1:subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
            />
          </StyleRow>
          {/* Text color + opacity (REQ-0310 §1) — same one-line shape as the
              inspector, in the same shared 224px control column. */}
          <StyleRow label={t('bulk.textColor')}>
            <div className="flex items-center gap-2">
              <ColorPicker
                value={colorDraftText ?? '#FFFFFF'}
                onChange={handleTextColorPreview}
                onCommit={handleTextColorCommit}
                onPairApply={handleColorPairCommit}
                swatchOnly
                heading={t('common:colorPicker.headingText')}
              />
              <OpacityPercentSlider
                value={textAlphaDraft}
                onPreview={handleTextAlphaBulkPreview}
                onCommit={handleTextAlphaBulkCommit}
                ariaLabel={t('styleCell.textOpacity')}
                fullWidth
              />
            </div>
          </StyleRow>
          {/* Outline color + opacity (REQ-0310 §1). */}
          <StyleRow label={t('bulk.outlineColor')}>
            <div className="flex items-center gap-2">
              <ColorPicker
                value={colorDraftOutline ?? '#000000'}
                onChange={handleOutlineColorPreview}
                onCommit={handleOutlineColorCommit}
                onPairApply={handleColorPairCommit}
                swatchOnly
                heading={t('common:colorPicker.headingOutline')}
              />
              <OpacityPercentSlider
                value={outlineAlphaDraft}
                onPreview={handleOutlineAlphaBulkPreview}
                onCommit={handleOutlineAlphaBulkCommit}
                ariaLabel={t('styleCell.outlineOpacity')}
                fullWidth
              />
            </div>
          </StyleRow>
          {/* Outline width — REQ-0300 §2 dropped inner `w-[65%]`;
              StyleRow provides the fixed control column. */}
          <StyleRow label={t('bulk.outlineWidth')}>
            <OutlineThicknessSlider
              value={outlineSliderDraft}
              onCommit={handleOutlineWidthCommit}
              ariaLabel={t('bulk.outlineWidth')}
              fullWidth
            />
          </StyleRow>
          {/* REQ-0292 §4 — bulk-edit style-effect row order mirrors
              the inspector: shadow, karaoke (+ colours), casing,
              rotation, fade.  Bulk-edit intentionally has no text
              input (text is per-cue) but every other row lines up
              with the inspector so users switching between the two
              surfaces don't relearn the layout.
              REQ-0293 §1 — shadow row: single ShadowDepthSlider (0–50,
              0=OFF).  Pre-REQ-0293 had a separate Switch that
              duplicated the "depth is 0" state; removing it lets the
              slider alone drive both the tag emission and the ON/OFF
              affordance.  Draft starts at 0 so a fresh selection reads
              as "no bulk shadow set" and dragging past 0 activates.
              REQ-0293 §2 — karaoke row: highlight ColorPicker only.
              The base-colour picker was removed because base now
              always tracks each row's own `textColorHex`; users
              change the base colour by changing the cue's text
              colour.
              REQ-0292 §3 — rotation NumberStepperInput bound to
              `rotationDraft` (was `value={0}` hardcoded pre-REQ-0292). */}
          <StyleRow label={t('styleCell.shadow')}>
            <ShadowDepthSlider
              value={shadowSliderDraft}
              onCommit={handleShadowDepthBulkCommit}
              ariaLabel={t('styleCell.shadowDepth')}
              fullWidth
            />
          </StyleRow>
          {/* REQ-0278 — glow bulk-toggle removed here (SPECIFICATION.md §11). */}
          {/* REQ-0286 §5 / REQ-0293 §2 — karaoke bulk cluster.  Hidden
              on free tier (`canUseKaraokeInTier(isMsix)` returns
              false).  Highlight picker stays visible whenever the tier
              gate passes so the user can prepare an accent colour and
              then flip the switch.  Base picker was removed with
              REQ-0293 — base always tracks each row's `textColorHex`. */}
          {/* REQ-0296 §2 — single-row karaoke: Switch + highlight
              ColorPicker on the same row as the label.  Matches the
              inspector layout post-REQ-0296.  Picker stays visible
              regardless of Switch state so the row height is
              stable; the colour is applied when the Switch is ON.
              Tier gate hides the entire row on free tier. */}
          {/* REQ-0299 §3 — karaoke state text ("既定色で開始") removed.
              Row is now `[label] [Switch] [ColorPicker]`. */}
          {/* REQ-0300 §1 — Switch + Picker adjacent (no flex-1 spacer),
              both left-aligned inside StyleRow's fixed control column. */}
          {canUseKaraokeInTier(useAppEnvStore((s) => s.isMsix) ?? false) && (
            <StyleRow label={t('styleCell.karaokeRowLabel')}>
              <div className="flex items-center gap-2">
                <Switch onCheckedChange={handleKaraokeBulkToggle} aria-label={t('styleCell.karaoke')} />
                <ColorPicker
                  value={karaokeHighlightDraft}
                  onChange={handleKaraokeHighlightBulkPreview}
                  onCommit={handleKaraokeHighlightBulkCommit}
                  swatchOnly
                  heading={t('styleCell.karaokeHighlightColor')}
                />
              </div>
            </StyleRow>
          )}
          {/* REQ-0308 §3 — the bulk keyword-emphasis row was REMOVED.  Which
              characters get emphasised is a per-cue choice (REQ-0307's picker),
              so there was nothing meaningful to bulk-apply: toggling emphasis on
              across a selection lit up nothing, and the colour / size knobs only
              restyled whatever each cue had already been given individually.
              The inspector and 設定 > 字幕スタイル keep the full emphasis UI.
              Per-row emphasis is still honoured by the two wrap buttons above
              (they read each row's own spans when measuring). */}
          {/* REQ-0299 §3 — casing state text ("ALL CAPS") removed. */}
          <StyleRow label={t('styleCell.casing')}>
            <Switch onCheckedChange={handleCasingBulk} aria-label={t('styleCell.casing')} />
          </StyleRow>
          <StyleRow label={t('styleCell.rotation')}>
            <NumberStepperInput
              value={rotationDraft}
              min={0}
              max={359}
              step={15}
              onCommit={handleRotationBulk}
              ariaLabel={t('styleCell.rotation')}
            />
          </StyleRow>
          {/* Fade — REQ-0292 §4 moved to end of style cluster (matches inspector order). */}
          <StyleRow label={t('bulk.fade')}>
            <FadeDurationSlider
              value={fadeSliderDraft}
              onCommit={handleFadeDurationCommit}
              ariaLabel={t('bulk.fade')}
              fullWidth
            />
          </StyleRow>
        </div>

        {/* § レイアウト — Horizontal, Vertical, Margin. */}
        <div className="flex flex-col gap-2 border-t border-border/60 pt-2 mt-2">
          <div className="text-body font-semibold text-foreground">
            {t('timeline.inspector.layoutSection')}
          </div>
          <label className="flex items-center justify-between gap-2 text-callout font-semibold text-muted-foreground">
            <span>{t('styleCell.layoutH')}</span>
            {/* REQ-20260615-059 C — same segmented control the inspector
                uses.  `null` value renders nothing highlighted (= mixed
                selection); a click applies the value to every selected
                row and flips the draft to the now-uniform value. */}
            <BulkSegmentGroup<'left' | 'center' | 'right'>
              value={hPosDraft}
              onChange={(v) => handleHPosCommit(v)}
              ariaLabel={t('subtitlePosition.horizontal')}
              options={[
                { value: 'left',   label: t('subtitlePosition.left') },
                { value: 'center', label: t('subtitlePosition.center') },
                { value: 'right',  label: t('subtitlePosition.right') },
              ]}
            />
          </label>
          <label className="flex items-center justify-between gap-2 text-callout font-semibold text-muted-foreground">
            <span>{t('styleCell.layoutV')}</span>
            <BulkSegmentGroup<'top' | 'center' | 'bottom'>
              value={vPosDraft}
              onChange={(v) => handleVPosCommit(v)}
              ariaLabel={t('subtitlePosition.vertical')}
              options={[
                { value: 'top',    label: t('subtitlePosition.top') },
                { value: 'center', label: t('subtitlePosition.center') },
                { value: 'bottom', label: t('subtitlePosition.bottom') },
              ]}
            />
          </label>
          {/* REQ-0140 — disable the bulk margin stepper when the
              uniform vertical draft is `'center'`.  When the selection
              is mixed (vPosDraft === null) the stepper stays enabled;
              committing a value applies it to every selected row but
              only affects the top/bottom-aligned ones (center-aligned
              rows keep the value in storage but ignore it at render). */}
          <label
            className="flex items-center justify-between gap-2 text-callout font-semibold text-muted-foreground"
            title={
              vPosDraft === 'center'
                ? t('subtitlePosition.marginDisabledCenter')
                : undefined
            }
          >
            <span>{t('styleCell.marginV')}</span>
            {/* REQ-20260615-059 B — ±10 stepper to keep margin in step
                with size adjustments.  REQ-0269 A raised the ceiling
                to 9999 (`MARGIN_V_MAX_PX`); input widens to `w-16`. */}
            <NumberStepperInput
              value={parseInt(marginDraft, 10) || 0}
              min={MARGIN_V_MIN_PX}
              max={MARGIN_V_MAX_PX}
              step={10}
              widthClass="w-16"
              onCommit={(next) => {
                setMarginDraft(String(next))
                handleMarginCommit(String(next))
              }}
              disabled={vPosDraft === 'center'}
              ariaLabel={t('subtitlePosition.margin')}
            />
          </label>
        </div>

        {/* § 背景色 — Bg ON/OFF, Bg colour, Opacity.  REQ-0096 attaches a
            HelpIcon to the section heading explaining the libass-spec rule
            that enabling BG disables the outline color. */}
        <div className="flex flex-col gap-2 border-t border-border/60 pt-2 mt-2">
          <div className="text-body font-semibold text-foreground flex items-center gap-1.5">
            <span>{t('timeline.inspector.backgroundSection')}</span>
            <HelpIcon content={t('timeline.inspector.backgroundSectionHelp')} />
          </div>
          <label className="flex items-center justify-between gap-2 text-callout font-semibold text-muted-foreground">
            <span>{t('styleCell.bgEnabled')}</span>
            <Switch checked={bgEnabledDraft} onCheckedChange={handleBgEnabledToggle} aria-label={t('styleCell.bgEnabled')} />
          </label>
          {/* REQ-20260615-062 — background colour now uses the same
              segmented control the inspector uses (and the bulk-edit
              horizontal / vertical rows already use), replacing the
              lone <select> that was visually inconsistent with the
              rest of the panel.  Same value bindings: clicking 黒/白
              applies the choice to every selected entry through the
              existing `handleBgColorChange` path.  Mixed selections
              render with no active segment, matching how H / V
              segments behave when the selection's values disagree. */}
          <label className={cn(
            'flex items-center justify-between gap-2 text-callout font-semibold text-muted-foreground',
            !bgEnabledDraft && 'opacity-40'
          )}>
            <span>{t('styleCell.bgColor')}</span>
            <BulkSegmentGroup<'black' | 'white'>
              value={bgColorDraft}
              onChange={(v) => handleBgColorChange(v)}
              disabled={!bgEnabledDraft}
              ariaLabel={t('styleCell.bgColor')}
              options={[
                { value: 'black', label: t('background.black') },
                { value: 'white', label: t('background.white') },
              ]}
            />
          </label>
          <label className={cn(
            'flex items-center justify-between gap-2 text-callout font-semibold text-muted-foreground',
            !bgEnabledDraft && 'opacity-40'
          )}>
            <span>{t('styleCell.bgOpacity')}</span>
            {/* REQ-20260615-059 B — ±10 stepper for bg opacity %.
                Disabled when the bulk panel's bgEnabledDraft is off
                (matches the pre-REQ disabled-input behaviour). */}
            <NumberStepperInput
              value={parseInt(bgOpacityDraft, 10) || 0}
              min={0}
              max={100}
              step={10}
              onCommit={(next) => {
                setBgOpacityDraft(String(next))
                handleBgOpacityCommit(String(next))
              }}
              disabled={!bgEnabledDraft}
              ariaLabel={t('styleCell.bgOpacity')}
            />
          </label>
        </div>

        {/* REQ-20260615-060 B — the bottom wrap-actions cluster was
            relocated to the top of the panel (just under the
            count/clear row), matching the inspector's "action icons
            at the top of the section" pattern.  See the row above
            the controls cluster. */}
      </div>
    </div>
  )
}

