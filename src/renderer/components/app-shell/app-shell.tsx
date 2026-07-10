import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Breadcrumb } from './breadcrumb'
import { Footer } from './footer'

interface AppShellProps {
  /** Screen H1 (e.g. "文字起こし", "編集") — rendered in the top strip. */
  title: string
  /** Optional description — muted, right of title. */
  description?: string
  footerLeft?: ReactNode
  footerCenter?: ReactNode
  footerRight?: ReactNode
  /** When true, main area does not scroll — use for screens that manage their own overflow (e.g. subtitle table). */
  noScroll?: boolean
  /**
   * REQ-20260614-001 Phase 2 — opt out of the default `max-w-[1100px]` chrome
   * width.  Used by STEP2's 3-pane layout so the resizable panels can claim
   * the full window width (otherwise the 3 panes would be crammed into
   * 1100px max even at fullscreen).  STEP1 / STEP3 keep the constraint.
   *
   * When true, the inner content container fills 100% of the viewport width
   * with the same horizontal padding (px-6) as the bounded variant — so
   * STEP2 screens reading "edge padding present, max width gone" rather
   * than "edge-to-edge".
   */
  fluid?: boolean
  children: ReactNode
}

// REQ-0185 §3 — pre-0185 the AppShell also took `currentStep`
// and `appVersion` for the removed top-of-screen breadcrumb.
// After 0185 the top strip renders `title` + `description`
// instead, and per-route H1 duplication was dropped, so the
// AppShell just forwards those two strings to the (renamed-in-
// place) Breadcrumb component.
export function AppShell({
  title,
  description,
  footerLeft,
  footerCenter,
  footerRight,
  noScroll,
  fluid,
  children
}: AppShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Breadcrumb title={title} description={description} />
      <main className={cn('flex-1', noScroll ? 'overflow-hidden' : 'overflow-y-auto')}>
        <div
          className={cn(
            'mx-auto w-full px-6',
            // REQ-20260614-001 Phase 2: STEP2 sets `fluid` so the 3-pane
            // resizable layout can use the full window width.  Other steps
            // keep the bounded 1100px chrome for readability.
            fluid ? 'max-w-none' : 'max-w-[1100px]',
            noScroll ? 'h-full py-5' : 'py-6'
          )}
        >
          {children}
        </div>
      </main>
      <Footer left={footerLeft} center={footerCenter} right={footerRight} />
    </div>
  )
}
