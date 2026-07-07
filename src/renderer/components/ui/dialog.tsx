import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/hooks/use-overlay-registration'

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

/**
 * REQ-0137 fix — internal component that lives INSIDE the Radix
 * Dialog Content subtree.  Radix's `Presence` mounts Content's
 * children only when the Root is `open` (or during a close
 * animation), so this component's mount ⇔ dialog visible.  Placing
 * `useOverlayRegistration()` here (instead of at the wrapper's
 * top-level) fixes the REQ-0132 regression where every Dialog
 * inflated the overlay counter at app boot and blocked every editor
 * shortcut.
 */
function OverlayRegistrar(): null {
  useOverlayRegistration()
  return null
}

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // REQ-0132 §2.2 root-cause fix — REQ-082 had suppressed Radix's
      // Esc-to-close on the assumption that "Esc is no longer a
      // keyboard shortcut anywhere in the app."  That is no longer
      // true (REQ-0132 §2.2: Esc uniformly closes the topmost
      // overlay).  Removing the `onEscapeKeyDown` preventDefault
      // restores Radix's built-in behaviour: pressing Esc fires
      // `onOpenChange(false)` on the Root, which closes the dialog
      // through the existing state channel.  The overlay registry
      // (see `<OverlayRegistrar />` below) unregisters via the
      // Content-child unmount that follows.  Owner-facing symptom of
      // the pre-fix state (REQ-0132): Settings / About / Time-editor /
      // etc. did not close on Esc despite being visible.
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
      {/* REQ-0137 fix — placed inside Radix Content so it only mounts
          when the dialog is open (Radix Presence gate).  See
          `OverlayRegistrar` above for why. */}
      <OverlayRegistrar />
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
