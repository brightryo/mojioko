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
      // --separator-strong is reused here for the unchecked border because
      // --border (= --secondary, faint) is too quiet for a small interactive
      // affordance; the var pairing matches the Step 3 Support button hover.
      // REQ-20260615-003 mira: size-4 stays, rounded-[3px] → rounded-[4px] (matches mira).
      'peer size-4 shrink-0 rounded-[4px] border border-[hsl(var(--separator-strong))] ring-offset-background',
      'focus:outline-none focus-visible:outline-none',
      'disabled:cursor-not-allowed disabled:opacity-40',
      'data-[state=checked]:bg-primary data-[state=checked]:border-primary',
      'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary',
      'transition-colors duration-150',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-primary-foreground">
      {/* REQ-20260615-003 mira: indicator h-3 w-3 → h-3.5 w-3.5. */}
      {props.checked === 'indeterminate' ? (
        <Minus className="h-3.5 w-3.5" strokeWidth={3} />
      ) : (
        <Check className="h-3.5 w-3.5" strokeWidth={3} />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
