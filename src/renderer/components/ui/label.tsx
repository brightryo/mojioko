import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '@/lib/utils'

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    // REQ-0180 2a — feat/ui-resolve dropped the pre-0180 uppercase +
    // tracking-wider + font-medium "chrome brand label" recipe.  Owner
    // Phase B-1 / REQ-0179 feedback: "the inspector labels all look
    // bold and shouty."  The stack (uppercase + tracking + medium)
    // combined into visual weight that read as bold even at
    // text-label (12 px), erasing the label ↔ value hierarchy in
    // Resolve-style inspectors where labels are meant to sit quietly
    // behind the values they annotate.  The pre-0180 REQ-20260615-003
    // rationale for keeping the shouty label was "otherwise we lose
    // the hierarchy vs body copy" — but that hierarchy is now carried
    // by (a) `text-muted-foreground` (72 % L via REQ-0179 s1, 8:1 vs
    // surface-0 — visibly muted vs primary text at 14:1) and (b)
    // future value-cell classnames that lift weight to medium.
    //
    // Kept: `text-label` (12 px), `text-muted-foreground` (the s1 tier),
    // `leading-none` (mira alignment).
    // Dropped: `font-medium`, `uppercase`, `tracking-wider`.
    className={cn('text-label font-normal text-muted-foreground leading-none', className)}
    {...props}
  />
))
Label.displayName = LabelPrimitive.Root.displayName

export { Label }
