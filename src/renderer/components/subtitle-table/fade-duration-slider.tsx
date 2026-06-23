import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import {
  FADE_DURATION_SEC_MAX,
  FADE_DURATION_SEC_MIN,
  FADE_DURATION_SEC_STEP,
} from '../../../shared/constants'

interface FadeDurationSliderProps {
  /**
   * Committed value in seconds.  `0` means **no fade** (the ASS writer
   * skips `\fad`, the preview rAF returns alpha 1).  `0.1`–`0.5` is the
   * symmetric in/out duration.  The right-side readout shows the literal
   * "OFF" for `0` so the user can distinguish "no fade" from "very short
   * fade".
   */
  value: number
  /**
   * Fires once per drag/keyboard gesture at the boundary
   * (mouseup / keyup / touchend) and only when the final draft differs
   * from `value`.  Keeps history pressure bounded to "one op per user
   * gesture" without per-onChange churn.
   */
  onCommit: (next: number) => void
  disabled?: boolean
  /** Required: native <input type=range> has no implicit label. */
  ariaLabel: string
  /**
   * When true the range track stretches to fill the parent flex cell
   * (`flex-1`), matching `OutlineThicknessSlider`'s `fullWidth` mode
   * used by the inspector / bulk-edit row layouts.  When false the
   * default `w-24` is used (suitable for the settings dialog grid).
   */
  fullWidth?: boolean
}

const STEPS = Math.round((FADE_DURATION_SEC_MAX - FADE_DURATION_SEC_MIN) / FADE_DURATION_SEC_STEP)

/**
 * REQ-20260615-050 — fade-duration slider shared by the inspector
 * (per-entry), the settings dialog (default for new entries), and the
 * bulk-edit bar (apply to selected entries).
 *
 * Visually matches `OutlineThicknessSlider` so the three fade surfaces
 * read as siblings: native `<input type=range>` with the primary accent
 * colour, a fixed-width right-side readout, and the same drag/commit
 * lifecycle.  The only difference is the readout swaps the numeric
 * literal for the word "OFF" at `0`.
 *
 * The component stores its draft as an INTEGER step index (0–5) so the
 * native range slider never has to grapple with float imprecision —
 * `0.1` + `0.2` is not `0.3` in IEEE-754, and that drift visibly snaps
 * the thumb past the step boundaries on drag.  The integer index is
 * mapped back to seconds at the commit boundary.
 */
export function FadeDurationSlider({
  value,
  onCommit,
  disabled,
  ariaLabel,
  fullWidth,
}: FadeDurationSliderProps) {
  const secondsToStep = (sec: number) =>
    Math.round((sec - FADE_DURATION_SEC_MIN) / FADE_DURATION_SEC_STEP)
  const stepToSeconds = (step: number) =>
    +(FADE_DURATION_SEC_MIN + step * FADE_DURATION_SEC_STEP).toFixed(1)

  const [draft, setDraft] = useState(secondsToStep(value))
  const interactingRef = useRef(false)

  useEffect(() => {
    if (interactingRef.current) return
    const incoming = secondsToStep(value)
    if (draft !== incoming) setDraft(incoming)
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
    const next = stepToSeconds(draft)
    if (next !== value) onCommit(next)
  }

  const seconds = stepToSeconds(draft)
  // "OFF" reads as a status label at 0; 0.1–0.5 shows the literal value
  // with one decimal so users can distinguish "very short" from "off".
  const readout = seconds <= 0 ? 'OFF' : `${seconds.toFixed(1)}s`

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
        max={STEPS}
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
      <span className="w-10 text-caption text-muted-foreground font-mono tabular-nums text-right">
        {readout}
      </span>
    </div>
  )
}
