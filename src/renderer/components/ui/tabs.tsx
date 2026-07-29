import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

const Tabs = TabsPrimitive.Root

/**
 * REQ-0281 §1 — tab strip revised so each trigger reads unambiguously as
 * a clickable button and the active tab's relationship to the panel
 * below is obvious.  Previous "compact pill" strip (REQ-20260615-003)
 * used a light bg lift on the active trigger which the owner found hard
 * to distinguish from the inactive ones.
 *
 * The revised design:
 *  - Each trigger has a persistent 1px border and clear hover state so
 *    it looks like a button whether active or not.
 *  - The active trigger uses a stronger bg (`bg-surface-1`), a
 *    stronger border (`border-line-strong`) AND a 2px `primary` underline
 *    directly below the trigger — the underline touches the divider
 *    beneath the tab row so the "this tab owns the panel below" cue
 *    is visually obvious.
 *  - The whole `TabsList` sits above a `border-b border-line` divider
 *    which spans the full dialog width, so the tab row and its content
 *    area read as two clearly-related sections.
 *
 * Kept aligned with shadcn/ui + Tailwind design tokens — no custom
 * palette or geometry invented for this change.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      // REQ-0281 §1 — full-width row + bottom divider so the tab row
      // and its panel below read as related sections.  Triggers sit
      // on top of the divider so their underline visually merges with
      // it when active.
      'flex w-full items-end gap-1 border-b border-line text-fg-tertiary',
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // Base — always looks like a button (visible border, padding,
      // hover feedback).  `-mb-px` pulls the trigger down by 1px so
      // its bottom edge overlaps the parent's `border-b`, letting the
      // active-state underline sit flush against the divider.
      'inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
      'rounded-t-md border border-b-2 border-transparent border-b-transparent px-3 py-1.5 -mb-px',
      'text-body-sm font-medium bg-transparent',
      'transition-colors duration-150',
      'hover:bg-surface-2/40 hover:text-fg-primary hover:border-line',
      'focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
      'disabled:pointer-events-none disabled:opacity-40',
      // Active — stronger bg, stronger border on top/sides + primary
      // underline replacing the transparent border-b.
      'data-[state=active]:bg-surface-1 data-[state=active]:text-fg-primary',
      'data-[state=active]:border-line-strong data-[state=active]:border-b-primary',
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-3 focus:outline-none focus-visible:outline-none rounded-md',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
