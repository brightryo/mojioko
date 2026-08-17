import { HelpCircle } from 'lucide-react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/**
 * REQ-0521 §1-3 — the "how to use" popover, shared by the STEP 2 timeline
 * toolbar and the subtitle-list header.
 *
 * Extracted from `timeline-view.tsx` rather than copied: the owner's constraint
 * was "the same one as the timeline, only the contents differ", and a second
 * popover implementation would be a second place for the trigger styling, the
 * grid, the collision handling and the scroll fallback to drift apart. Callers
 * pass already-localised strings, so this file holds no copy of its own and no
 * `useTranslation` — the two call sites own their own i18n keys.
 *
 * The visual contract carried over verbatim from REQ-0122 / 0127 / 0128 / 0520:
 *   - trigger: 1-px outlined button with the localised label beside the icon, so
 *     it reads as "the guide to this whole pane" rather than an inline `?`
 *     (REQ-20260615-058). Neutral grey, so the inline help icons elsewhere in
 *     the app stay visually consistent.
 *   - panel: 720px, 2-column grid. 720 is a ceiling set by the narrow window —
 *     at 1280px the panel opens sideways and a wider one runs off screen
 *     (measured in REQ-0520 §3-2: 47px of margin left at 720px in English).
 *   - `max-h` + `overflow-y-auto` as belt-and-braces for unusually long copy.
 *   - `items-start` so a short section does not stretch to its row's height.
 */

export interface HelpSection {
  /** Already localised. */
  title: string
  /** Already localised. */
  body: string
  /**
   * `'caution'` gets the amber treatment REQ-0520 gave the timeline's
   * "what MOJIOKO cannot do" cell — reserved for the section stating hard
   * limitations, so the grid is not tonally flat but also not a rainbow.
   */
  tone?: 'default' | 'caution'
}

interface HelpPopoverProps {
  /** Trigger label, `aria-label` and `title` — all the same string. */
  label: string
  /** Heading inside the panel. */
  title: string
  sections: readonly HelpSection[]
  /**
   * Which way the panel opens. Both current call sites sit at the RIGHT edge of
   * the bottom-left pane, so `left` is the side with room; `avoidCollisions`
   * stays on as the fallback. REQ-0128 rejected opening downward because long
   * English copy clipped against the viewport floor.
   */
  side?: 'left' | 'right' | 'top' | 'bottom'
  align?: 'start' | 'center' | 'end'
  /** Extra classes for the trigger (e.g. `ml-auto` to right-align it). */
  triggerClassName?: string
}

export function HelpPopover({
  label,
  title,
  sections,
  side = 'left',
  align = 'start',
  triggerClassName,
}: HelpPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={label}
          aria-label={label}
          className={cn(
            'inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-line bg-surface-0 px-2 text-caption text-fg-tertiary',
            'hover:bg-surface-2 hover:text-fg-primary hover:border-line-strong transition-colors duration-150',
            triggerClassName,
          )}
        >
          <HelpCircle className="h-3.5 w-3.5" />
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        sideOffset={8}
        avoidCollisions
        collisionPadding={12}
        className="w-[720px] p-4 space-y-3 text-fg-primary max-h-[calc(100vh-40px)] overflow-y-auto"
      >
        <div className="text-body font-semibold text-fg-primary">{title}</div>
        <ul className="grid grid-cols-2 items-start gap-x-6 gap-y-4 text-body-sm leading-relaxed">
          {sections.map((s) => (
            <li key={s.title}>
              <div
                className={cn(
                  'font-semibold',
                  s.tone === 'caution' ? 'text-warning-faint' : 'text-fg-secondary',
                )}
              >
                {s.title}
              </div>
              <div className={s.tone === 'caution' ? 'text-fg-secondary' : 'text-fg-tertiary'}>
                {s.body}
              </div>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
