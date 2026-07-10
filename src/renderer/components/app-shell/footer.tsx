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
    <footer className="flex flex-shrink-0 items-center justify-between border-t border-line bg-surface-1 px-7 py-3">
      <div className="flex items-center">{left}</div>
      {/* REQ-067 phase B: was text-fg-muted (hint tier, ~4.0:1 — AA body
          fail).  The footer center holds permanently-visible status info
          (edit/warning/deleted counts on Step 2, model status on Step 1,
          privacy notes on Step 3); lifted to text-fg-secondary (body-adjacent
          tier ~13:1, AAA pass) so the chrome stays legible at a glance.
          REQ-0182 chrome — with REQ-0179 s1 having lifted --text-muted
          from 3.38:1 to 4.66:1 (AA body pass), we can safely re-drop the
          footer to the muted tier per REQ-0182 §5 "薄く小さく" ask.
          Type size also shrunk from body-sm (13) to caption (12) so the
          footer reads as Resolve-style quiet chrome. */}
      <div className="flex items-center text-caption text-fg-muted">{center}</div>
      <div className="flex items-center">{right}</div>
    </footer>
  )
}
