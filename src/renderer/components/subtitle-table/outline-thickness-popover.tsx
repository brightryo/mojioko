import { useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useOverlayRegistration } from '@/hooks/use-overlay-registration'
import { OutlineThicknessSlider } from './outline-thickness-slider'
import { cn } from '@/lib/utils'

/**
 * REQ-0222 — inline outline-width editor for the subtitle-table row.
 *
 * The row's style column used to render `entry.outlineThicknessPx` as
 * a passive `<span>`.  This component turns that number into a trigger
 * button; clicking it opens a small popover with the same
 * `OutlineThicknessSlider` the inspector uses.
 *
 * History-write semantics (matches the ColorPicker's `onChange` /
 * `onCommit` split from REQ-0125):
 *
 *   - The slider fires `onPreview` per drag frame and `onCommit` at
 *     drag boundary.  Both route through the parent's
 *     `updateEntryPreview` — a history-less setter that lights up the
 *     video overlay without spamming Undo.
 *   - Popover open captures `valueOnOpen`.  Popover close compares
 *     the live value against it; on a real change the parent's
 *     `onCommit(value, valueOnOpen)` fires exactly once so the row
 *     can push a single coarse-grained history op.  If the user
 *     opens and closes without moving the thumb (or moves it back
 *     to the open value), no history op is pushed.
 *
 * Popover viewport clamping follows the FontPicker convention
 * (REQ-0169): `collisionPadding={8}` reserves a viewport gap, and
 * `max-h-[var(--radix-popover-content-available-height)]` caps the
 * height to what Radix measured as available.  The content is a
 * single slider row so the cap almost never engages, but keeping the
 * pattern uniform prevents the "clips off the top edge" regression
 * on rows near the bottom of the visible viewport.
 */
interface OutlineThicknessPopoverProps {
  /** Current committed value (source of truth). */
  value: number
  /** History-less mutation used per frame while the slider is dragged. */
  onPreview: (v: number) => void
  /**
   * Fires once on popover close if the value has changed since open.
   * The row's `withHistory` uses `valueOnOpen` as the beforePatch so
   * Undo rewinds past every preview mutation from the session.
   */
  onCommit: (value: number, valueOnOpen: number) => void
  disabled?: boolean
  ariaLabel: string
  /**
   * Optional extra classes for the trigger button so the row can
   * match the current passive `<span>` styling verbatim (number
   * only, tabular-nums, tint by entry frozen state, etc.).
   */
  triggerClassName?: string
  /**
   * True when the row is frozen (deleted / trim-deleted); the row
   * uses this to apply `opacity-40` on the trigger, mirroring the
   * previous static readout.
   */
  isFrozen?: boolean
}

function OverlayRegistrar(): null {
  useOverlayRegistration()
  return null
}

const NOOP_COMMIT = () => { /* boundary commit deliberately unused; see below */ }

/**
 * REQ-0222 — pure decision helper: on popover close, should the caller
 * push a history op?  Extracted so the "we only push history when
 * the user actually changed the value" contract can be pinned in a
 * unit test without spinning up React / Radix.
 *
 * Empty popover sessions (open → click outside without touching the
 * thumb) and no-op moves (slider drags back to its start value)
 * return false; genuine changes return true.  Same open-value
 * comparison the ColorPicker's OK/Cancel logic uses.
 */
export function shouldCommitOnClose(current: number, valueOnOpen: number): boolean {
  return current !== valueOnOpen
}

export function OutlineThicknessPopover({
  value,
  onPreview,
  onCommit,
  disabled,
  ariaLabel,
  triggerClassName,
  isFrozen,
}: OutlineThicknessPopoverProps) {
  const [open, setOpen] = useState(false)
  // Captured on open so the close-time diff can compare against a
  // stable pre-session anchor.  A ref (not state) because updates to
  // it must not force a re-render — the slider and the value readout
  // already do that themselves during the drag.
  const valueOnOpenRef = useRef<number>(value)

  function handleOpenChange(next: boolean) {
    if (next) {
      valueOnOpenRef.current = value
      setOpen(true)
      return
    }
    // Close path: parent pushes history only when the value has
    // genuinely changed since the session started.  Empty popover
    // sessions (open → click outside without touching the slider)
    // therefore leave `undo` untouched, matching the ColorPicker's
    // open-then-cancel semantic.
    const before = valueOnOpenRef.current
    if (shouldCommitOnClose(value, before)) {
      onCommit(value, before)
    }
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          title={ariaLabel}
          disabled={disabled}
          className={cn(
            // Same visual footprint as the pre-REQ-0222 static
            // `<span>` so the column width does not shift when
            // multiple rows switch between editable and frozen.
            'text-body-sm tabular-nums text-fg-secondary leading-none',
            'cursor-pointer rounded px-1 py-0.5 hover:bg-surface-2/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50',
            'disabled:cursor-not-allowed',
            isFrozen && 'opacity-40',
            triggerClassName,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {value}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="center"
        collisionPadding={8}
        className="w-52 p-3 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <OverlayRegistrar />
        <OutlineThicknessSlider
          value={value}
          onPreview={onPreview}
          // History-write boundary is the popover's `handleOpenChange`
          // above, NOT the slider's own drag-end.  `onPreview` already
          // writes the same field to the store per frame, and the
          // slider's internal `commit()` guard (`draft !== value`)
          // makes this callback effectively a no-op — but the prop is
          // required so we still supply a stable function reference.
          onCommit={NOOP_COMMIT}
          disabled={disabled}
          ariaLabel={ariaLabel}
          fullWidth
        />
      </PopoverContent>
    </Popover>
  )
}
