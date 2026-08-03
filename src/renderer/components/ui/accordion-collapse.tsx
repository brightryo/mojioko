import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * REQ-0406 §2 — shared smooth expand/collapse for the STEP 1 accordions
 * (Whisper model / processing device / translation tool / input file) so every
 * section opens and closes the same way.
 *
 * Pure CSS: a single-row grid whose `grid-template-rows` transitions between
 * `0fr` (collapsed) and `1fr` (expanded), with the content in an
 * `overflow-hidden` child.  No JS height measurement (the "heavy" approach the
 * REQ calls out) — the height animates itself even though it is `auto`.
 * `prefers-reduced-motion: reduce` removes the transition (`motion-reduce`).
 *
 * Children stay mounted while collapsed (needed for the CSS transition); the
 * wrapper is `aria-hidden` when closed so assistive tech skips the hidden rows.
 */
export function AccordionCollapse({
  open,
  children,
  className,
}: {
  open: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      aria-hidden={!open}
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className,
      )}
    >
      <div className="overflow-hidden min-h-0">{children}</div>
    </div>
  )
}
