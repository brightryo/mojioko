import { GripVertical } from 'lucide-react'
import {
  Group as RrpGroup,
  Panel as RrpPanel,
  Separator as RrpSeparator,
  type GroupProps as RrpGroupProps,
  type PanelProps as RrpPanelProps,
  type SeparatorProps as RrpSeparatorProps,
} from 'react-resizable-panels'
import { cn } from '@/lib/utils'

/**
 * shadcn-style wrapper around `react-resizable-panels` v4.
 *
 * REQ-20260615-006: rewritten to mirror shadcn's official Radix Resizable
 * (apps/v4/registry/new-york-v4/ui/resizable.tsx) — same markup, same
 * `withHandle` opt-in, same selector strategy (`aria-[orientation=*]:` on
 * the Separator, which react-resizable-panels sets directly).  Earlier
 * MOJIOKO-specific data-attribute selectors (`data-[panel-group-direction=*]`)
 * and the React context grip-direction hack from REQ-20260615-005 are gone.
 *
 * Differences vs. shadcn upstream:
 *  - The MOJIOKO wrapper keeps its `direction` shorthand on
 *    `ResizablePanelGroup` so the existing 3-pane STEP2 call sites and their
 *    layout-percent calculations do not need to change.  Internally the
 *    direction is forwarded as `orientation` to `RrpGroup`, which is the v4
 *    API the library expects.
 *  - The line / chip use `bg-line-strong` (zinc-700) instead of shadcn's
 *    `bg-border` (zinc-800) so the 1-px line stays visible against the
 *    zinc-900 panel surfaces — REQ-20260615-005 noted bg-border sank.  The
 *    grip icon uses `text-fg-tertiary` (zinc-400) so the dots register on
 *    the zinc-700 chip.
 *  - Hover / drag-active states added (`hover:bg-surface-4`,
 *    `data-[resize-handle-active]:bg-primary/60`) for MOJIOKO feel; shadcn
 *    upstream leaves these to the consumer.
 *  - Hit band kept at 4 px (`after:w-1` / `after:h-1`) matching shadcn,
 *    rather than the 6 px from REQ-20260615-004.
 */

export type ResizablePanelGroupProps = Omit<RrpGroupProps, 'orientation'> & {
  direction: 'horizontal' | 'vertical'
}

export function ResizablePanelGroup({
  direction,
  className,
  ...props
}: ResizablePanelGroupProps) {
  return (
    <RrpGroup
      data-slot="resizable-panel-group"
      orientation={direction}
      className={cn(
        'flex h-full w-full aria-[orientation=vertical]:flex-col',
        className,
      )}
      {...props}
    />
  )
}

export type ResizablePanelProps = RrpPanelProps
export function ResizablePanel(props: ResizablePanelProps) {
  return <RrpPanel data-slot="resizable-panel" {...props} />
}

export type ResizableHandleProps = RrpSeparatorProps & {
  /** When true, render shadcn's centred grip chip on top of the line. */
  withHandle?: boolean
}

export function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizableHandleProps) {
  return (
    <RrpSeparator
      data-slot="resizable-handle"
      className={cn(
        // Default = vertical bar (Group direction=horizontal): 1-px line on
        // bg-line-strong with a 4-px transparent hit band centred on it.
        'relative flex w-px items-center justify-center bg-line-strong cursor-col-resize',
        'transition-colors duration-150 hover:bg-surface-4 data-[resize-handle-active]:bg-primary/60',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary focus-visible:ring-offset-1',
        // Horizontal-bar override (Group direction=vertical): flip line + hit band axis.
        'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full',
        'aria-[orientation=horizontal]:cursor-row-resize',
        'aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1',
        'aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0',
        'aria-[orientation=horizontal]:after:-translate-y-1/2',
        // Rotate the grip chip 90° on horizontal bars so the dots run along the line.
        '[&[aria-orientation=horizontal]>div]:rotate-90',
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-[2px] border border-line-strong bg-line-strong">
          <GripVertical className="size-2.5 text-fg-tertiary" />
        </div>
      )}
    </RrpSeparator>
  )
}
