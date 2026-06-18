import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded px-1.5 py-0.5 text-caption font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-2 text-fg-secondary',
        success: 'bg-primary/10 text-primary border border-primary/20',
        warning: 'bg-warning-soft/10 text-warning-soft border border-warning-soft/20',
        danger: 'bg-destructive/10 text-destructive border border-destructive/20',
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
