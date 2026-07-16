import { forwardRef } from 'react'
import { GripVertical } from 'lucide-react'
import {
  Group as RrpGroup,
  Panel as RrpPanel,
  Separator as RrpSeparator,
  type GroupProps as RrpGroupProps,
  type PanelProps as RrpPanelProps,
  type PanelImperativeHandle,
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
 *    `data-[resize-handle-active]:bg-fg-muted`) for MOJIOKO feel; shadcn
 *    upstream leaves these to the consumer.
 *  - Hit band kept at 4 px (`after:w-1` / `after:h-1`) matching shadcn,
 *    rather than the 6 px from REQ-20260615-004.
 *
 * REQ-20260615-007: every state of the handle (base / hover / drag / focus)
 * uses border / surface tokens only — primary green is reserved for the
 * subtitle-selection accent, so the resize handle must never light up in
 * that colour.  Focus ring removed entirely (a divider seldom carries
 * keyboard focus, and a neutral ring on a 1-px line reads as visual noise);
 * drag-active uses `bg-fg-muted` (zinc-500, one step brighter than the
 * hover state) as the press feedback.
 *
 * REQ-20260615-008: `disabled` prop hides the grip and blocks dragging
 * while leaving the Resizable structure in the React tree so it can be
 * re-enabled later without touching call sites.
 *
 * REQ-20260615-009 correction: when `disabled`, the 1-px line **stays
 * visible** as a static divider; only the grip chip, hover / drag colour
 * shifts, cursor cue, and pointer interactivity are stripped.  Keeping
 * the line gives the panels a visible boundary even though the user
 * cannot resize through it.
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
// REQ-0183 — forwarded ref so callers (e.g. STEP2's preview pane
// collapse toggle) can grab the underlying `PanelImperativeHandle`
// and drive collapse()/expand()/resize() imperatively.  The
// react-resizable-panels v4 API exposes the handle via the `panelRef`
// prop rather than React's built-in `ref`, so we forward the caller's
// `ref` down as `panelRef` on the inner RrpPanel.  Consumers still
// write `ref={myRef}` in the normal React style.
export const ResizablePanel = forwardRef<PanelImperativeHandle, ResizablePanelProps>(
  (props, ref) => <RrpPanel data-slot="resizable-panel" panelRef={ref ?? undefined} {...props} />,
)
ResizablePanel.displayName = 'ResizablePanel'
// Re-export the handle type so consumers can annotate their refs
// without pulling react-resizable-panels directly.
export type { PanelImperativeHandle }

export type ResizableHandleProps = RrpSeparatorProps & {
  /** When true, render shadcn's centred grip chip on top of the line. */
  withHandle?: boolean
}

export function ResizableHandle({
  withHandle,
  disabled,
  className,
  ...props
}: ResizableHandleProps) {
  return (
    <RrpSeparator
      data-slot="resizable-handle"
      disabled={disabled}
      className={cn(
        // Default = vertical bar (Group direction=horizontal): 1-px line on
        // bg-line-strong with a 4-px transparent hit band centred on it.
        'relative flex w-px items-center justify-center bg-line-strong cursor-col-resize',
        'transition-colors duration-150 hover:bg-surface-4 data-[resize-handle-active]:bg-fg-muted',
        'after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2',
        'focus:outline-none focus-visible:outline-none',
        // Horizontal-bar override (Group direction=vertical): flip line + hit band axis.
        'aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full',
        'aria-[orientation=horizontal]:cursor-row-resize',
        'aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1',
        'aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0',
        'aria-[orientation=horizontal]:after:-translate-y-1/2',
        // Rotate the grip chip 90° on horizontal bars so the dots run along the line.
        '[&[aria-orientation=horizontal]>div]:rotate-90',
        // REQ-20260615-008 + REQ-20260615-009: disabled = static visible
        // divider, no grip, no interactivity.  The 1-px line keeps its
        // `bg-line-strong` colour so panels still read as separated; only
        // the hover / drag colour shifts, cursor cue, and pointer events
        // are stripped.
        disabled && [
          'cursor-default pointer-events-none',
          'hover:bg-line-strong data-[resize-handle-active]:bg-line-strong',
          'after:hidden',
          'aria-[orientation=horizontal]:cursor-default',
        ],
        className,
      )}
      {...props}
    >
      {withHandle && !disabled && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-[2px] border border-line-strong bg-line-strong">
          <GripVertical className="size-2.5 text-fg-tertiary" />
        </div>
      )}
    </RrpSeparator>
  )
}
