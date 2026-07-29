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
   * when the final draft differs from the value the GESTURE STARTED AT.
   * This keeps history pressure bounded to "one op per user gesture"
   * without the caller needing its own debounce.
   *
   * REQ-0352 — `valueBeforeGesture` is that starting value.  A caller that
   * streams `onPreview` into the same store field this slider reads back
   * cannot recover it afterwards, so the slider reports it; use it as the
   * undo target.  Same contract as `ColorPicker.onCommit(hex, hexOnOpen)`.
   */
  onCommit: (next: number, valueBeforeGesture: number) => void
  /**
   * REQ-0222 — optional per-frame preview callback fired on every
   * `onChange` while the user drags the thumb (before `onCommit`
   * fires at drag boundary).  Enables surfaces that want the video
   * overlay / preview to update mid-drag rather than only on release
   * — the same live-preview pattern the ColorPicker already uses via
   * `onChange`.  Omitting the prop preserves the legacy commit-only
   * behavior byte-for-byte (Inspector's existing usage).
   */
  onPreview?: (next: number) => void
  disabled?: boolean
  /**
   * Required: native <input type=range> has no implicit label, so the
   * caller is responsible for providing one for screen readers.
   */
  ariaLabel: string
  /**
   * REQ-20260615-014: when true, the range track stretches to fill the
   * parent flex cell (`flex-1`) instead of the fixed `w-24` baseline used
   * by bulk-edit-bar / default-style-controls.  The inspector uses this
   * to consume the empty space between the label and the value readout.
   */
  fullWidth?: boolean
  /**
   * REQ-0344 §2-1 — lowest selectable thickness.  Defaults to 0 (no floor).
   *
   * Callers raise it to 1 when the row's background box is ON, because the
   * `BorderStyle=3` box IS the glyph outline grown by `\bord`: at `\bord0`
   * the box collapses into the glyph and the export carries no background at
   * all — measured as zero white pixels in the burn (RES-0340 §1-4).  So "BG
   * on, outline 0" is a combination that silently produces nothing, and the
   * cheapest cure is to stop offering it.
   *
   * This is a floor on what the user can SELECT, not a clamp on what is
   * stored.  A project saved with 0 keeps its 0 — rewriting it would change
   * that project's output, which is not this REQ's to do.  See `belowMin`
   * below for how that state is shown.
   */
  min?: number
  /**
   * Explains why `min` is raised, for the tooltip.  Required in spirit
   * whenever `min > 0`: a control that silently refuses a value the user
   * could pick a moment ago is worse than one that never offered it.
   */
  minReason?: string
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
  onPreview,
  disabled,
  ariaLabel,
  fullWidth,
  min = 0,
  minReason
}: OutlineThicknessSliderProps) {
  const [draft, setDraft] = useState(value)

  /**
   * REQ-0344 §2-1 — an already-stored value below the current floor.
   *
   * Reachable two ways, and deliberately NOT auto-corrected in either:
   *   - opening a project saved before this floor existed, and
   *   - turning the background box on while the outline is already 0.
   *
   * Both are shown rather than fixed.  Writing a new thickness the user did
   * not ask for would change what their video renders — the one thing this
   * REQ says not to do — and doing it on load would do it to every project
   * they open, silently.  So the readout states the real stored value and
   * marks it as the problem it is; the floor then applies the moment the user
   * touches the control, which is the first point they have actually asked
   * for a value.
   */
  const belowMin = draft < min

  // True while the user is mid-gesture (drag or keyboard hold).  Used for
  // two purposes:
  //   - Suppress the parent → child resync below so an external value
  //     change during a drag does not snap the thumb away from the user's
  //     hand.
  //   - Gate the commit fire so the boundary handlers only act when an
  //     interaction actually occurred (a stray onMouseUp / onKeyUp from
  //     focusing the input without dragging is a no-op).
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
        disabled && 'opacity-40 pointer-events-none'
      )}
      // The tooltip hangs off the whole row, not just the readout, so it is
      // reachable from wherever the pointer already is when the floor stops
      // the thumb.
      title={min > 0 ? minReason : undefined}
    >
      <input
        type="range"
        min={min}
        max={OUTLINE_THICKNESS_MAX_PX}
        step={1}
        value={draft}
        onChange={handleChange}
        onMouseUp={commit}
        onKeyUp={commit}
        onTouchEnd={commit}
        disabled={disabled}
        className={cn(fullWidth ? 'flex-1 min-w-0' : 'w-24')}
        // accent-color routes the native thumb/track tint through --primary
        // so the slider stays on-brand under any future theme without
        // hardcoding green-500.
        style={{ accentColor: 'hsl(var(--primary))' }}
        aria-label={ariaLabel}
      />
      {/* REQ-20260615-061 B — readout column widened from w-6 to w-10
          and right-aligned so it matches FadeDurationSlider's readout
          cell exactly.  Same readout footprint = both sliders' bars
          start and end at the same X within a shared row container. */}
      {/* REQ-0344 §2-1 — a stored value under the floor is shown as it really
          is, in the warning colour, so "my background box does not render"
          has something on screen to explain it. */}
      <span
        className={cn(
          'w-10 text-caption font-mono tabular-nums text-right',
          belowMin ? 'text-warning-soft' : 'text-muted-foreground'
        )}
      >
        {draft}
      </span>
    </div>
  )
}
