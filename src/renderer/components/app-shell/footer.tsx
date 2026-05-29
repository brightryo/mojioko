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
      <div className="flex items-center text-[11px] text-zinc-500">{center}</div>
      <div className="flex items-center">{right}</div>
    </footer>
  )
}
