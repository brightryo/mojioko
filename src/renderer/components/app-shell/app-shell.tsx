import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Breadcrumb, type StepNumber } from './breadcrumb'
import { Footer } from './footer'

interface AppShellProps {
  currentStep: StepNumber
  appVersion: string
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

export function AppShell({
  currentStep,
  appVersion,
  footerLeft,
  footerCenter,
  footerRight,
  noScroll,
  fluid,
  children
}: AppShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950">
      <Breadcrumb currentStep={currentStep} appVersion={appVersion} />
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
