import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { SHADOW_DEPTH_MAX_PX } from '../../../shared/constants'

interface ShadowDepthSliderProps {
  /**
   * Committed value driving the controlled thumb position.  When this
   * changes from the outside (undo, reset row, a sibling control
   * updating the same field) AND no interaction is in progress, the
   * slider re-syncs its internal draft to match.
   */
  value: number
  /**
   * Fires exactly once per drag / keyboard interaction at the
   * boundary (mouseup / keyup / touchend), NEVER per onChange frame,
   * and only when the final draft differs from the current `value`.
   * Keeps history pressure bounded to "one op per user gesture".
   */
  onCommit: (next: number, valueBeforeGesture: number) => void
  /**
   * Optional per-frame preview callback fired on every `onChange`
   * while the user drags the thumb (before `onCommit` fires at drag
   * boundary).  Enables the video overlay preview to update mid-drag
   * rather than only on release, mirroring `OutlineThicknessSlider`.
   */
  onPreview?: (next: number) => void
  disabled?: boolean
  /** Required: native <input type=range> has no implicit label. */
  ariaLabel: string
  /** When true, the range track stretches to fill the parent cell. */
  fullWidth?: boolean
}

/**
 * REQ-0292 §1 — shadow depth slider shared by Step 2's per-row
 * inspector and its bulk-edit bar.  Direct clone of the outline-
 * thickness slider's controlled/draft pattern; only the max range
 * differs (`SHADOW_DEPTH_MAX_PX = 100`).
 *
 * Why a slider (not the previous NumberStepperInput):
 *   - Users want to compare shadow depths visually across the full
 *     0–100 range without clicking `< >` 100 times.
 *   - Matches the outline-thickness and fade sliders already in the
 *     inspector so the shadow row reads as a sibling instead of an
 *     odd numeric field.
 *
 * The component is intentionally generic over its caller's concept
 * of "commit": it does not know about subtitle entries, the history
 * store, or bulk-apply mechanics — the parent wires those up
 * through `onCommit`.  Local draft state lets the user see live
 * thumb movement during a drag while the parent's store stays
 * untouched until the gesture finishes.
 */
export function ShadowDepthSlider({
  value,
  onCommit,
  onPreview,
  disabled,
  ariaLabel,
  fullWidth,
}: ShadowDepthSliderProps) {
  const [draft, setDraft] = useState(value)

  // True while the user is mid-gesture (drag or keyboard hold).
  // Suppresses parent → child resync during a drag so an external
  // value change doesn't snap the thumb away from the user's hand.
  const interactingRef = useRef(false)
  /** Value at the start of the current drag; null between gestures. */
  const gestureStartRef = useRef<number | null>(null)

  useEffect(() => {
    if (interactingRef.current) return
    if (draft !== value) setDraft(value)
  }, [value, draft])

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = parseInt(e.target.value, 10)
    if (isNaN(v)) return
    // REQ-0352 §2-1 — remember the value this gesture STARTED from, before
    // any preview write reaches the store.  See `commit()`.
    if (gestureStartRef.current === null) gestureStartRef.current = value
    setDraft(v)
    interactingRef.current = true
    onPreview?.(v)
  }

  /**
   * REQ-0352 §2-1 — compare against the value this GESTURE started from, not
   * the live prop.
   *
   * When the parent wires `onPreview` to a store write and binds `value` to
   * that same store field (the inspector does both), the preview stream has
   * already moved `value` to the dragged-to number by the time the pointer is
   * released.  `draft !== value` was then false and `onCommit` never fired —
   * so no history entry was pushed at all and Undo stayed disabled.  That is
   * the reported shadow bug, and the two opacity sliders had it too.
   *
   * The pre-gesture value is also handed to `onCommit` as a second argument,
   * the same contract `ColorPicker.onCommit(hex, hexOnOpen)` already uses, so
   * the caller has a correct undo target even though the store no longer
   * holds one.
   */
  function commit() {
    if (!interactingRef.current) return
    interactingRef.current = false
    const before = gestureStartRef.current ?? value
    gestureStartRef.current = null
    if (draft !== before) onCommit(draft, before)
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
        min={0}
        max={SHADOW_DEPTH_MAX_PX}
        step={1}
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
      {/* REQ-0421 (step2) — slider readout caption → body-sm. */}
      <span className="w-10 text-body-sm text-fg-secondary font-mono tabular-nums text-right">
        {draft}
      </span>
    </div>
  )
}
