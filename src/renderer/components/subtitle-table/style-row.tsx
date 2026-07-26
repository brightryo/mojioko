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
  children,
}: StyleRowProps) {
  const labelClass = labelVariant === 'inspector'
    ? 'text-callout font-semibold text-fg-secondary whitespace-nowrap'
    : 'text-body text-muted-foreground'
  const rowClass = cn(
    'flex items-center gap-2 rounded-md px-2 py-1.5 -mx-2 hover:bg-accent/40 transition-colors duration-150',
    !SHOW_DASHED_FILLER && 'justify-between',
  )
  const labelBlock = typeof label === 'string' ? (
    <div className="flex items-center gap-1.5 shrink-0">
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
    <div className="shrink-0">{label}</div>
  )
  const controlProps = stopControlClickPropagation
    ? { onClick: (e: React.MouseEvent) => e.stopPropagation() }
    : {}
  return (
    <div className={rowClass}>
      {labelBlock}
      {SHOW_DASHED_FILLER && (
        <div className="flex-1 border-t border-dashed border-border min-w-[16px]" />
      )}
      <div {...controlProps}>{children}</div>
    </div>
  )
}
