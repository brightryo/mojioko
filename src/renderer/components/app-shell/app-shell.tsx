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
   * than "edge-to-edge".  See also `edgeToEdge` below (REQ-0189) which
   * drops that horizontal padding.
   */
  fluid?: boolean
  /**
   * REQ-0189 — drop the outer horizontal AND vertical padding
   * (`px-6 py-5 / py-6`) around the content container so it butts up
   * against the breadcrumb below, the footer above, and both viewport
   * edges.  Owner spec for STEP2: "3-pane を画面領域いっぱいに広げる".
   * STEP1's centred single-column layout keeps the padding (unset =
   * pre-0189 behaviour); only STEP2 opts in.
   */
  edgeToEdge?: boolean
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
  edgeToEdge,
  children
}: AppShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Breadcrumb title={title} description={description} />
      <main className={cn('flex-1', noScroll ? 'overflow-hidden' : 'overflow-y-auto')}>
        <div
          className={cn(
            'mx-auto w-full',
            // Horizontal padding: default px-6, dropped when
            // `edgeToEdge` (REQ-0189) so STEP2's 3-pane spans the
            // full viewport width.
            !edgeToEdge && 'px-6',
            // REQ-20260614-001 Phase 2: STEP2 sets `fluid` so the 3-pane
            // resizable layout can use the full window width.  Other steps
            // keep the bounded 1100px chrome for readability.
            fluid ? 'max-w-none' : 'max-w-[1100px]',
            // Vertical padding: default py-5 (noScroll) or py-6
            // (scrolling).  Dropped by `edgeToEdge`, but height stays
            // h-full in the noScroll case so the child fills the main
            // area under the breadcrumb and above the footer.
            noScroll
              ? cn('h-full', !edgeToEdge && 'py-5')
              : (edgeToEdge ? undefined : 'py-6')
          )}
        >
          {children}
        </div>
      </main>
      <Footer left={footerLeft} center={footerCenter} right={footerRight} />
    </div>
  )
}
