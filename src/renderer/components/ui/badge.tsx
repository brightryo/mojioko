import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// REQ-20260615-003 mira shape: rounded → rounded-full, h-5 floor, text-caption → text-micro,
// gap-1.  The 5 MOJIOKO variants (default / success / warning / danger / muted) are kept so
// call sites do not change.
const badgeVariants = cva(
  // REQ-0419 — role rule: badge = caption (was text-micro). h-auto so the
  // taller caption text isn't clipped by the old h-5 pill.
  // REQ-0421 — owner overlay reassignment: badge default caption → body-sm
  // (same 14px, line-height 18 → 20) so every badge reports as body-sm.
  'inline-flex items-center gap-1 rounded-full border border-transparent px-2 py-0.5 text-body-sm font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-surface-2 text-fg-secondary',
        // REQ-0525 — the 編集済み badge.  It used to be `default` (a neutral
        // grey chip), which said nothing about the state; it now carries the
        // same `--row-edited` blue as the timeline clip and the list row, so
        // the three read as one thing.
        //
        // Solid rather than the soft 10 %-tint the sibling variants use, and
        // that is forced rather than chosen: --row-edited is a DARK blue, so as
        // a foreground on this dark UI it is unreadable.  It only works as a
        // fill.  The different weight is also useful: "edited" is a state, the
        // amber and red badges beside it are warnings, and they should not read
        // alike.
        //
        // Re-measured at REQ-0527's #00638a (was #343FDF), real pixels:
        //   as a foreground on the dark UI   2.72:1  (was 2.52) — still unusable
        //   white on the solid fill          6.11:1  (was 6.59) — still clears AA
        // The badge therefore keeps its shape through the recolour; only the
        // margin above 4.5:1 narrowed slightly.
        edited: 'bg-row-edited text-fg-primary border-row-edited',
        success: 'bg-primary/10 text-primary border-primary/20',
        // REQ-0421 (step2) — overlay reassignment: warning badge (時間重複 /
        // 文字あふれ / 空テキスト) body-sm → micro. text-micro is appended AFTER the
        // base text-body-sm so cn()'s font-size-aware twMerge keeps micro.
        warning: 'bg-warning-soft/10 text-warning-soft border-warning-soft/20 text-micro',
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
