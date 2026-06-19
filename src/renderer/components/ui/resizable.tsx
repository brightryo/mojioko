import * as React from 'react'
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
 * REQ-20260614-001 Phase 2 — shadcn-style wrapper around
 * `react-resizable-panels` v4 (`Group` / `Panel` / `Separator`).
 *
 * The v4 API replaces v3's `PanelGroup` / `PanelResizeHandle` names, so this
 * primitive can't be the canonical shadcn copy verbatim — it's adapted to
 * the v4 surface (`Group` with `orientation` prop, `Separator` instead of
 * `PanelResizeHandle`) while keeping the shadcn-public surface
 * (`ResizablePanelGroup` / `ResizablePanel` / `ResizableHandle`) so callers
 * read familiar.
 *
 * Direction shorthand: `direction="horizontal"|"vertical"` maps to v4's
 * `orientation` prop and writes the matching data attribute so the
 * handle's CSS can branch on it.
 *
 * REQ-20260615-005: the shadcn `withHandle` look is the default — a slim
 * 1-px line plus a small centred grip chip with a GripVertical glyph that
 * rotates 90° on horizontal bars.  Line is `bg-line-strong` (zinc-700)
 * so it stays visible against the zinc-900 panel surfaces (the previous
 * `bg-line` / zinc-800 sank into the background).  6-px transparent hit
 * band kept from REQ-20260615-004.  Direction reaches the grip via a
 * React context — Tailwind's `data-[...]` variant matches the element's
 * own attribute, and react-resizable-panels does not forward the parent
 * Group's data attribute onto descendants of the Separator.
 */

const ResizableDirectionContext = React.createContext<'horizontal' | 'vertical'>('horizontal')

export type ResizablePanelGroupProps = Omit<RrpGroupProps, 'orientation'> & {
  direction: 'horizontal' | 'vertical'
}

export function ResizablePanelGroup({
  direction,
  className,
  ...props
}: ResizablePanelGroupProps) {
  return (
    <ResizableDirectionContext.Provider value={direction}>
      <RrpGroup
        orientation={direction}
        data-panel-group-direction={direction}
        className={cn(
          'flex h-full w-full',
          direction === 'vertical' && 'flex-col',
          className,
        )}
        {...props}
      />
    </ResizableDirectionContext.Provider>
  )
}

export type ResizablePanelProps = RrpPanelProps
export const ResizablePanel = RrpPanel

export type ResizableHandleProps = RrpSeparatorProps

export function ResizableHandle({
  className,
  children,
  ...props
}: ResizableHandleProps) {
  const direction = React.useContext(ResizableDirectionContext)
  return (
    <RrpSeparator
      className={cn(
        // Slim 1-px line on the strong border token (zinc-700) so it
        // contrasts against the zinc-900 panel surfaces; `after` pseudo
        // extends a transparent 6-px hit band centred on the line.
        'relative flex items-center justify-center bg-line-strong',
        'transition-colors duration-150',
        'hover:bg-surface-4 data-[resize-handle-active]:bg-primary/60',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40',
        // Horizontal orientation: vertical bar between left/right panels
        'data-[panel-group-direction=horizontal]:w-px',
        'data-[panel-group-direction=horizontal]:cursor-col-resize',
        'data-[panel-group-direction=horizontal]:after:absolute',
        'data-[panel-group-direction=horizontal]:after:inset-y-0',
        'data-[panel-group-direction=horizontal]:after:left-1/2',
        'data-[panel-group-direction=horizontal]:after:w-1.5',
        'data-[panel-group-direction=horizontal]:after:-translate-x-1/2',
        // Vertical orientation: horizontal bar between top/bottom panels
        'data-[panel-group-direction=vertical]:h-px',
        'data-[panel-group-direction=vertical]:w-full',
        'data-[panel-group-direction=vertical]:cursor-row-resize',
        'data-[panel-group-direction=vertical]:after:absolute',
        'data-[panel-group-direction=vertical]:after:inset-x-0',
        'data-[panel-group-direction=vertical]:after:top-1/2',
        'data-[panel-group-direction=vertical]:after:h-1.5',
        'data-[panel-group-direction=vertical]:after:-translate-y-1/2',
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          'z-10 flex items-center justify-center rounded-sm border border-line-strong bg-surface-1',
          direction === 'horizontal' ? 'h-5 w-3' : 'h-3 w-5',
        )}
      >
        <GripVertical
          className={cn(
            'h-3 w-3 text-fg-tertiary',
            direction === 'vertical' && 'rotate-90',
          )}
        />
      </div>
      {children}
    </RrpSeparator>
  )
}
