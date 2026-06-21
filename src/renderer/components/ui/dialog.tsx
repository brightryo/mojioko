import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  // No backdrop-blur — the user needs to read time values in the table behind
  // the dialog while adjusting subtitle times.  Plain semi-transparent black
  // dim only.
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/50',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // REQ-082: suppress Radix Dialog's default Esc-to-close — Esc is no
      // longer a keyboard shortcut anywhere in the app.  The X icon
      // (rendered just below) and any per-dialog Cancel buttons are the
      // only close affordances.  Outside-click closing is left intact
      // because it's a mouse gesture, not a keyboard shortcut.
      onEscapeKeyDown={(e) => e.preventDefault()}
      className={cn(
        'fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]',
        // REQ-20260615-003 mira density: p-6 → p-4, duration-200 → duration-100.
        // REQ-20260615-044: outline-none + focus:outline-none + focus-visible:outline-none
        // belt-and-braces — Radix focuses this container on open and the
        // browser would otherwise paint its default outline.  The global
        // suppressor in globals.css already covers this; we leave the
        // utilities here as a readable signal at the component layer.
        'outline-none focus:outline-none focus-visible:outline-none',
        'w-full max-w-lg rounded-xl border border-line-strong bg-surface-1 p-4 shadow-2xl shadow-black/60',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
        'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        'duration-100',
        className
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        // REQ-20260615-003 mira: close at top-2 right-2 (closer to corner).
        <DialogPrimitive.Close className="absolute right-2 top-2 rounded-md p-1 text-fg-muted transition-colors hover:text-fg-secondary focus:outline-none focus-visible:outline-none">
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

// REQ-20260615-003 mira density: header gap 1.5→1, mb 5→3; footer mt 6→4.
const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1 mb-3', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-row justify-end gap-2 mt-4', className)} {...props} />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    // REQ-20260615-003 mira: title text-title → text-headline (16→15).
    className={cn('text-headline font-semibold text-fg-primary leading-none', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    // REQ-20260615-003 mira: description text-body → text-body-sm.
    className={cn('text-body-sm text-fg-tertiary', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription
}
