import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * shadcn-style checkbox wrapper.
 *
 * Three states:
 *   - unchecked       → empty box
 *   - checked={true}  → green box with check mark
 *   - checked="indeterminate" → green box with horizontal stripe (header-row state
 *                              when only some visible rows are selected)
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      'peer h-4 w-4 shrink-0 rounded-[3px] border border-zinc-600 ring-offset-zinc-950',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/30 focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-40',
      'data-[state=checked]:bg-green-500 data-[state=checked]:border-green-500',
      'data-[state=indeterminate]:bg-green-500 data-[state=indeterminate]:border-green-500',
      'transition-colors duration-150',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-green-950">
      {props.checked === 'indeterminate' ? (
        <Minus className="h-3 w-3" strokeWidth={3} />
      ) : (
        <Check className="h-3 w-3" strokeWidth={3} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
