import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

const Tabs = TabsPrimitive.Root

/**
 * REQ-20260615-003: mira "compact pill" tab strip.  The MOJIOKO underline
 * style (REQ-019 #2) is replaced with mira's segmented-pill default — a
 * rounded-lg track of bg-surface-2/50 with rounded-md pill triggers; the
 * active trigger lifts onto bg-surface-0 (matches the dialog surface) for
 * a Linear / Raycast-style segmented control.  Reverts cleanly with the
 * mira application commit.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-8 items-center justify-center gap-1 rounded-lg bg-surface-2/50 p-[3px] text-fg-tertiary',
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
      'inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
      'rounded-md border border-transparent px-2 py-0.5 text-body-sm font-medium',
      'transition-colors duration-150',
      'hover:text-fg-primary',
      'focus:outline-none focus-visible:outline-none',
      'disabled:pointer-events-none disabled:opacity-40',
      'data-[state=active]:bg-surface-0 data-[state=active]:text-fg-primary data-[state=active]:border-line',
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
