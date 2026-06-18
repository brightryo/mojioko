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
      orientation={direction}
      data-panel-group-direction={direction}
      className={cn(
        'flex h-full w-full',
        direction === 'vertical' && 'flex-col',
        className,
      )}
      {...props}
    />
  )
}

export type ResizablePanelProps = RrpPanelProps
export const ResizablePanel = RrpPanel

export type ResizableHandleProps = RrpSeparatorProps & {
  /** When true, render the centered grip glyph. */
  withHandle?: boolean
}

export function ResizableHandle({
  withHandle,
  className,
  children,
  ...props
}: ResizableHandleProps) {
  return (
    <RrpSeparator
      className={cn(
        // Base: thin divider with a wider hit area, themed against
        // zinc-800 to fit the dark canvas.  The `after` pseudo extends
        // the grab area to 4 px (horizontal) / 4 px (vertical) without
        // visually thickening the line.
        'relative flex items-center justify-center bg-surface-2',
        'transition-colors duration-150',
        'hover:bg-surface-3 data-[resize-handle-active]:bg-primary/60',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/40',
        // Horizontal orientation: vertical bar between left/right panels
        'data-[panel-group-direction=horizontal]:w-px',
        'data-[panel-group-direction=horizontal]:cursor-col-resize',
        'data-[panel-group-direction=horizontal]:after:absolute',
        'data-[panel-group-direction=horizontal]:after:inset-y-0',
        'data-[panel-group-direction=horizontal]:after:left-1/2',
        'data-[panel-group-direction=horizontal]:after:w-2',
        'data-[panel-group-direction=horizontal]:after:-translate-x-1/2',
        // Vertical orientation: horizontal bar between top/bottom panels
        'data-[panel-group-direction=vertical]:h-px',
        'data-[panel-group-direction=vertical]:w-full',
        'data-[panel-group-direction=vertical]:cursor-row-resize',
        'data-[panel-group-direction=vertical]:after:absolute',
        'data-[panel-group-direction=vertical]:after:inset-x-0',
        'data-[panel-group-direction=vertical]:after:top-1/2',
        'data-[panel-group-direction=vertical]:after:h-2',
        'data-[panel-group-direction=vertical]:after:-translate-y-1/2',
        className,
      )}
      {...props}
    >
      {withHandle ? (
        <div
          className={cn(
            'z-10 flex items-center justify-center rounded-sm border border-line-strong bg-surface-1',
            'data-[panel-group-direction=horizontal]:h-5 data-[panel-group-direction=horizontal]:w-3',
            'data-[panel-group-direction=vertical]:h-3 data-[panel-group-direction=vertical]:w-5',
          )}
        >
          <GripVertical className="h-3 w-3 text-fg-muted data-[panel-group-direction=vertical]:rotate-90" />
        </div>
      ) : (
        children
      )}
    </RrpSeparator>
  )
}
