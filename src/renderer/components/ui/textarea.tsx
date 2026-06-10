import * as React from 'react'
import { cn } from '@/lib/utils'

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          'flex w-full rounded-md border border-zinc-800 bg-zinc-950 px-3.5 py-2 text-body text-zinc-50 transition-colors duration-150',
          'placeholder:text-zinc-600 resize-none',
          'focus-visible:outline-none focus-visible:border-zinc-700 focus-visible:ring-2 focus-visible:ring-green-500/30',
          'disabled:cursor-not-allowed disabled:opacity-40',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Textarea.displayName = 'Textarea'

export { Textarea }
