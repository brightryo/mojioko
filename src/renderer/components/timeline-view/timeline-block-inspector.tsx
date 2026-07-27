import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock, Trash2, Undo2, Eraser, WrapText, AlignJustify, CopyPlus, ChevronLeft, ChevronRight, ChevronDown, RotateCcw, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { useProjectStore } from '@/stores/project-store'
import { useHistoryStore } from '@/stores/history-store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { EmphasisPickerDialog } from '@/components/step2/emphasis-picker-dialog'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { OpacityPercentSlider } from '@/components/subtitle-table/opacity-percent-slider'
import { clampOpacityPercent } from '../../../shared/alpha'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { NumberStepperInput } from '@/components/subtitle-table/number-stepper-input'
import { ShadowDepthSlider } from '@/components/subtitle-table/shadow-depth-slider'
import { LineSpacingSlider } from '@/components/subtitle-table/line-spacing-slider'
import { resolveLineSpacingPercent } from '../../../shared/line-spacing'
import { SegmentGroup } from '@/components/subtitle-table/segment-group'
import { StyleRow } from '@/components/subtitle-table/style-row'
import { FamilyWeightSelector } from '@/components/subtitle-table/family-weight-selector'
import { useSettingsStore } from '@/stores/settings-store'
// REQ-0335 §3 — style presets.
import { StylePresetControls } from '@/components/style-preset/style-preset-controls'
import { buildStylePreset, resolveStylePresetPatch } from '@/lib/style-preset-apply'
import type { StylePreset } from '../../../shared/style-preset'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
// REQ-0311 §4 / REQ-0315 §2 — karaoke display style (adopted; default sweep).
import { coerceKaraokeStyle, resolveKaraokeStyle, KARAOKE_STYLE_DEFAULT } from '../../../shared/karaoke-style'
import { resolveAnimation, ANIMATION_BLUR_ENABLED } from '../../../shared/cue-animation'
import { AnimationControls, type AnimationControlsValue } from '@/components/animation-controls/animation-controls'
import { useAppEnvStore } from '@/stores/app-env-store'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../../shared/karaoke-gate'
import {
  canUseKeywordEmphasisInTier,
  resolveEmphasis,
  clampEmphasisScalePercent,
  type EmphasisSpan,
  EMPHASIS_DEFAULT_COLOR,
  EMPHASIS_DEFAULT_SCALE_PERCENT,
  EMPHASIS_SCALE_MIN_PERCENT,
  EMPHASIS_SCALE_MAX_PERCENT,
  EMPHASIS_SCALE_STEP_PERCENT,
} from '../../../shared/emphasis'
import { HelpIcon } from '@/components/help-icon'
import { useIsAudioOnly } from '@/hooks/use-input-mode'
import { type EntryWarnings } from '@/lib/entry-warnings'
import {
  autoLineBreakRow as runAutoLineBreakRow,
  overflowWrapRow as runOverflowWrapRow,
  resetRow as runResetRow,
  toggleDeleteRow as runToggleDeleteRow,
  duplicateRow as runDuplicateRow
} from '@/lib/entry-row-actions'
import { commitTextEditWithHistory } from '@/lib/commit-text-edit'
import { formatEditedTimecode, editedDurationOfEntry } from '@/lib/time'
import { shortcutHint } from '@/lib/shortcut-hint'
import { getAnchorAssPosition, clampAssPosition, recomputePinnedPosForAnchorChange } from '@/lib/preview-coords'
import { effectiveEntryState } from '../../../shared/cuts'
import {
  FONT_SIZE_MIN_PX,
  FONT_SIZE_MAX_PX,
  MARGIN_V_MIN_PX,
  MARGIN_V_MAX_PX,
  INSPECTOR_TEXTAREA_MAX_HEIGHT_RATIO,
} from '../../../shared/constants'
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
// REQ-0298 §4-1 — SegmentGroup extracted to
// `@/components/subtitle-table/segment-group` so the settings
// 「字幕スタイル」 tab uses the exact same pill styling.  Import
// added above with the other shared components.

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
  // REQ-0275 §5 — active default is read for the inherit-collapse in
  // FamilyWeightSelector's onChange (concrete FontId that equals
  // activeFontId is stored as `undefined` = inherit).
  const activeFontId = useSettingsStore((s) => s.activeFontId)
  // REQ-0311 §4 / REQ-0315 §2 — karaoke display style (adopted; default sweep).
  // REQ-0324 §4-1 — no app-wide setting any more; the fallback is the
  // constant default.
  const karaokeStyleResolved = resolveKaraokeStyle(entry.karaokeStyle, KARAOKE_STYLE_DEFAULT)

  // REQ-0324 §1 — the row shows the RESOLVED spec, so a legacy cue that
  // only carries `fadeDurationSec` displays as fade at its own length
  // rather than as "none".  Editing writes the explicit fields, which
  // then take over permanently (see `resolveAnimation`).
  const animSpec = resolveAnimation(entry)
  function handleAnimationChange(patch: Partial<AnimationControlsValue>) {
    // Write the WHOLE resolved spec, not only the changed key.  A legacy
    // cue has no `animation*` fields at all; patching just one would leave
    // the others falling through the migration branch, and the edit would
    // appear not to stick.
    applyStyleEdit(t('history.editAnimation'), {
      animationType: patch.type ?? animSpec.type,
      animationInEnabled: patch.inEnabled ?? animSpec.inEnabled,
      animationOutEnabled: patch.outEnabled ?? animSpec.outEnabled,
      animationDurationSec: patch.durationSec ?? animSpec.durationSec,
      animationStartScalePercent:
        patch.startScalePercent ?? Math.round(animSpec.startScale * 100),
      animationBlurPx: patch.blurPx ?? animSpec.blurMaxPx,
    })
  }
  // REQ-0125 — history-less preview writer used from the color picker's
  // drag path.  See handleTextColorPreview / handleOutlineColorPreview.
  const updateEntryPreview = useProjectStore((s) => s.updateEntryPreview)
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
  // REQ-0311 §2 — the textarea's own default (`rows={3}`) height, measured once
  // on first paint.  Null until measured.
  const textareaNaturalHeightRef = useRef<number | null>(null)
  const [sizeOutOfRange, setSizeOutOfRange] = useState(false)

  // REQ-0184 §4 — per-section collapse state for the three inspector
  // sections (subtitle / layout / background).  Owner spec:
  //   subtitle    -- default open
  //   layout      -- default open
  //   background  -- default closed
  // State is **local** to the component instance, so it persists
  // across row-selection changes (React keeps the same
  // TimelineBlockInspector instance mounted as `entry` prop swaps),
  // but resets whenever the inspector unmounts (empty selection,
  // step2 route unmount).  This matches the REQ's "毎回、編集画面に入
  // ったら 開/開/閉 で始まる" spec — entering step2 fresh gives the
  // defaults; the user can toggle within a session.
  const [subtitleSectionOpen, setSubtitleSectionOpen] = useState(true)

  /**
   * REQ-0311 §2 — pin the drag-resize bounds to the textarea's OWN rendered
   * height: floor = the default height (so it can never shrink below what it
   * ships as), ceiling = `INSPECTOR_TEXTAREA_MAX_HEIGHT_RATIO` x that.
   *
   * Measured at runtime instead of hardcoded because the default height is a
   * product of `text-body` + `leading-snug` + `py-1.5` + the border, and any
   * token change would silently invalidate a px literal.
   *
   * Written imperatively rather than through the `style` prop on purpose: the
   * browser stores a user drag as an inline `height` on the same style
   * attribute, and a React-managed `style` object would fight it on the next
   * render.  React never touches these properties, so the drag survives —
   * the same division of labour the karaoke rAF loop uses for `style.color`.
   *
   * Runs when the section first opens (a collapsed section is `hidden`, so it
   * measures 0) and latches after the first non-zero measurement, so a user
   * resize is never mistaken for the natural height.
   */
  useEffect(() => {
    if (!subtitleSectionOpen) return
    if (textareaNaturalHeightRef.current !== null) return
    const el = textareaRef.current
    if (!el) return
    const natural = el.getBoundingClientRect().height
    if (natural <= 0) return
    textareaNaturalHeightRef.current = natural
    el.style.minHeight = `${natural}px`
    el.style.maxHeight = `${natural * INSPECTOR_TEXTAREA_MAX_HEIGHT_RATIO}px`
  }, [subtitleSectionOpen])
  const [layoutSectionOpen, setLayoutSectionOpen] = useState(true)
  const [animationSectionOpen, setAnimationSectionOpen] = useState(true)
  const [backgroundSectionOpen, setBackgroundSectionOpen] = useState(false)
  // REQ-0307 §1 — the per-character emphasis picker lives behind the row's
  // 「編集」 button, so the inspector row itself stays one line tall.
  const [emphasisPickerOpen, setEmphasisPickerOpen] = useState(false)
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
  // REQ-0127 Phase 1 — snapshot of `entry.text` when the textarea
  // gained focus.  Populated in onFocus and cleared in onBlur; used
  // as the beforePatch on the commit-time history push so Undo
  // rewinds past every preview keystroke to the pre-focus text.
  const textFocusValueRef = useRef<string | null>(null)

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
    // REQ-0199 — capture-and-clear the pre-focus ref BEFORE handing off, so
    // the helper's guard has the correct comparator and any subsequent focus
    // session starts clean regardless of whether history was pushed.  The
    // dirty flag is likewise cleared unconditionally — the sync effect
    // (L204-208) treats dirtyRef=false as "safe to accept external updates,"
    // which is true both when we pushed and when the guard skipped.
    const focusText = textFocusValueRef.current
    textFocusValueRef.current = null
    commitTextEditWithHistory({
      entry,
      normalizedNew: normalized,
      normalizedOnFocus: focusText,
      label: t('history.editText'),
      updateEntry,
      pushHistory,
    })
    dirtyRef.current = false
  }

  /**
   * History-aware style patch.  Mirrors subtitle-table.tsx's `withHistory`
   * helper so Inspector edits and table edits share both the history
   * shape and the auto-mark-edited side effect.  Time fields are
   * deliberately NOT supported here — those flow through the dedicated
   * TimeEditorDialog or drag handlers in TimelineView.
   */
  function applyStyleEdit(
    label: string,
    patch: Partial<SubtitleEntry>,
    // REQ-0125 — when the caller (color picker's onCommit) has already
    // streamed preview mutations into the store during a drag, `entry`
    // (and therefore `snapshot`) reflects the AFTER value.  A naive
    // `updateEntry(id, snapshot)` on undo would then restore the after
    // value = no-op.  Passing `beforePatch` with the fields' pre-drag
    // values overrides those fields on the undo path so the popover's
    // coarse-grained history op rewinds all the way past the drag
    // stream.
    beforePatch?: Partial<SubtitleEntry>
  ) {
    const snapshot = { ...entry }
    const undoState = beforePatch ? { ...snapshot, ...beforePatch } : snapshot
    pushHistory({
      label,
      undo: () => updateEntry(entry.id, undoState),
      redo: () => updateEntry(entry.id, { ...snapshot, ...patch, isEdited: true })
    })
    updateEntry(entry.id, { ...patch, isEdited: true })
  }

  // -----------------------------------------------------------------------
  // REQ-0335 §3 — style presets.
  //
  // Apply routes through `applyStyleEdit`, so it is ONE undoable operation on
  // the existing history mechanism (§3-5).  The patch never contains `words`
  // or `emphasisSpans` — they are classified `per-cue` in
  // `shared/style-preset.ts` — so a karaoke row keeps its per-word timings
  // and does not drop to even-split karaoke.
  // -----------------------------------------------------------------------
  const presetGeometry = {
    videoWidthPx: video?.widthPx,
    videoHeightPx: video?.heightPx,
  }
  function handleApplyPreset(preset: StylePreset) {
    applyStyleEdit(t('history.applyPreset'), resolveStylePresetPatch(preset, presetGeometry))
    toast.success(t('preset.applied', { name: preset.name }))
  }
  function handleSavePreset(name: string) {
    const preset = buildStylePreset(entry, name, presetGeometry)
    if (useSettingsStore.getState().addStylePreset(preset)) {
      toast.success(t('preset.saved', { name: preset.name }))
    }
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
  // REQ-0125 — colour picker onChange fires per-frame during S/V drag.
  // Route those into the history-less preview API so the drag stream
  // lights up the overlay without spamming Undo.  The single coarse-
  // grained history op fires from onCommit at popover close.
  function handleTextColorPreview(hex: string) {
    updateEntryPreview(entry.id, { textColorHex: hex })
  }
  function handleTextColorCommit(hex: string, hexOnOpen: string) {
    applyStyleEdit(
      t('history.editColor'),
      { textColorHex: hex },
      { textColorHex: hexOnOpen }
    )
  }
  function handleOutlineColorPreview(hex: string) {
    updateEntryPreview(entry.id, { outlineColorHex: hex })
  }
  function handleOutlineColorCommit(hex: string, hexOnOpen: string) {
    applyStyleEdit(
      t('history.editColor'),
      { outlineColorHex: hex },
      { outlineColorHex: hexOnOpen }
    )
  }
  // REQ-0310 §1 — opacity sliders.  Same preview/commit split the colour
  // pickers use: `onPreview` streams into the history-less store write so the
  // video overlay follows the thumb, and `onCommit` (fired once at the gesture
  // boundary) pushes ONE history op whose undo target is the pre-drag value.
  // Labelled with the existing colour-edit history string — from the user's
  // point of view this is still "changed the colour".
  const textAlphaBeforeRef = useRef<number | undefined>(undefined)
  function handleTextAlphaPreview(v: number) {
    if (textAlphaBeforeRef.current === undefined) textAlphaBeforeRef.current = clampOpacityPercent(entry.textAlpha)
    updateEntryPreview(entry.id, { textAlpha: v })
  }
  function handleTextAlphaCommit(v: number) {
    const before = textAlphaBeforeRef.current
    textAlphaBeforeRef.current = undefined
    applyStyleEdit(
      t('history.editColor'),
      { textAlpha: v },
      before === undefined ? undefined : { textAlpha: before },
    )
  }
  const outlineAlphaBeforeRef = useRef<number | undefined>(undefined)
  function handleOutlineAlphaPreview(v: number) {
    if (outlineAlphaBeforeRef.current === undefined) outlineAlphaBeforeRef.current = clampOpacityPercent(entry.outlineAlpha)
    updateEntryPreview(entry.id, { outlineAlpha: v })
  }
  function handleOutlineAlphaCommit(v: number) {
    const before = outlineAlphaBeforeRef.current
    outlineAlphaBeforeRef.current = undefined
    applyStyleEdit(
      t('history.editColor'),
      { outlineAlpha: v },
      before === undefined ? undefined : { outlineAlpha: before },
    )
  }

  function handleColorPairApply(text: string, outline: string) {
    // Pair clicks are a single deterministic action, not a drag, so
    // they push their history op directly through applyStyleEdit.
    // ColorPicker.handlePairClick suppresses the subsequent onCommit
    // fire so we never double-push (REQ-0125).
    applyStyleEdit(t('history.editColor'), {
      textColorHex: text,
      outlineColorHex: outline
    })
  }
  function handleOutlineThicknessCommit(v: number) {
    applyStyleEdit(t('history.editStroke'), { outlineThicknessPx: v })
  }
  function handleFontChange(next: FontId | undefined) {
    if (next === entry.fontId) return
    applyStyleEdit(t('history.editFont'), { fontId: next })
  }

  // REQ-0277 Phase A style-effect commit helpers.  Each accepts a
  // patch on the SubtitleEntry and pushes one history entry so Undo
  // restores the effect cleanly.  Neutral-default handling (undefined
  // → off) lives in the renderers; the store simply carries whatever
  // the user last set.
  function handleCasingToggle(on: boolean) {
    applyStyleEdit(t('history.editCasing'), { casing: on ? 'uppercase' : 'none' })
  }
  // REQ-0293 §1 — shadow ON/OFF is now encoded in the depth itself
  // (depth 0 = OFF, depth > 0 = ON).  The pre-REQ-0293 Switch and
  // `handleShadowToggle` handler were removed since they duplicated
  // the "depth is 0" state.  `handleShadowDepthCommit` still seeds
  // colour + alpha defaults on the first non-zero commit so a fresh
  // slider drag from 0 lands on a visible black shadow rather than
  // an invisible one.
  function handleShadowDepthCommit(depth: number) {
    const patch: Partial<SubtitleEntry> = { shadowDepth: depth }
    if (depth > 0 && entry.shadowColor === undefined) patch.shadowColor = '#000000'
    if (depth > 0 && entry.shadowAlpha === undefined) patch.shadowAlpha = 100
    applyStyleEdit(t('history.editShadow'), patch)
  }
  // REQ-0292 §1 — slider drag-preview: reflect the depth into the
  // renderer on every onChange frame so the drop-shadow grows/shrinks
  // in the video overlay live, matching the outline-thickness /
  // colour-picker preview pattern.  History op still fires once at
  // drag boundary via handleShadowDepthCommit.
  function handleShadowDepthPreview(depth: number) {
    updateEntryPreview(entry.id, { shadowDepth: depth })
  }
  // REQ-0278 — glow handlers removed (see SPECIFICATION.md §11).

  // REQ-0286 §5 — karaoke handlers.  Toggle-on seeds ONLY the highlight
  // colour (yellow accent) so the sweep is visible immediately; the
  // base (unspoken) colour is deliberately left `undefined` so
  // ass-generator / subtitle-overlay / preview rAF resolve it to
  // `entry.textColorHex` at render time (REQ-0290 §1).  Toggle-off
  // keeps the last colours in place so re-enabling restores them.
  function handleKaraokeToggle(on: boolean) {
    if (on) {
      applyStyleEdit(t('history.editKaraoke'), {
        karaokeEnabled: true,
        karaokeHighlightColor: entry.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR,
      })
    } else {
      applyStyleEdit(t('history.editKaraoke'), { karaokeEnabled: false })
    }
  }
  // REQ-0286 §5 — colour picker follows the shared textColor/outlineColor
  // pattern: `onChange` writes preview (per-drag frame) via
  // updateEntryPreview, `onCommit` pushes ONE history op at popover close
  // so a whole drag collapses to a single undo.  Same code shape as
  // handleTextColorCommit above.
  function handleKaraokeHighlightPreview(hex: string) {
    updateEntryPreview(entry.id, { karaokeHighlightColor: hex })
  }
  function handleKaraokeHighlightCommit(hex: string, hexOnOpen: string) {
    applyStyleEdit(
      t('history.editKaraoke'),
      { karaokeHighlightColor: hex },
      { karaokeHighlightColor: hexOnOpen },
    )
  }
  // REQ-0293 §2 — the base-colour handlers (`handleKaraokeBasePreview`
  // / `handleKaraokeBaseCommit`) were removed along with the base
  // colour picker.  The base half of the karaoke sweep now tracks
  // `textColorHex` directly at render time; there is no per-cue
  // override to store.  Users who want to change the base colour
  // change the cue's text colour instead.

  // REQ-0307 — keyword-emphasis handlers.  Emphasis is span-based (survives
  // edits, works without `words`, no duplicate-match ambiguity).  Toggle-on
  // seeds colour + size defaults; colour previews per-drag then commits one
  // history op; size commits directly.  The character selection itself is
  // owned by the picker dialog and lands as a single `emphasisSpans` write.
  function handleEmphasisToggle(on: boolean) {
    if (on) {
      applyStyleEdit(t('history.editEmphasis'), {
        keywordEmphasisEnabled: true,
        emphasisColorHex: entry.emphasisColorHex ?? EMPHASIS_DEFAULT_COLOR,
        emphasisScalePercent: entry.emphasisScalePercent ?? EMPHASIS_DEFAULT_SCALE_PERCENT,
      })
    } else {
      applyStyleEdit(t('history.editEmphasis'), { keywordEmphasisEnabled: false })
    }
  }
  function handleEmphasisColorPreview(hex: string) {
    updateEntryPreview(entry.id, { emphasisColorHex: hex })
  }
  function handleEmphasisColorCommit(hex: string, hexOnOpen: string) {
    applyStyleEdit(
      t('history.editEmphasis'),
      { emphasisColorHex: hex },
      { emphasisColorHex: hexOnOpen },
    )
  }
  function handleEmphasisSizeCommit(v: number) {
    applyStyleEdit(t('history.editEmphasis'), { emphasisScalePercent: clampEmphasisScalePercent(v) })
  }
  // REQ-0307 §2 — the picker seeds itself from the RESOLVED spans, so a legacy
  // keyword list / word-index list is migrated on open and a span that no
  // longer resolves simply doesn't come back pre-selected.  Applying writes
  // the explicit span list, which pins the migration.
  const emphasisResolvedSpans = resolveEmphasis(entry).spans
  function handleEmphasisSpansCommit(spans: EmphasisSpan[]) {
    applyStyleEdit(t('history.editEmphasis'), { emphasisSpans: spans })
  }

  function handleRotationCommit(deg: number) {
    // Normalise into [0, 360) so a runaway drag never accumulates
    // beyond the ASS `\frz` legible range.
    const normalized = ((deg % 360) + 360) % 360
    applyStyleEdit(t('history.editRotation'), { rotation: normalized })
  }

  // REQ-20260613-016 Phase 5 — per-row layout / background handlers
  // mirror subtitle-table.tsx so the inspector and the list view drive
  // identical history shapes for the new fields (機能A).
  //
  // REQ-20260615-037 — when a row already has a pinned position, the
  // user expects the offset *value* (visible in the X/Y inputs) to stay
  // put when they nudge horizontal / vertical / margin: the row should
  // shift with the anchor, not drift its offset.  Storage is still
  // absolute (posX/posY), so we recompute it from the new anchor and
  // merge the new posX/posY into the same patch — that keeps the layout
  // change and the pinned-pos shift in one undoable atom.
  function patchWithPreservedOffset(
    layoutPatch: Partial<Pick<SubtitleEntry,
      'horizontalPosition' | 'verticalPosition' | 'verticalMarginPx'>>,
  ): Partial<SubtitleEntry> {
    if (!video || !video.hasVideoStream) return layoutPatch
    const recomputed = recomputePinnedPosForAnchorChange({
      currentHorizontalPosition: entry.horizontalPosition,
      currentVerticalPosition: entry.verticalPosition,
      currentVerticalMarginPx: entry.verticalMarginPx,
      currentPosX: entry.posX,
      currentPosY: entry.posY,
      nextHorizontalPosition: layoutPatch.horizontalPosition,
      nextVerticalPosition: layoutPatch.verticalPosition,
      nextVerticalMarginPx: layoutPatch.verticalMarginPx,
      videoWidthPx: video.widthPx,
      videoHeightPx: video.heightPx,
    })
    if (!recomputed) return layoutPatch
    return { ...layoutPatch, posX: recomputed.posX, posY: recomputed.posY }
  }
  function handleHorizontalPositionChange(v: 'left' | 'center' | 'right') {
    if (v === entry.horizontalPosition) return
    applyStyleEdit(t('history.editLayout'),
      patchWithPreservedOffset({ horizontalPosition: v }))
  }
  function handleVerticalPositionChange(v: 'top' | 'center' | 'bottom') {
    if (v === entry.verticalPosition) return
    // REQ-0140 — do NOT reset verticalMarginPx when flipping to/from
    // `'center'`.  The margin value is preserved so switching center →
    // top/bottom restores the user's last margin (REQ §3.2 last
    // bullet).  The margin input is only visually disabled while the
    // row is centred; the underlying value survives.
    applyStyleEdit(t('history.editLayout'),
      patchWithPreservedOffset({ verticalPosition: v }))
  }
  // REQ-20260615-059 B — `handleVerticalMarginBlur` retired here.
  // Margin commits now flow through `NumberStepperInput`'s `onCommit`
  // (still wrapped with `patchWithPreservedOffset` to preserve the
  // REQ-20260615-037 pinned-row offset).

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
  /**
   * REQ-0127 Phase 2 — Enter on any of the inline numeric inputs
   * (font size / offsetX / offsetY) commits the typed value via the
   * existing onBlur path.  Blurring the input triggers the handler
   * with `e.target.value` still holding the typed string, matching
   * the click-away gesture and preserving the `key={entry.field}`
   * remount that snaps back an out-of-range typed value.
   */
  function handleNumericInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
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
  // REQ-20260615-059 B — `handleBackgroundOpacityBlur` retired.
  // Opacity commits now flow through `NumberStepperInput`'s `onCommit`
  // inline below.

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
  // REQ-0127 Phase 1 — capture the store's current text at focus time
  // so commitText can use it as the beforePatch for Undo.  We snapshot
  // `entry.text` (the store value) rather than `draft` because an
  // out-of-band external update (敷き詰め改行 etc.) can have moved
  // the store past the last render's draft, and we want Undo to
  // rewind to what the user was actually looking at.
  function handleTextFocus() {
    textFocusValueRef.current = entry.text
  }
  function handleDraftChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    dirtyRef.current = true
    const next = e.target.value
    setDraft(next)
    // REQ-0127 Phase 1 — stream every keystroke into the store via the
    // history-less preview writer.  Skip while an IME composition is
    // in progress; the composition-end handler flushes the final value.
    if (!isComposingRef.current) {
      updateEntryPreview(entry.id, { text: next.replace(/\n/g, '\\N') })
    }
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
    const next = (e.target as HTMLTextAreaElement).value
    setDraft(next)
    // REQ-0127 Phase 1 — flush the IME-committed value into preview.
    updateEntryPreview(entry.id, { text: next.replace(/\n/g, '\\N') })
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
  // REQ-0286 §0 / §5 — karaoke tier gate at the UI layer.  The inspector's
  // karaoke row hides entirely on free (NSIS) builds so a free-tier user
  // never sees the switch, cannot toggle it via keyboard focus, and
  // cannot store karaoke state to project files.  `useAppEnvStore.isMsix`
  // is `null` in the brief pre-IPC window; coerce to false so the more
  // restrictive path wins during that transient (matches every other
  // tier-gated UI in the codebase).
  const isMsix = useAppEnvStore((s) => s.isMsix) ?? false
  const showKaraokeUi = canUseKaraokeInTier(isMsix)
  // Words-valid check surfaces the "toggle is available but cue has no
  // per-word data" state so the row can render a subtle hint.  When
  // validity is false the switch still works (toggling ON stores the
  // flag; renderer + ass-generator fall through to plain rendering per
  // §0's Layer 2 defensive fallback) but the muted colour + hint
  // communicates why nothing visible happens.
  // REQ-0307 §3 — emphasis has NO `words` gate at all: the picker selects
  // characters straight out of the cue text, so it works on Japanese cues,
  // edited cues, and cues that never had per-word data.  Only the tier gate
  // remains (currently free for everyone — see `canUseKeywordEmphasisInTier`).
  const showEmphasisUi = canUseKeywordEmphasisInTier(isMsix)
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
            // REQ-0138 §1.3 — the delete/restore icon toggles labels
            // (Delete when live, Restore when deleted).  The DEL/BS
            // shortcut suffix is shown only on the Delete label because
            // REQ-0138 §1.1 made DEL/BS delete-only; showing a
            // shortcut hint next to "Restore" would be a lie.
            title={
              isTrimDeleted
                ? t('action.trimDeletedHint')
                : entry.isDeleted
                  ? t('action.restoreRow')
                  : t('action.deleteRow') + shortcutHint('delete')
            }
            aria-label={
              isTrimDeleted
                ? t('action.trimDeletedHint')
                : entry.isDeleted
                  ? t('action.restoreRow')
                  : t('action.deleteRow') + shortcutHint('delete')
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
            title={t('action.resetRow') + shortcutHint('reset')}
            aria-label={t('action.resetRow') + shortcutHint('reset')}
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
            title={t('action.duplicateRowHelp') + shortcutHint('duplicate')}
            aria-label={t('action.duplicateRowHelp') + shortcutHint('duplicate')}
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
          views).  REQ-20260615-018 A: the wrapper renders unconditionally
          with `min-h-5` so a freshly-edited row's "編集済み" badge
          appearing does not shift the rows below it.  Badge primitive
          itself is h-5 so the placeholder height matches the populated
          row.  REQ-20260615-036: the standalone position-pinned badge
          was retired — offset changes now surface through the generic
          "編集済み" badge (driven by isEditedFromOriginal, which already
          factors in posX/posY). */}
      <div className="flex flex-wrap gap-1 min-h-5">
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
        {/* REQ-0184 §4 — section header is now a click-to-collapse
            toggle.  Chevron + heading text, whole row clickable.
            Section content wraps into a conditional `hidden` div so
            the inputs' internal state (draft text, focus, IME
            composition guards) is preserved across collapses. */}
        <button
          type="button"
          onClick={() => setSubtitleSectionOpen((v) => !v)}
          aria-expanded={subtitleSectionOpen}
          className="flex items-center gap-1.5 text-callout font-semibold text-fg-secondary w-full text-left hover:text-fg-primary transition-colors duration-150 focus:outline-none focus-visible:outline-none"
        >
          {subtitleSectionOpen ? (
            <ChevronDown className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
          )}
          <span>{t('timeline.inspector.subtitleSection')}</span>
        </button>
        <div className={cn('space-y-2', !subtitleSectionOpen && 'hidden')}>
        <textarea
          ref={textareaRef}
          value={draft}
          onFocus={handleTextFocus}
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
            // REQ-0311 §2 — `resize-y` (vertical only) so the box can never be
            // dragged wider and push the inspector into horizontal overflow.
            // The min/max bounds are pinned imperatively below.
            'text-body text-fg-primary leading-snug resize-y',
            'focus:outline-none focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary/30',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        />
        {!isAudioOnly && (
          <>
            {/* REQ-0335 §3 — style presets.  Sits at the TOP of the style
                cluster because it is the coarsest control there: it writes
                every field below it in one undoable step, so reading the
                cluster top-down goes "whole look → individual fields". */}
            <StylePresetControls
              className="w-full justify-center"
              onSaveCurrent={isFrozen ? null : handleSavePreset}
              onApply={handleApplyPreset}
            />
            {/* REQ-0275 §5 — two-tier family + weight picker replaces
                the flat RowFontSelector at this site.  When the user
                picks a family it snaps to the family's default weight;
                onChange fires once so a single Undo restores both
                fields (§5 undo atomicity requirement).  When the
                picked FontId matches the project's active default,
                collapse to `undefined` so the row keeps "inherit"
                semantics (mirrors RowFontSelector's onChange handler).
                RowFontSelector remains available for the table's
                per-row column where compact single-dropdown fits
                the tight cell. */}
            <FamilyWeightSelector
              value={entry.fontId ?? activeFontId}
              onChange={(nextId) => handleFontChange(nextId === activeFontId ? undefined : nextId)}
              disabled={isFrozen}
              // REQ-0296 §3 — show "フォント" / "ウェイト" left labels so
              // the two font rows line up with size / colours / etc.
              showLabels
            />
            {/* Size — REQ-20260615-017: ±10 chevron stepper flanks the
                number input.  Direct typing still works (input keeps
                its onChange / onBlur), and both the buttons and the
                typed value clamp to [FONT_SIZE_MIN_PX,
                FONT_SIZE_MAX_PX].  REQ-0299 §4/§6 — wrapped in
                StyleRow so this row gets the shared hover backdrop +
                dashed filler like every other 字幕 row.  The custom
                chevron+input+chevron cluster is preserved verbatim
                inside StyleRow's control column (StyleRow doesn't
                impose a control shape, so the existing handlers/
                out-of-range styling still work). */}
            <StyleRow label={t('styleCell.size')}>
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
                  onKeyDown={handleNumericInputKeyDown}
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
            </StyleRow>
            {/* Text colour — REQ-0310 §1 adds the opacity slider beside the
                swatch.  One line: the 24px swatch + gap leaves ~146px of track
                inside the shared 224px control column (the outline-width row
                already runs a fullWidth slider in the same space), so nothing
                is clipped and no restack is needed.  `stopControlClickPropagation`
                is required now that the row contains a slider — a drag would
                otherwise bubble to the timeline block's click-to-select. */}
            <StyleRow label={t('styleCell.textColor')} stopControlClickPropagation>
              <div className="flex items-center gap-2">
                <ColorPicker
                  value={entry.textColorHex}
                  onChange={handleTextColorPreview}
                  onCommit={handleTextColorCommit}
                  onPairApply={handleColorPairApply}
                  disabled={isFrozen}
                  swatchOnly
                  heading={t('common:colorPicker.headingText')}
                />
                <OpacityPercentSlider
                  value={clampOpacityPercent(entry.textAlpha)}
                  onPreview={handleTextAlphaPreview}
                  onCommit={handleTextAlphaCommit}
                  disabled={isFrozen}
                  ariaLabel={t('styleCell.textOpacity')}
                  fullWidth
                />
              </div>
            </StyleRow>
            {/* Outline colour + opacity (REQ-0310 §1). */}
            <StyleRow label={t('styleCell.outlineColor')} stopControlClickPropagation>
              <div className="flex items-center gap-2">
                <ColorPicker
                  value={entry.outlineColorHex}
                  onChange={handleOutlineColorPreview}
                  onCommit={handleOutlineColorCommit}
                  onPairApply={handleColorPairApply}
                  disabled={isFrozen}
                  swatchOnly
                  heading={t('common:colorPicker.headingOutline')}
                />
                <OpacityPercentSlider
                  value={clampOpacityPercent(entry.outlineAlpha)}
                  onPreview={handleOutlineAlphaPreview}
                  onCommit={handleOutlineAlphaCommit}
                  disabled={isFrozen}
                  ariaLabel={t('styleCell.outlineOpacity')}
                  fullWidth
                />
              </div>
            </StyleRow>
            {/* Outline width — REQ-0300 §2: control column width now
                provided by StyleRow (INSPECTOR_CONTROL_COL_CLASS),
                so drop the inner `w-[65%]` wrapper.  Every row's
                control now starts at the same X. */}
            <StyleRow label={t('styleCell.outlineWidth')} stopControlClickPropagation>
              <OutlineThicknessSlider
                value={entry.outlineThicknessPx}
                onCommit={handleOutlineThicknessCommit}
                disabled={isFrozen}
                ariaLabel={t('styleCell.outlineWidth')}
                fullWidth
              />
            </StyleRow>
            {/* REQ-0292 §4 — style-effect row order (top → bottom):
                shadow, karaoke (+ colours), casing, rotation, fade.
                Fade sits at the very end so the primary style effects
                cluster together and the temporal knob is separated
                out.  Casing follows karaoke so ALL_CAPS applies AFTER
                the sweep-colour cluster in reading order.
                REQ-0292 §1 — shadow row now uses a slider (0–100)
                matching outline width / fade above; the previous
                NumberStepperInput capped at 20 which no longer aligns
                with the burn-in clamp (`SHADOW_DEPTH_MAX_PX`).
                REQ-0184 §4 — the fade row is the last child of the
                collapsible subtitle-section wrapper `<div>` opened
                right after the section-header button above; the
                wrapper closes just before the `</div>` that closes
                the outer `space-y-2 border-t` section. */}
            {/* REQ-0293 §1 — shadow row: single slider (0=OFF, >0=ON).
                Pre-REQ-0293 had a separate Switch that duplicated the
                "depth is 0" state; removing it lets the depth alone
                drive both the tag emission and the ON/OFF affordance. */}
            <StyleRow label={t('styleCell.shadow')} stopControlClickPropagation>
              <ShadowDepthSlider
                value={entry.shadowDepth ?? 0}
                onCommit={handleShadowDepthCommit}
                onPreview={handleShadowDepthPreview}
                disabled={isFrozen}
                ariaLabel={t('styleCell.shadowDepth')}
                fullWidth
              />
            </StyleRow>
            {/* REQ-0278 — glow row removed here (SPECIFICATION.md §11). */}
            {/* REQ-0286 §5 / REQ-0289 — karaoke row.  Hidden entirely
                on free tier (`showKaraokeUi = canUseKaraokeInTier
                (isMsix)`) so no karaoke state can be created or stored
                from a free build.  On paid tier: Switch + 2 colour
                pickers (highlight = spoken/past, base = unspoken/
                future).  When `karaokeWordsValid` is false the row
                still renders per-unit karaoke via the equal-split
                fallback (REQ-0289), and the label switches to
                `karaokeOnNoWords` to communicate that the timing is
                approximate rather than word-accurate. */}
            {/* REQ-0296 §2 — single karaoke row: label + Switch +
                highlight ColorPicker, all always visible so the row
                height doesn't jump when the toggle flips.  Picker
                works whether the toggle is on or off (colour is just
                stored; only used at render when karaoke is ON).  Tier
                gate hides the entire row on free tier. */}
            {/* REQ-0299 §3 — karaoke state text ("有効"/"無効") removed.
                Row is now `[label] [Switch] [ColorPicker]` — the
                Switch itself surfaces the toggle state.  The
                `karaokeWordsValid` distinction is no longer surfaced
                in copy either; equal-split fallback handles the
                invalid case silently. */}
            {/* REQ-0300 §1 — Switch + Picker are adjacent (no spacer).
                Both sit at the LEFT of StyleRow's fixed control
                column so the picker doesn't drift into a lonely
                right-edge position; layout is
                `[label] [dashed filler] [Switch][gap][Picker]`. */}
            {showKaraokeUi && (
              <StyleRow label={t('styleCell.karaokeRowLabel')} stopControlClickPropagation>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={entry.karaokeEnabled === true}
                    onCheckedChange={handleKaraokeToggle}
                    disabled={isFrozen}
                    aria-label={t('styleCell.karaoke')}
                  />
                  <ColorPicker
                    value={entry.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR}
                    onChange={handleKaraokeHighlightPreview}
                    onCommit={handleKaraokeHighlightCommit}
                    disabled={isFrozen}
                    swatchOnly
                    heading={t('styleCell.karaokeHighlightColor')}
                  />
                </div>
              </StyleRow>
            )}
            {/* REQ-0311 §4 / REQ-0315 §2 / REQ-0322 §3 — karaoke display style,
                now PER-CUE.  The row stays here (it is a property of this
                clip); the settings-tab copy of the same control is the
                default for cues that have not chosen one.  Shown only while
                the cue actually has karaoke on, so the row never offers a
                control that cannot affect it.  `karaokeStyleResolved` shows
                the inherited default rather than an empty Select — picking
                the value already displayed still writes it, which is correct:
                the user is pinning the cue to that style. */}
            {showKaraokeUi && entry.karaokeEnabled === true && (
              <StyleRow label={t('styleCell.karaokeStyleRowLabel')} stopControlClickPropagation>
                <Select
                  value={karaokeStyleResolved}
                  onValueChange={(v) =>
                    applyStyleEdit(t('history.editKaraoke'), {
                      karaokeStyle: coerceKaraokeStyle(v),
                    })
                  }
                  disabled={isFrozen}
                >
                  <SelectTrigger className="h-8 w-full" aria-label={t('styleCell.karaokeStyleRowLabel')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="switch">{t('styleCell.karaokeStyleSwitch')}</SelectItem>
                    <SelectItem value="sweep">{t('styleCell.karaokeStyleSweep')}</SelectItem>
                  </SelectContent>
                </Select>
              </StyleRow>
            )}
            {/* REQ-0307 §1 — keyword emphasis row: master Switch + 「編集」
                (opens the per-character picker) + colour + size %.  The Edit
                button is disabled while the toggle is OFF, so the row reads
                as "turn it on, then choose what to emphasise".  Emphasis is
                span-based, so it works on ANY cue (Japanese, edited, no
                `words`) and hits only the occurrence the user picked — the
                REQ-0306 keyword chips are gone because a repeated keyword
                could not be disambiguated. */}
            {showEmphasisUi && (
              /* REQ-0308 §4-2 — this row carries FOUR controls (switch, Edit,
                 colour, stepper ≈ 252 px) but shares the 224 px control column
                 every other row uses, and the inspector pane is
                 `overflow-x-hidden`, so the stepper's right chevron was clipped
                 off.  Widening the shared column would move every other row, so
                 the fix is local: stack this row's controls in TWO lines inside
                 the same column.  StyleRow's label/filler/control structure is
                 untouched, so row alignment is unaffected. */
              <StyleRow label={t('styleCell.emphasisRowLabel')} stopControlClickPropagation>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={entry.keywordEmphasisEnabled === true}
                      onCheckedChange={handleEmphasisToggle}
                      disabled={isFrozen}
                      aria-label={t('styleCell.emphasis')}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isFrozen || entry.keywordEmphasisEnabled !== true}
                      onClick={() => setEmphasisPickerOpen(true)}
                      aria-label={t('styleCell.emphasisEdit')}
                    >
                      <Pencil className="h-3 w-3" />
                      {t('styleCell.emphasisEdit')}
                    </Button>
                    <ColorPicker
                      value={entry.emphasisColorHex ?? EMPHASIS_DEFAULT_COLOR}
                      onChange={handleEmphasisColorPreview}
                      onCommit={handleEmphasisColorCommit}
                      disabled={isFrozen}
                      swatchOnly
                      heading={t('styleCell.emphasisColor')}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <NumberStepperInput
                      value={entry.emphasisScalePercent ?? EMPHASIS_DEFAULT_SCALE_PERCENT}
                      min={EMPHASIS_SCALE_MIN_PERCENT}
                      max={EMPHASIS_SCALE_MAX_PERCENT}
                      step={EMPHASIS_SCALE_STEP_PERCENT}
                      onCommit={handleEmphasisSizeCommit}
                      disabled={isFrozen}
                      ariaLabel={t('styleCell.emphasisSize')}
                      widthClass="w-16"
                    />
                    {/* REQ-0308 §4-3 — the number is a MULTIPLIER of the cue's
                        font size (200 = 2×), not an absolute px size.  Without
                        the unit it reads as a point size. */}
                    <span className="text-caption text-fg-secondary">%</span>
                  </div>
                </div>
              </StyleRow>
            )}
            {/* Casing — REQ-0292 §4 moved BELOW karaoke.  REQ-0299 §3
                — state text ("ALL CAPS"/"なし") removed; the Switch
                itself surfaces the toggle state. */}
            <StyleRow label={t('styleCell.casing')} stopControlClickPropagation>
              <Switch
                checked={entry.casing === 'uppercase'}
                onCheckedChange={handleCasingToggle}
                disabled={isFrozen}
                aria-label={t('styleCell.casing')}
              />
            </StyleRow>
            <StyleRow label={t('styleCell.rotation')} stopControlClickPropagation>
              <NumberStepperInput
                value={entry.rotation ?? 0}
                min={0}
                max={359}
                step={15}
                onCommit={handleRotationCommit}
                disabled={isFrozen}
                ariaLabel={t('styleCell.rotation')}
              />
            </StyleRow>
            {/* REQ-0324 §1 — the standalone Fade row is GONE.  Fade is now
                one choice inside the animation section below; keeping a
                second control writing `fadeDurationSec` would have given
                the user two knobs for one effect that silently disagree.
                Existing cues keep their fade via `resolveAnimation`'s
                migration, which reads the stored `fadeDurationSec`. */}
          </>
        )}
        </div>{/* REQ-0184 §4 — close subtitle-section collapse wrapper */}
      </div>

      {/* § 5 — レイアウト section (REQ-20260614-001 補遺⑪).
          水平 / 垂直 / マージン。audio-only 非表示。 */}
      {!isAudioOnly && (
        <div className="space-y-2 border-t border-line pt-2">
          {/* REQ-0184 §4 — collapse toggle (default open) */}
          <button
            type="button"
            onClick={() => setLayoutSectionOpen((v) => !v)}
            aria-expanded={layoutSectionOpen}
            className="flex items-center gap-1.5 text-callout font-semibold text-fg-secondary w-full text-left hover:text-fg-primary transition-colors duration-150 focus:outline-none focus-visible:outline-none"
          >
            {layoutSectionOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
            )}
            <span>{t('timeline.inspector.layoutSection')}</span>
          </button>
          <div className={cn('space-y-2', !layoutSectionOpen && 'hidden')}>
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
            <SegmentGroup<'top' | 'center' | 'bottom'>
              value={entry.verticalPosition}
              onChange={handleVerticalPositionChange}
              disabled={isFrozen}
              ariaLabel={t('subtitlePosition.vertical')}
              options={[
                { value: 'top', label: t('subtitlePosition.top') },
                { value: 'center', label: t('subtitlePosition.center') },
                { value: 'bottom', label: t('subtitlePosition.bottom') },
              ]}
            />
          </div>
          {/* REQ-0140 — when the row is center-aligned the margin has no
              effect (libass `\an4/5/6` ignores MarginV; §3.2).  Keep
              the input in the layout (§3.2 "隠さず disabled") and
              surface the reason via a title tooltip.  The stored
              verticalMarginPx value is preserved across the flip so
              switching back to top/bottom restores the user's last
              margin. */}
          <div
            className="flex items-center justify-between gap-2"
            title={
              entry.verticalPosition === 'center'
                ? t('subtitlePosition.marginDisabledCenter')
                : undefined
            }
          >
            <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.marginV')}</label>
            {/* REQ-20260615-059 B — margin gets the ±10 chevron stepper
                the size row already uses, so the same wrist-flick keeps
                margin in step with size adjustments.  REQ-0269 A raised
                the ceiling from 300 to 9999 (`MARGIN_V_MAX_PX`) so
                extreme off-frame offsets are reachable; input widens to
                `w-16` to fit 4 digits. */}
            <NumberStepperInput
              value={entry.verticalMarginPx}
              min={MARGIN_V_MIN_PX}
              max={MARGIN_V_MAX_PX}
              step={10}
              widthClass="w-16"
              onCommit={(next) => {
                if (next === entry.verticalMarginPx) return
                // REQ-20260615-037 — preserve the offset across the
                // anchor change so pinned rows keep their visual
                // offset.  Mirrors what the legacy
                // `handleVerticalMarginBlur` used to do (now retired
                // in favour of NumberStepperInput's onCommit).
                applyStyleEdit(t('history.editMargin'),
                  patchWithPreservedOffset({ verticalMarginPx: next }))
              }}
              disabled={isFrozen || entry.verticalPosition === 'center'}
              ariaLabel={t('subtitlePosition.margin')}
            />
          </div>
          {/* REQ-0332 §5 — 行間 (line spacing).  Percentage of the font size;
              0 % is the historical pitch, negative tightens (the owner's
              motivation: Latin fonts sit too far apart).  Only has a visible
              effect on a multi-line cue, and the row is deliberately NOT
              hidden for single-line cues — the value is a property of the row
              that survives the text becoming two lines, exactly like the
              margin above. */}
          <div className="flex items-center justify-between gap-2" title={t('styleCell.lineSpacingHint')}>
            <label className="text-callout font-semibold text-fg-secondary">{t('styleCell.lineSpacing')}</label>
            <LineSpacingSlider
              value={resolveLineSpacingPercent(entry)}
              onCommit={(next) => {
                if (next === resolveLineSpacingPercent(entry)) return
                applyStyleEdit(t('history.editLineSpacing'), { lineSpacingPercent: next })
              }}
              disabled={isFrozen}
              ariaLabel={t('styleCell.lineSpacing')}
            />
          </div>
          {/* REQ-20260615-033 — オフセット行.  Displays `posX-anchor.x` /
              `posY-anchor.y`; entering values writes back
              posX=anchor.x+offset, posY=anchor.y+offset.  X=Y=0 unpins
              (clears posX/posY).  Reset button = explicit unpin.  Hidden
              when video has no video stream (audio-only) or is still
              loading.

              REQ-20260615-038 A: the `?` help icon next to the
              "オフセット" label has been retired.  The same information
              now lives in the preview's position-guide overlay (drag
              affordance + distance rulers), which is more discoverable
              than a hover-only tooltip. */}
          {showOffsetRow && (
            <div className="flex items-center justify-between gap-2">
              <label className="text-callout font-semibold text-fg-secondary shrink-0">
                {t('styleCell.offset')}
              </label>
              <div className="flex items-center gap-1">
                <span className="text-caption text-fg-tertiary">X</span>
                <input
                  type="number"
                  defaultValue={offsetX}
                  key={`offsetX-${entry.id}-${offsetX}`}
                  onBlur={handleOffsetXBlur}
                  onKeyDown={handleNumericInputKeyDown}
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
                  onKeyDown={handleNumericInputKeyDown}
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
          </div>{/* REQ-0184 §4 — close layout-section collapse wrapper */}
        </div>
      )}

      {/* § 5.5 — animation section (REQ-0324 §1).  Its OWN section rather
          than a row inside the subtitle one, per owner instruction: the
          order is subtitle / layout / animation / background.  audio-only
          hides it for the same reason layout does — there is nothing
          rendered to animate. */}
      {!isAudioOnly && (
        <div className="space-y-2 border-t border-line pt-2">
          <button
            type="button"
            onClick={() => setAnimationSectionOpen((v) => !v)}
            aria-expanded={animationSectionOpen}
            className="flex items-center gap-1.5 text-callout font-semibold text-fg-secondary w-full text-left hover:text-fg-primary transition-colors duration-150 focus:outline-none focus-visible:outline-none"
          >
            {animationSectionOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
            )}
            <span>{t('timeline.inspector.animationSection')}</span>
          </button>
          <div className={cn('space-y-2', !animationSectionOpen && 'hidden')}>
            <AnimationControls
              value={{
                type: animSpec.type,
                inEnabled: animSpec.inEnabled,
                outEnabled: animSpec.outEnabled,
                durationSec: animSpec.durationSec,
                startScalePercent: Math.round(animSpec.startScale * 100),
                blurPx: animSpec.blurMaxPx,
              }}
              onChange={handleAnimationChange}
              disabled={isFrozen}
              includeBlur={ANIMATION_BLUR_ENABLED}
            />
          </div>
        </div>
      )}

      {/* § 6 — 背景色 section (REQ-20260614-001 補遺⑪).
          背景 ON/OFF / 背景色 / 透過率。セクション名「背景色」と
          フィールド名「背景色」が重なるが、REQ 補遺⑪ で明示的に
          確認済 (指定どおり「背景色」で実装)。audio-only 非表示。 */}
      {!isAudioOnly && (
        <div className="space-y-2 border-t border-line pt-2">
          {/* REQ-0096 — section heading carries a HelpIcon explaining that
              enabling the background disables the outline color.  This is
              libass-spec behavior (BorderStyle=3 paints the box from
              OutlineColour, so the outline can't render separately).
              REQ-0184 §4 — heading is now a collapse toggle (default
              CLOSED per owner spec).  HelpIcon stays but moves inside
              the button so hovering the icon does not toggle collapse
              — the icon has its own stopPropagation on its click.  */}
          <button
            type="button"
            onClick={() => setBackgroundSectionOpen((v) => !v)}
            aria-expanded={backgroundSectionOpen}
            className="flex items-center gap-1.5 text-callout font-semibold text-fg-secondary w-full text-left hover:text-fg-primary transition-colors duration-150 focus:outline-none focus-visible:outline-none"
          >
            {backgroundSectionOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-fg-tertiary" aria-hidden="true" />
            )}
            <span>{t('timeline.inspector.backgroundSection')}</span>
            <span onClick={(e) => e.stopPropagation()}>
              <HelpIcon content={t('timeline.inspector.backgroundSectionHelp')} />
            </span>
          </button>
          <div className={cn('space-y-2', !backgroundSectionOpen && 'hidden')}>
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
            {/* REQ-20260615-059 B — bg opacity gets the same ±10
                stepper as size / margin so the inspector's three
                numeric rows share one input shape.  Range stays
                [0, 100] %. */}
            <NumberStepperInput
              value={entry.subtitleBackground.opacityPercent}
              min={0}
              max={100}
              step={10}
              onCommit={(next) => {
                if (next === entry.subtitleBackground.opacityPercent) return
                applyStyleEdit(t('history.editBackground'), {
                  subtitleBackground: { ...entry.subtitleBackground, opacityPercent: next },
                })
              }}
              disabled={isFrozen || !entry.subtitleBackground.enabled}
              ariaLabel={t('styleCell.bgOpacity')}
            />
          </div>
          </div>{/* REQ-0184 §4 — close background-section collapse wrapper */}
        </div>
      )}

      {/* REQ-0307 §1 — per-character emphasis picker.  Mounted at the
          inspector root (not inside the collapsible 「字幕」 section) so
          collapsing that section while the dialog is open can't unmount it
          mid-edit.  Rendering is gated on `open` inside the component. */}
      {showEmphasisUi && (
        <EmphasisPickerDialog
          open={emphasisPickerOpen}
          onOpenChange={setEmphasisPickerOpen}
          text={entry.text}
          spans={emphasisResolvedSpans}
          colorHex={entry.emphasisColorHex ?? EMPHASIS_DEFAULT_COLOR}
          scalePercent={entry.emphasisScalePercent ?? EMPHASIS_DEFAULT_SCALE_PERCENT}
          onCommit={handleEmphasisSpansCommit}
        />
      )}
    </div>
  )
}
