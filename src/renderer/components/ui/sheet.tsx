import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOverlayRegistration } from '@/hooks/use-overlay-registration'

/**
 * REQ-20260615-023: Sheet primitive adapted from shadcn's new-york-v4
 * resizable.tsx pattern.  Built on the same `@radix-ui/react-dialog`
 * primitive MOJIOKO's `dialog.tsx` already uses, so no new dependency.
 * Visual tokens map to the project's `bg-popover` / `border-line-strong`
 * scheme.
 *
 * Side defaults to `right` to match REQ-20260615-023.
 */

const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close
const SheetPortal = DialogPrimitive.Portal

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
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
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName

type SheetSide = 'top' | 'right' | 'bottom' | 'left'

/**
 * REQ-0137 fix — same OverlayRegistrar pattern Dialog uses; see
 * dialog.tsx for the rationale.  Placed inside Radix Content so the
 * mount lifecycle tracks the Root's `open` state, not our wrapper's
 * unconditional render.
 */
function OverlayRegistrar(): null {
  useOverlayRegistration()
  return null
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: SheetSide
    hideClose?: boolean
  }
>(({ className, children, side = 'right', hideClose, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <DialogPrimitive.Content
      ref={ref}
      // REQ-0132 §2.2 root-cause fix — REQ-082 parity had suppressed
      // Radix's built-in Esc-to-close on Sheet.  Removing the
      // `onEscapeKeyDown` preventDefault restores it so the burn-in
      // drawer and transcription drawer close on Esc alongside every
      // other overlay (§2.2 uniform Esc semantics).
      className={cn(
        'fixed z-50 flex flex-col gap-4 bg-popover text-fg-primary shadow-2xl shadow-black/60',
        // REQ-20260615-044 parity with DialogContent: Radix focuses the
        // content element on open and the browser would otherwise paint
        // its default outline.  The global suppressor in globals.css
        // already covers this; the utilities are kept here as a
        // readable component-layer signal.
        'outline-none focus:outline-none focus-visible:outline-none',
        'transition ease-in-out',
        'data-[state=closed]:animate-out data-[state=closed]:duration-300',
        'data-[state=open]:animate-in data-[state=open]:duration-300',
        side === 'right' &&
          'inset-y-0 right-0 h-full w-full max-w-xl border-l border-line-strong data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
        side === 'left' &&
          'inset-y-0 left-0 h-full w-full max-w-xl border-r border-line-strong data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
        side === 'top' &&
          'inset-x-0 top-0 h-auto border-b border-line-strong data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top',
        side === 'bottom' &&
          'inset-x-0 bottom-0 h-auto border-t border-line-strong data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
        className
      )}
      {...props}
    >
      {/* REQ-0137 fix — child of Radix Content, gated by Presence. */}
      <OverlayRegistrar />
      {children}
      {!hideClose && (
        <SheetClose className="absolute right-3 top-3 rounded-md p-1 text-fg-muted transition-colors hover:text-fg-secondary focus:outline-none focus-visible:outline-none">
          <X className="h-3.5 w-3.5" />
          <span className="sr-only">Close</span>
        </SheetClose>
      )}
    </DialogPrimitive.Content>
  </SheetPortal>
))
SheetContent.displayName = DialogPrimitive.Content.displayName

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1 px-4 pt-4', className)} {...props} />
)
SheetHeader.displayName = 'SheetHeader'

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('mt-auto flex flex-col gap-2 px-4 py-3 border-t border-line', className)} {...props} />
)
SheetFooter.displayName = 'SheetFooter'

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-headline font-semibold text-fg-primary leading-none', className)}
    {...props}
  />
))
SheetTitle.displayName = DialogPrimitive.Title.displayName

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-body-sm text-fg-tertiary', className)}
    {...props}
  />
))
SheetDescription.displayName = DialogPrimitive.Description.displayName

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription
}
