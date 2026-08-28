import { cn } from '@/lib/utils'

/**
 * REQ-0298 §4-1 — shared segment-group control extracted from the
 * inspector so the settings 「字幕スタイル」 tab (DefaultStyleControls)
 * can use the exact same visual for horizontal / vertical position
 * pickers.  Previously each surface reimplemented the segmented
 * button row with slightly different classes, so the settings tab's
 * H/V rows looked subtly different from the inspector's.
 *
 * Selected pill uses `bg-primary text-fg-inverse` (green fill, white
 * text — same as inspector's radio pill).  Unselected uses
 * `text-fg-secondary hover:text-fg-primary hover:bg-surface-2` for a
 * subtle hover affordance.
 *
 * The outer track is `h-7 w-[40%] min-w-fit` in the inspector so it
 * fills roughly half the inspector column; DefaultStyleControls sets
 * its own outer width via `CONTROL_COL_CLASS` and doesn't need the
 * `w-[40%]` behaviour.  A `fullWidth` prop toggles between the two
 * (default false = inspector shape).
 */
export function SegmentGroup<T extends string>({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  fullWidth,
}: {
  value: T | null | undefined
  onChange: (next: T) => void
  options: ReadonlyArray<{ value: T; label: string }>
  disabled?: boolean
  ariaLabel: string
  /** When true, the outer track uses `w-full` instead of `w-[40%]`. */
  fullWidth?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'flex h-7 min-w-fit items-stretch gap-0.5 rounded-md border border-line-strong bg-surface-0 p-0.5',
        fullWidth ? 'w-full' : 'w-[40%]',
        disabled && 'opacity-40 pointer-events-none',
      )}
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              // REQ-0421 (step2) — overlay reassignment: segment buttons (整列 左/中央/右・上/中央/下 + 黒/白 preset) caption → body-sm.
              'flex-1 inline-flex items-center justify-center rounded-[3px] px-2 text-body-sm font-medium transition-colors duration-150',
              'focus:outline-none focus-visible:outline-none',
              selected
                ? 'bg-primary text-fg-inverse'
                : 'text-fg-secondary hover:text-fg-primary hover:bg-surface-2',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
