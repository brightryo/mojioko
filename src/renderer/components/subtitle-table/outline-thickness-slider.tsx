import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { OUTLINE_THICKNESS_MAX_PX } from '../../../shared/constants'

interface OutlineThicknessSliderProps {
  /**
   * Committed value driving the controlled thumb position.  Treated as the
   * source of truth: when this changes from the outside (undo, reset row,
   * a sibling control updating the same field) AND no interaction is in
   * progress, the slider re-syncs its internal draft to match.
   */
  value: number
  /**
   * Fires exactly once per drag / keyboard interaction at the boundary
   * (mouseup / keyup / touchend) — never per onChange frame — and only
   * when the final draft differs from the current `value`.  This keeps
   * history pressure bounded to "one op per user gesture" without the
   * caller needing its own debounce.
   */
  onCommit: (next: number) => void
  disabled?: boolean
  /**
   * Required: native <input type=range> has no implicit label, so the
   * caller is responsible for providing one for screen readers.
   */
  ariaLabel: string
}

/**
 * Numeric outline-thickness slider shared by Step 2's per-row editor and
 * its bulk-edit bar (and, in a follow-up, Step 1's transcription defaults).
 *
 * The component is intentionally generic over its caller's concept of
 * "commit": it does not know about subtitle entries, the history store, or
 * bulk-apply mechanics — the parent wires those up through `onCommit`.
 * Local draft state lets the user see live thumb movement during a drag
 * while the parent's store stays untouched until the gesture finishes.
 */
export function OutlineThicknessSlider({
  value,
  onCommit,
  disabled,
  ariaLabel
}: OutlineThicknessSliderProps) {
  const [draft, setDraft] = useState(value)

  // True while the user is mid-gesture (drag or keyboard hold).  Used for
  // two purposes:
  //   - Suppress the parent → child resync below so an external value
  //     change during a drag does not snap the thumb away from the user's
  //     hand.
  //   - Gate the commit fire so the boundary handlers only act when an
  //     interaction actually occurred (a stray onMouseUp / onKeyUp from
  //     focusing the input without dragging is a no-op).
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
        disabled && 'opacity-40 pointer-events-none'
      )}
    >
      <input
        type="range"
        min={0}
        max={OUTLINE_THICKNESS_MAX_PX}
        step={1}
        value={draft}
        onChange={handleChange}
        onMouseUp={commit}
        onKeyUp={commit}
        onTouchEnd={commit}
        disabled={disabled}
        className="w-24"
        // accent-color routes the native thumb/track tint through --primary
        // so the slider stays on-brand under any future theme without
        // hardcoding green-500.
        style={{ accentColor: 'hsl(var(--primary))' }}
        aria-label={ariaLabel}
      />
      <span className="w-6 text-caption text-muted-foreground font-mono tabular-nums">
        {draft}
      </span>
    </div>
  )
}
