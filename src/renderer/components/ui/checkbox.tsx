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
      'peer h-4 w-4 shrink-0 rounded-[3px] border border-[hsl(var(--separator-strong))] ring-offset-background',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 focus-visible:ring-offset-2',
      'disabled:cursor-not-allowed disabled:opacity-40',
      'data-[state=checked]:bg-primary data-[state=checked]:border-primary',
      'data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary',
      'transition-colors duration-150',
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-primary-foreground">
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
