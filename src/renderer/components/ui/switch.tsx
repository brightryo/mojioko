import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'
import { cn } from '@/lib/utils'

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      // REQ-20260615-003 mira density: h-5 w-9 → h-4 w-7 (compact track).
      'peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent',
      'transition-colors duration-150 focus:outline-none focus-visible:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-40',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-surface-3',
      className
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        // Thumb 4→3, translate 4→3 for the smaller track.
        'pointer-events-none block h-3 w-3 rounded-full bg-white shadow-lg ring-0',
        'transition-transform duration-150',
        'data-[state=checked]:translate-x-3 data-[state=unchecked]:translate-x-0.5'
      )}
    />
  </SwitchPrimitive.Root>
))
Switch.displayName = SwitchPrimitive.Root.displayName

export { Switch }
