import type { ReactNode } from 'react'

interface FooterProps {
  left?: ReactNode
  center?: ReactNode
  right?: ReactNode
}

/**
 * Sticky footer bar used by all Step screens.
 * Three regions: left (secondary action), center (status info), right (primary action).
 */
export function Footer({ left, center, right }: FooterProps) {
  return (
    <footer className="flex flex-shrink-0 items-center justify-between border-t border-zinc-800 bg-zinc-900 px-7 py-3.5">
      <div className="flex items-center">{left}</div>
      {/* REQ-067 phase B: was text-zinc-500 (hint tier, ~4.0:1 — AA body
          fail).  The footer center holds permanently-visible status info
          (edit/warning/deleted counts on Step 2, model status on Step 1,
          privacy notes on Step 3); lifted to text-zinc-300 (body-adjacent
          tier ~13:1, AAA pass) so the chrome stays legible at a glance. */}
      <div className="flex items-center text-[11px] text-zinc-300">{center}</div>
      <div className="flex items-center">{right}</div>
    </footer>
  )
}
