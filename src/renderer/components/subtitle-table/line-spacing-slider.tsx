import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  LINE_SPACING_MIN_PERCENT,
  LINE_SPACING_MAX_PERCENT,
  LINE_SPACING_STEP_PERCENT,
} from '../../../shared/line-spacing'

interface LineSpacingSliderProps {
  /**
   * Committed value driving the controlled thumb position.  When this
   * changes from the outside (undo, reset row, a sibling control
   * updating the same field) AND no interaction is in progress, the
   * slider re-syncs its internal draft to match.
   */
  value: number
  /**
   * Fires exactly once per drag / keyboard interaction at the boundary
   * (mouseup / keyup / touchend), NEVER per onChange frame, and only when
   * the final draft differs from the current `value`.  Keeps history
   * pressure bounded to "one op per user gesture".
   */
  onCommit: (next: number) => void
  /** Per-frame callback while dragging, so the video overlay tracks the thumb. */
  onPreview?: (next: number) => void
  disabled?: boolean
  /** Required: native <input type=range> has no implicit label. */
  ariaLabel: string
  /** When true, the range track stretches to fill the parent cell. */
  fullWidth?: boolean
}

/**
 * REQ-0332 §5 — line spacing (行間) slider for the レイアウト section, shared
 * by the Step 2 inspector, the bulk-edit bar and the settings' default style
 * panel.
 *
 * A direct clone of `ShadowDepthSlider`'s controlled/draft pattern; only the
 * range differs, and the range is SIGNED — the owner's motivation for the
 * feature is Latin fonts sitting too far apart, i.e. tightening, so negative
 * values are the point rather than an afterthought.  The readout therefore
 * carries an explicit sign and a `%` so "−25" cannot be misread as pixels.
 *
 * The component deliberately knows nothing about subtitle entries, the
 * history store or bulk-apply mechanics — the parent wires those through
 * `onCommit`, exactly as its siblings do.
 */
export function LineSpacingSlider({
  value,
  onCommit,
  onPreview,
  disabled,
  ariaLabel,
  fullWidth,
}: LineSpacingSliderProps) {
  const [draft, setDraft] = useState(value)

  // True while the user is mid-gesture (drag or keyboard hold).
  // Suppresses parent → child resync during a drag so an external
  // value change doesn't snap the thumb away from the user's hand.
  const interactingRef = useRef(false)

  useEffect(() => {
    if (interactingRef.current) return
    if (draft !== value) setDraft(value)
  }, [value, draft])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10)
    if (isNaN(v)) return
    setDraft(v)
    interactingRef.current = true
    onPreview?.(v)
  }

  function commit() {
    if (!interactingRef.current) return
    interactingRef.current = false
    if (draft !== value) onCommit(draft)
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1.5',
        fullWidth && 'w-full',
        disabled && 'opacity-40 pointer-events-none',
      )}
    >
      <input
        type="range"
        min={LINE_SPACING_MIN_PERCENT}
        max={LINE_SPACING_MAX_PERCENT}
        step={LINE_SPACING_STEP_PERCENT}
        value={draft}
        onChange={handleChange}
        onMouseUp={commit}
        onKeyUp={commit}
        onTouchEnd={commit}
        disabled={disabled}
        className={cn(fullWidth ? 'flex-1 min-w-0' : 'w-24')}
        // REQ-0331 found `accent-accent` resolves to the near-black `--accent`
        // token, which makes the thumb invisible on the dark surface.  The
        // sibling sliders all use this inline form; matching it exactly is
        // what makes the row read as one of them.
        style={{ accentColor: 'hsl(var(--primary))' }}
        aria-label={ariaLabel}
      />
      {/* REQ-0421 (step2) — slider readout caption → body-sm. */}
      <span className="w-12 text-body-sm text-fg-secondary font-mono tabular-nums text-right">
        {draft > 0 ? `+${draft}%` : `${draft}%`}
      </span>
    </div>
  )
}
