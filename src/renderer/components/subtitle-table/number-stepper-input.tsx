import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

interface NumberStepperInputProps {
  /** Committed value (controlled). */
  value: number
  /** Inclusive lower bound. */
  min: number
  /** Inclusive upper bound. */
  max: number
  /** Increment per stepper click (±). */
  step: number
  /**
   * Fires when the stepper buttons OR a direct-typed value commits.
   * Direct typing commits on blur; out-of-range typed values clamp
   * before they reach this callback (`[min, max]`).
   */
  onCommit: (next: number) => void
  disabled?: boolean
  /**
   * Required: screen-reader label for the number input.  The buttons
   * append "−N" / "+N" automatically so each control has a distinct
   * accessible name.
   */
  ariaLabel: string
  /** Optional native title (e.g. range hint for hover tooltip). */
  title?: string
  /**
   * Visually flags the field while a typed value is out of range
   * (`true` swaps the focus ring + border to the warning tone).
   * The parent owns the flag because the validation message and
   * commit timing belong to the parent's history op.
   */
  outOfRange?: boolean
}

/**
 * REQ-20260615-017 / REQ-20260615-059 B — shared `±N` chevron-flanked
 * number input.  Lifted from the inspector's font-size stepper so the
 * same shape can drive every numeric inspector / bulk-edit field
 * (size / margin / background opacity).  Direct typing keeps working
 * (the inner `<input>` has its own `onChange` / `onBlur` lifecycle
 * via the parent's existing handlers); the buttons emit one
 * `onCommit` per click with the value already clamped to `[min, max]`.
 *
 * Layout matches the inspector's original inline form: `h-7` chevron
 * buttons with `border-line-strong` + neutral hover, `w-14 h-7`
 * number input, all aligned `gap-1`.  Keep them in lock-step so the
 * three new sites (inspector margin, inspector bg opacity, bulk size /
 * margin / bg opacity) read as siblings of the original size stepper.
 */
export function NumberStepperInput({
  value,
  min,
  max,
  step,
  onCommit,
  disabled,
  ariaLabel,
  title,
  outOfRange,
}: NumberStepperInputProps) {
  function clamp(n: number): number {
    return Math.min(max, Math.max(min, n))
  }

  function handleStep(delta: number) {
    const next = clamp(value + delta)
    if (next === value) return
    onCommit(next)
  }

  function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const raw = parseInt(e.target.value, 10)
    if (isNaN(raw)) return
    const next = clamp(raw)
    if (next === value) {
      // Restore the on-screen text to the committed value so a
      // typed "999" past the cap snaps back to e.g. "100" visibly.
      e.target.value = String(value)
      return
    }
    onCommit(next)
  }

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => handleStep(-step)}
        disabled={disabled || value <= min}
        aria-label={`${ariaLabel} −${step}`}
        className={cn(
          'h-7 w-6 inline-flex items-center justify-center rounded border border-line-strong bg-surface-0 text-fg-secondary',
          'hover:text-fg-primary hover:bg-surface-2 transition-colors duration-150',
          'focus:outline-none focus-visible:outline-none',
          'disabled:opacity-40 disabled:cursor-not-allowed',
        )}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        // `key={value}` resets the uncontrolled value on every committed
        // change so undo / external updates show through.  Matches the
        // pattern the existing inspector inputs already use.
        key={value}
        defaultValue={value}
        onBlur={handleBlur}
        disabled={disabled}
        title={title}
        aria-label={ariaLabel}
        className={cn(
          'w-14 h-7 rounded border bg-surface-0 px-1.5 text-center text-body text-fg-primary',
          'focus:outline-none focus-visible:ring-1',
          '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          outOfRange
            ? 'border-warning-soft/60 focus-visible:ring-warning-soft/30'
            : 'border-line-strong focus-visible:border-surface-4 focus-visible:ring-primary/30',
        )}
      />
      <button
        type="button"
        onClick={() => handleStep(step)}
        disabled={disabled || value >= max}
        aria-label={`${ariaLabel} +${step}`}
        className={cn(
          'h-7 w-6 inline-flex items-center justify-center rounded border border-line-strong bg-surface-0 text-fg-secondary',
          'hover:text-fg-primary hover:bg-surface-2 transition-colors duration-150',
          'focus:outline-none focus-visible:outline-none',
          'disabled:opacity-40 disabled:cursor-not-allowed',
        )}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
