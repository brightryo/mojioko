import { HelpCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * REQ-0298 §4-2 — single knob to enable/disable the "label ・・・・・ value"
 * dashed filler across every StyleRow (inspector, bulk-edit, settings
 * default-style).  This is an owner-facing experiment: if the filler
 * proves distracting in the inspector / bulk-edit, flip this to
 * `false` in a single commit to revert all three surfaces at once.
 * The row layout (label left / control right, no filler) reverts to
 * a `justify-between` visual identical to the pre-REQ-0298 inspector
 * shape.
 */
export const SHOW_DASHED_FILLER = true

export type StyleRowLabelClass = 'inspector' | 'settings'

/**
 * REQ-0300 §2 / REQ-0301 §1 — default label + control column widths
 * used by inspector and bulk-edit callers.  Both columns are fixed
 * width so every row's control lines up on the SAME vertical (the
 * REQ-0300 alignment requirement).  Control column is
 * shrink-permitted with a `min-w` floor (REQ-0301 §1 — pre-REQ-0301
 * `shrink-0` made the column always overflow at startup pane
 * ~369px because "カラオケ（発話色）" label is ~145px wide, blowing
 * past the ~100 px I budgeted for in RES-0300 §2).
 *
 * ## Budget (right pane 368 px minimum, step2.tsx:OUTER_RIGHT_MIN_PX)
 *
 *   pane   368
 *   -p-3     - 24  (inspector scroll wrapper `p-3`)
 *   -mx-2    + 16  (StyleRow extends into padding via negative margin)
 *   ------------
 *   row    360
 *   label     128 (fixed, `w-32`; long labels truncate)
 *   gap × 2  16
 *   filler   flex-1 (min 16)
 *   control  w-56 basis 224, min 150, shrinks to fit
 *
 * Wide pane (say 500 row): label 128 + gaps 16 + filler 132 +
 * control 224 = 500.  Control at 224 — the "good" wide look owner
 * approved in REQ-0299.
 *
 * Startup pane (row ~361): label 128 + gaps 16 + filler 16 (min) +
 * control ≤ 201.  Control shrinks from basis 224 to 201; still
 * comfortably above min 150.  All rows shrink by the same amount
 * (same label + same basis + same shrink) → alignment holds.
 *
 * Extreme narrow (row 320): label 128 + gaps 16 + filler 16 + control
 * ≤ 160.  Control shrinks to 160 (above min 150).  Alignment holds.
 *
 * Below row ~310: control hits min-w 150, row can no longer shrink
 * and overflows visibly.  The `overflow-x-hidden` on the inspector
 * scroll wrapper (added by REQ-0301 §3) hides the overflow so no
 * horizontal scrollbar appears; the last few pixels of the control
 * fall outside the visible pane.  Rare in practice because pane
 * minimum is 368 px.
 *
 * Settings' DefaultStyleControls uses `CONTROL_COL_CLASS` (`w-72`
 * = 288 px) + intrinsic labels via the `labelColClass` /
 * `controlColClass` props — dialog is 640 px wide so the fixed
 * larger column and natural labels always fit.
 */
export const INSPECTOR_LABEL_COL_CLASS = 'w-32 shrink-0 min-w-0'
export const INSPECTOR_CONTROL_COL_CLASS = 'w-56 min-w-[150px]'

/**
 * REQ-0296 §1 / REQ-0298 §2 — the settings 「字幕スタイル」 tab's columns.
 * Intrinsic-width labels (the 640-px dialog has room, so no fixed label
 * column and no truncation) and a 288-px control column: the X/Y offset
 * row needs ~280 px of intrinsic content, and at the inspector's 192-px
 * predecessor it overflowed, surfacing a horizontal scrollbar across the
 * whole tab.
 */
export const SETTINGS_LABEL_COL_CLASS = 'shrink-0'
export const SETTINGS_CONTROL_COL_CLASS = 'w-72 shrink-0'

/**
 * REQ-0333 §3 — the three surfaces `StyleRow` serves, and the ONE place
 * that maps a surface to its column widths.
 *
 * `AnimationControls` is rendered by all three surfaces and used to hard-
 * code nothing at all, so its four rows silently took the inspector
 * defaults even inside the settings dialog — where every neighbouring row
 * went through `SettingsStyleRow`'s 288-px column.  The animation rows
 * therefore sat on a different vertical from the rows directly above and
 * below them.
 *
 * The lesson this codebase has re-learnt several times is that alignment
 * is not "pick matching numbers at each call site", it is "every row runs
 * the SAME width calculation".  Any component that renders `StyleRow`s on
 * behalf of a caller takes a `StyleRowSurface` and spreads the result of
 * this function, rather than accepting (or defaulting) the individual
 * class props.
 */
export type StyleRowSurface = 'inspector' | 'settings'

export interface StyleRowColumns {
  labelVariant: StyleRowLabelClass
  labelColClass: string
  controlColClass: string
}

export function styleRowColumns(surface: StyleRowSurface): StyleRowColumns {
  return surface === 'settings'
    ? {
        labelVariant: 'settings',
        labelColClass: SETTINGS_LABEL_COL_CLASS,
        controlColClass: SETTINGS_CONTROL_COL_CLASS,
      }
    : {
        labelVariant: 'inspector',
        labelColClass: INSPECTOR_LABEL_COL_CLASS,
        controlColClass: INSPECTOR_CONTROL_COL_CLASS,
      }
}

interface StyleRowProps {
  /**
   * Left-column label.  Accepts a `ReactNode` (not just a string) so
   * callers with existing bespoke `<label>` elements (e.g. inspector
   * rows that used a `<label ...>` for form association) can pass
   * theirs in without losing markup semantics.  When a plain string
   * is passed the row wraps it in a `<span>` styled per
   * `labelVariant`.
   */
  label: React.ReactNode
  /**
   * Optional help tooltip.  Renders a `?` icon after the label; the
   * tooltip content shows on hover.  Only supported when `label` is
   * a plain string (the tooltip trigger sits next to the label
   * `<span>` — omit the string requirement and callers can pass
   * their own tooltip inside the label ReactNode).
   */
  help?: string
  /**
   * `'inspector'` — the pre-REQ-0298 inspector label look
   * (`text-callout font-semibold text-fg-secondary`).  Used in the
   * inspector + bulk-edit + settings default-style so all three
   * surfaces read as siblings.  `'settings'` — the pre-REQ-0296
   * `text-body text-muted-foreground` look; kept as an escape hatch
   * in case the inspector look ever needs to differ in a specific
   * surface.  Default: `'inspector'`.
   */
  labelVariant?: StyleRowLabelClass
  /**
   * Optional stop-propagation click handler on the control column.
   * Inspector rows historically applied
   * `onClick={(e) => e.stopPropagation()}` to prevent clicks inside
   * the control from bubbling to the timeline block's selection
   * handler.  Callers pass `true` to opt in; default `false` keeps
   * events bubbling (safe for non-inspector callers).
   */
  stopControlClickPropagation?: boolean
  /**
   * REQ-0300 §2 / REQ-0301 §1 — width class for the control column
   * wrapper.  A single value across every row means every control
   * lines up on the same vertical.  Defaults to
   * `INSPECTOR_CONTROL_COL_CLASS` (= `w-56 min-w-[150px]` / 224 px
   * basis, shrinks to 150 px min).  Settings' DefaultStyleControls
   * overrides this with `w-72` (288 px + `shrink-0`) because the
   * settings dialog is 640 px wide.
   */
  controlColClass?: string
  /**
   * REQ-0301 §1/§2 — width class for the LEFT label column.  Defaults
   * to `INSPECTOR_LABEL_COL_CLASS` (= `w-32 shrink-0 min-w-0` /
   * 128 px).  A fixed label column is what makes control alignment
   * work at every pane width: if labels have different intrinsic
   * widths (short "影" vs long "カラオケ（発話色）"), the flex-1
   * filler absorbs the difference and the control's LEFT edge
   * stays put at any width IF (and only if) the control column is
   * itself a hard fixed width.  When the control column shrinks to
   * fit a narrow pane, each row must shrink IDENTICALLY, which
   * requires the label column also be identical width (else long
   * labels would eat more space, pushing the control further left
   * on those rows only, breaking alignment).
   *
   * Long labels (currently only "カラオケ（発話色）" ≈ 145 px) are
   * truncated by the label span's `truncate` class; a `title`
   * attribute on the span holds the full text so users can see
   * what was cut off on hover.
   *
   * Settings' DefaultStyleControls passes `labelColClass="shrink-0"`
   * (intrinsic width) to keep the pre-REQ-0301 look — no fixed
   * label column, no truncation, because the settings dialog is
   * 640 px wide and doesn't need the shrinkage machinery.
   */
  labelColClass?: string
  /**
   * REQ-0341 §2 — `title` on the ROW, for rows whose whole point needs
   * explaining rather than whose label does (「マージン」 when the anchor is
   * centred and the value has no effect; 「行間」's hint).  The raw
   * `justify-between` rows these replaced carried it on their wrapper div, and
   * the alternative — passing a `ReactNode` label just to hang a title on it —
   * opts the row out of `labelColClass` and breaks the alignment this shell
   * exists to provide.
   */
  title?: string
  /**
   * REQ-0341 §2 — extra classes for the row wrapper.  Exists for the
   * background section's dimming (`opacity-40 pointer-events-none` while the
   * box is off), which has to cover the label as well as the control.
   */
  className?: string
  children: React.ReactNode
}

/**
 * REQ-0296 §1 / REQ-0298 §4 — shared `[label | (dashed filler) | control]`
 * row shell used by the settings 「字幕スタイル」 tab, the inspector's
 * 「字幕」 section, and the bulk-edit bar's 「字幕」 section.  Cloned
 * from `AdvancedParamRow` in `whisper-advanced-controls.tsx` (the
 * Whisper タブ shape the owner cited as canonical) so all four
 * settings-ish surfaces share the same visual rhythm.
 *
 * The `SHOW_DASHED_FILLER` module constant gates the dashed filler
 * across every use site — flip to `false` in this file to revert
 * every surface to a `justify-between` layout (no filler decoration)
 * in one commit.  This is deliberate per REQ-0298 §4-2 ("戻しやすい
 * 実装").
 *
 * Structure:
 *   • Left  — `label` (string or ReactNode), optional `?` help icon
 *   • Middle— dashed filler (`flex-1 border-t border-dashed …`) when
 *             `SHOW_DASHED_FILLER` is true; when false the row uses
 *             `justify-between` and the filler is omitted
 *   • Right — `children` (the control).  A `stopControlClickPropagation`
 *             prop wraps the control in a click-stopper for inspector
 *             use.
 *
 * Notes:
 *   • The row's hover backdrop (`rounded-md px-2 py-1.5 -mx-2
 *     hover:bg-accent/40`) is inherited from the Whisper shape and
 *     applied unconditionally — inspector / bulk-edit rows now share
 *     the same hover affordance the settings tab already had.
 *   • No `justify-between` when filler is on (filler + `flex-1`
 *     handles spacing); `justify-between` when filler is off (the
 *     pre-REQ-0298 inspector look).
 */
export function StyleRow({
  label,
  help,
  labelVariant = 'inspector',
  stopControlClickPropagation,
  controlColClass = INSPECTOR_CONTROL_COL_CLASS,
  labelColClass = INSPECTOR_LABEL_COL_CLASS,
  title,
  className,
  children,
}: StyleRowProps) {
  // REQ-0301 §2 — the label span gets `truncate` so a label wider
  // than `labelColClass` (typically only "カラオケ（発話色）" at
  // 145 px against the 128 px fixed column) shows an ellipsis
  // instead of blowing past the column and pushing the control
  // right.  When `label` is a plain string we also set it as a
  // `title` on the wrapper so hover reveals the full text.
  const labelClass = cn(
    'truncate',
    labelVariant === 'inspector'
      ? 'text-callout font-semibold text-fg-secondary'
      : 'text-body text-muted-foreground',
  )
  const rowClass = cn(
    'flex items-center gap-2 rounded-md px-2 py-1.5 -mx-2 hover:bg-accent/40 transition-colors duration-150',
    !SHOW_DASHED_FILLER && 'justify-between',
    className,
  )
  const labelTitle = typeof label === 'string' ? label : undefined
  const labelBlock = typeof label === 'string' ? (
    <div
      className={cn('flex items-center gap-1.5', labelColClass)}
      title={labelTitle}
    >
      <span className={labelClass}>{label}</span>
      {help !== undefined && (
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-150">
              <HelpCircle className="h-3.5 w-3.5" />
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[280px] text-left">
            {help}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  ) : (
    <div className={labelColClass}>{label}</div>
  )
  const controlProps = stopControlClickPropagation
    ? { onClick: (e: React.MouseEvent) => e.stopPropagation() }
    : {}
  return (
    <div className={rowClass} title={title}>
      {labelBlock}
      {SHOW_DASHED_FILLER && (
        <div className="flex-1 border-t border-dashed border-border min-w-[16px]" />
      )}
      <div className={controlColClass} {...controlProps}>{children}</div>
    </div>
  )
}
