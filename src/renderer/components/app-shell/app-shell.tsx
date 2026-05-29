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
  children: ReactNode
}

export function AppShell({
  currentStep,
  appVersion,
  footerLeft,
  footerCenter,
  footerRight,
  noScroll,
  children
}: AppShellProps) {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-zinc-950">
      <Breadcrumb currentStep={currentStep} appVersion={appVersion} />
      <main className={cn('flex-1', noScroll ? 'overflow-hidden' : 'overflow-y-auto')}>
        <div
          className={cn(
            'max-w-[1100px] mx-auto w-full px-6',
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
