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
        // REQ-0311 §1 — `min-w-0` is load-bearing, not decoration.  When this
        // root sits in a flex ROW beside the colour swatch (inspector + bulk
        // bar), `w-full` gives it a base size of the whole control column, so
        // it must shrink by swatch+gap to fit.  Without `min-w-0` its automatic
        // minimum size is its min-content (~129px intrinsic range + gap + 48px
        // readout ≈ 183px), it refuses to shrink at all, and the 32px excess is
        // cut off by the inspector's `overflow-x-hidden` — which ate all but
        // the "1" of "100%".  Measured before/after in
        // tests/e2e/inspector-opacity-fit.spec.ts at the 1280x820 startup size.
        fullWidth && 'w-full min-w-0',
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
      {/* REQ-0311 §1 — `shrink-0` so any remaining deficit is taken out of the
          range track (which has `min-w-0`) instead of the readout.  The readout
          is `text-right`, so losing width here truncates from the LEFT and
          "100%" degrades to "1" — the exact reported symptom. */}
      <span className="w-12 shrink-0 text-caption text-muted-foreground font-mono tabular-nums text-right">
        {draft}%
      </span>
    </div>
  )
}
