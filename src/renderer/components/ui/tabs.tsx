import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

const Tabs = TabsPrimitive.Root

/**
 * Underline-style tab strip — the standard "this is a tab bar" pattern.
 * A 1-px zinc-800 baseline under the whole list reads as a tab track even
 * on the dialog's zinc-900 surface (the old rounded-chip style shared the
 * dialog background, so non-selected tabs looked like plain text).
 *
 * Each TabsTrigger renders a 2-px transparent border-bottom that flips to
 * the green accent on the active tab.  -mb-px overlaps the list baseline
 * so the active underline reads as a solid bar instead of two stacked
 * lines.  REQ-019 #2.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex items-center gap-1 border-b border-zinc-800 w-full',
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
      'relative inline-flex items-center justify-center whitespace-nowrap',
      'px-3 py-2 text-body font-medium -mb-px',
      'border-b-2 border-transparent transition-colors duration-150',
      'text-zinc-400 hover:text-zinc-100 hover:border-zinc-700',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/30 rounded-t-sm',
      'disabled:pointer-events-none disabled:opacity-40',
      'data-[state=active]:text-zinc-50 data-[state=active]:border-green-500',
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
      'mt-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/30 rounded-md',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
