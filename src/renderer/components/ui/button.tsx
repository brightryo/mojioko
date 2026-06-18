import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// REQ-081 #2: no focus ring on buttons.  Owner decision — keyboard
// navigation lands silently on the button without the green halo the
// previous focus-visible:ring-2 produced.  Inputs keep their focus
// indication (see ui/input.tsx + time-input.tsx); only button-like
// elements drop the ring.
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-150 focus:outline-none focus-visible:outline-none disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        /** Main action per screen — green background.
         *  REQ-071 Phase 3.6: text colour shifted green-950 -> zinc-950.
         *  green-950 (#052e16) is a very dark forest green and shares hue
         *  with bg-primary (#22c55e), so the label visually washed into the
         *  background even though contrast was AA (~6.7:1).  zinc-950
         *  (#09090b, near-black neutral) gives AAA contrast (~9.4:1) AND a
         *  neutral hue that snaps off the green — the label now reads as a
         *  dark button label rather than fading into the green plate. */
        primary: 'bg-primary text-fg-inverse hover:bg-primary-hover active:bg-primary-active rounded-lg',
        /** Secondary emphasis — light background. */
        secondary: 'bg-surface-inverse-0 text-fg-inverse hover:bg-surface-inverse-1 active:bg-surface-inverse-2 rounded-md',
        /** Tertiary / ghost — transparent with border. */
        ghost:
          'bg-transparent text-fg-tertiary border border-line hover:bg-surface-1 hover:text-fg-primary active:bg-surface-2 rounded-md',
        /** Destructive action — red tint. */
        danger:
          'bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20 active:bg-destructive/30 rounded-md',
        /** Icon-only action — transparent with border. */
        icon: 'bg-transparent text-fg-muted border border-line hover:text-fg-secondary hover:border-line-strong active:bg-surface-2 rounded-md',
        /** Link-like, no border. */
        link: 'bg-transparent text-fg-tertiary hover:text-fg-primary underline-offset-4 hover:underline'
      },
      size: {
        sm: 'h-7 px-3 py-1.5 text-body-sm',
        md: 'h-9 px-4 py-2.5 text-body',
        lg: 'h-11 px-5 py-3 text-body',
        /** Square icon button. */
        icon: 'h-8 w-8 p-0 text-body'
      }
    },
    defaultVariants: {
      variant: 'ghost',
      size: 'md'
    }
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
