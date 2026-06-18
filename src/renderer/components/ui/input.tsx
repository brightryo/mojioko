import * as React from 'react'
import { cn } from '@/lib/utils'

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>

const Input = React.forwardRef<HTMLInputElement, InputProps>(({ className, type, ...props }, ref) => {
  return (
    <input
      type={type}
      className={cn(
        // REQ-20260615-003 mira density: h-9 → h-7, px-3.5 py-2 → px-2 py-1, text-body → text-body-sm.
        'flex h-7 w-full rounded-md border border-line bg-surface-0 px-2 py-1 text-body-sm text-fg-primary transition-colors duration-150',
        'placeholder:text-fg-disabled',
        'focus-visible:outline-none focus-visible:border-line-strong focus-visible:ring-2 focus-visible:ring-primary/30',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
      ref={ref}
      {...props}
    />
  )
})
Input.displayName = 'Input'

export { Input }
