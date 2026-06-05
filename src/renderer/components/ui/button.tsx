import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        /** Main action per screen — green background.
         *  REQ-071 Phase 3.6: text colour shifted green-950 -> zinc-950.
         *  green-950 (#052e16) is a very dark forest green and shares hue
         *  with bg-green-500 (#22c55e), so the label visually washed into the
         *  background even though contrast was AA (~6.7:1).  zinc-950
         *  (#09090b, near-black neutral) gives AAA contrast (~9.4:1) AND a
         *  neutral hue that snaps off the green — the label now reads as a
         *  dark button label rather than fading into the green plate. */
        primary: 'bg-green-500 text-zinc-950 hover:bg-green-600 active:bg-green-700 rounded-lg',
        /** Secondary emphasis — light background. */
        secondary: 'bg-zinc-50 text-zinc-950 hover:bg-zinc-200 active:bg-zinc-300 rounded-md',
        /** Tertiary / ghost — transparent with border. */
        ghost:
          'bg-transparent text-zinc-400 border border-zinc-800 hover:bg-zinc-900 hover:text-zinc-100 active:bg-zinc-800 rounded-md',
        /** Destructive action — red tint. */
        danger:
          'bg-red-500/10 text-red-500 border border-red-500/20 hover:bg-red-500/20 active:bg-red-500/30 rounded-md',
        /** Icon-only action — transparent with border. */
        icon: 'bg-transparent text-zinc-500 border border-zinc-800 hover:text-zinc-300 hover:border-zinc-700 active:bg-zinc-800 rounded-md',
        /** Link-like, no border. */
        link: 'bg-transparent text-zinc-400 hover:text-zinc-100 underline-offset-4 hover:underline'
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
