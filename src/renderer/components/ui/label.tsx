import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '@/lib/utils'

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    // REQ-20260615-003: MOJIOKO's uppercase chrome label is preserved (a deliberate brand
    // decision — mira's plain text-xs/relaxed lowercase label would erase the visual
    // hierarchy between section labels and inline body copy).  Only `leading-none` (mira
    // alignment) is retained from the previous version.
    className={cn('text-label font-medium uppercase tracking-wider text-muted-foreground leading-none', className)}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
