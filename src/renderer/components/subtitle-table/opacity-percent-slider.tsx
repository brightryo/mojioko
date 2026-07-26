import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import {
  OPACITY_MIN_PERCENT,
  OPACITY_MAX_PERCENT,
  OPACITY_STEP_PERCENT,
} from '../../../shared/alpha'

interface OpacityPercentSliderProps {
  /**
   * Committed value driving the controlled thumb position.  When this changes
   * from the outside (undo, reset row, a sibling control updating the same
   * field) AND no interaction is in progress, the slider re-syncs its draft.
   */
  value: number
  /**
   * Fires exactly once per drag / keyboard interaction at the boundary
   * (mouseup / keyup / touchend), NEVER per `onChange` frame, and only when the
   * final draft differs from `value` — one history op per user gesture.
   */
  onCommit: (next: number) => void
  /**
   * Optional per-frame preview fired on every `onChange` during a drag, so the
   * video overlay updates live rather than only on release.
   */
  onPreview?: (next: number) => void
  disabled?: boolean
  /** Required: native `<input type=range>` has no implicit label. */
  ariaLabel: string
  /** When true, the range track stretches to fill the parent cell. */
  fullWidth?: boolean
}

/**
 * REQ-0310 §1 — 0–100 % opacity slider for the text fill and the outline.
 *
 * A deliberate clone of `ShadowDepthSlider` / `OutlineThicknessSlider` rather
 * than a generalisation of them: the three share an identical controlled-draft
 * lifecycle, and the codebase already treats that duplication as the cheaper
 * trade (see the note in `NumberStepperInput`).  The only real differences here
 * are the fixed 0–100 domain and the `%` suffix on the readout — REQ-0310 §1
 * requires the unit to be visible so the number is not read as a pixel value.
 *
 * The readout is `w-12` rather than the siblings' `w-10` because "100%" needs
 * the extra glyph; the bar still starts at the same X as the other sliders in
 * the same column, which is what REQ-20260615-061 B actually equalised.
 *
 * Generic over the caller's notion of "commit": it knows nothing about subtitle
 * entries, the history store, or bulk-apply mechanics.  0 % is a legal, fully
 * reachable value (REQ-0310 §2) — nothing here clamps it away.
 */
export function OpacityPercentSlider({
  value,
  onCommit,
  onPreview,
  disabled,
  ariaLabel,
  fullWidth,
}: OpacityPercentSliderProps) {
  const [draft, setDraft] = useState(value)

  // True while the user is mid-gesture (drag or keyboard hold).  Suppresses
  // parent → child resync so an external value change cannot snap the thumb
  // away from the user's hand.
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
        min={OPACITY_MIN_PERCENT}
        max={OPACITY_MAX_PERCENT}
        step={OPACITY_STEP_PERCENT}
        value={draft}
        onChange={handleChange}
        onMouseUp={commit}
        onKeyUp={commit}
        onTouchEnd={commit}
        disabled={disabled}
        className={cn(fullWidth ? 'flex-1 min-w-0' : 'w-24')}
        style={{ accentColor: 'hsl(var(--primary))' }}
        aria-label={ariaLabel}
      />
      <span className="w-12 text-caption text-muted-foreground font-mono tabular-nums text-right">
        {draft}%
      </span>
    </div>
  )
}
