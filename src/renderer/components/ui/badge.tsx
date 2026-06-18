import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// REQ-20260615-003 mira shape: rounded → rounded-full, h-5 floor, text-caption → text-micro,
// gap-1.  The 5 MOJIOKO variants (default / success / warning / danger / muted) are kept so
// call sites do not change.
const badgeVariants = cva(
  'inline-flex h-5 items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-micro font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-2 text-fg-secondary',
        success: 'bg-primary/10 text-primary border-primary/20',
        warning: 'bg-warning-soft/10 text-warning-soft border-warning-soft/20',
        danger: 'bg-destructive/10 text-destructive border-destructive/20',
        muted: 'bg-surface-2/50 text-fg-muted'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
