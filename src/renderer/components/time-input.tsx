import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { formatTimecode, parseTimecode } from '@/lib/time'
import { origToEdited, editedToOrig, type CutList } from '../../shared/cuts'

interface TimeInputProps {
  /** Original-axis time value (= what the SubtitleEntry stores). */
  value: number
  /**
   * Commit handler.  Receives the new ORIGINAL-axis time.  When `cuts`
   * is provided, the user types on the Edited axis and the callback
   * applies `editedToOrig` before invoking this; callers therefore
   * always store Original-axis values (= data-non-destructive contract).
   */
  onChange: (originalSec: number) => void
  /**
   * REQ-115 — when provided, the displayed text and the parsed user
   * input are interpreted on the EDITED axis.  Display: `origToEdited
   * (value, cuts)`.  Commit: `editedToOrig(parsed, cuts)` → onChange.
   * When omitted (default) the input shows / writes raw Original
   * values, which keeps every pre-REQ-115 call site bit-identical
   * (origToEdited / editedToOrig are the identity on an empty cuts
   * list anyway, so passing `cuts={[]}` is equivalent to omitting it).
   */
  cuts?: CutList
  className?: string
  disabled?: boolean
  /** When true, renders the value in red to indicate a timing conflict. */
  error?: boolean
  /** When true (and no error), renders the value in amber to indicate a warning. */
  warning?: boolean
  /** Native tooltip text shown on hover. Used to explain error/warning states. */
  title?: string
}

export function TimeInput({ value, onChange, cuts, className, disabled, error, warning, title }: TimeInputProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // REQ-115 — `displayed` is the Edited-axis projection of `value` when
  // `cuts` is provided, otherwise just `value` itself (= bit-identical
  // legacy path).
  const displayed = cuts !== undefined ? origToEdited(value, cuts) : value

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  function handleFocus() {
    setDraft(formatTimecode(displayed))
    setEditing(true)
  }

  function handleBlur() {
    commit()
  }

  // REQ-0128 Phase 1 — Enter commits the typed value, matching REQ-
  // 0127's DaVinci-style commit contract for every numeric input.
  // We route through blur so the existing parse + editedToOrig +
  // onChange path runs unchanged; the row-cell / TimeEditorDialog
  // callers rely on that path for their validation and history hooks.
  // REQ-082 previously removed the Enter handler; REQ-0128 reinstates
  // it in the "confirm the field, don't submit the dialog" flavour.
  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.currentTarget.blur()
    }
  }

  function commit() {
    const parsed = parseTimecode(draft)
    if (!isNaN(parsed) && parsed >= 0) {
      // REQ-115 — when cuts is provided, `parsed` is on the Edited axis
      // and must be inverse-mapped to Original before being persisted.
      // `editedToOrig` is monotonic so user-visible validations (start
      // ≤ end) carry over from Edited to Original automatically.
      const original = cuts !== undefined ? editedToOrig(parsed, cuts) : parsed
      onChange(original)
    }
    setEditing(false)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      disabled={disabled}
      value={editing ? draft : formatTimecode(displayed)}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      spellCheck={false}
      title={title}
      className={cn(
        // REQ-068 Phase C: width bumped 90 → 110 px to fit the now-14-px
        // (was 13) "HH:MM:SS.cc" tabular timecode without truncating the
        // trailing centiseconds.  text-body-sm kept here — the time
        // column ran out of room in the subtitle-table grid at 14 px.
        'h-7 w-[110px] rounded border border-line bg-surface-0 px-2 text-center font-mono tabular-nums text-body-sm',
        error ? 'text-destructive' : warning ? 'text-warning' : 'text-fg-primary',
        'transition-colors duration-150',
        'focus:outline-none focus-visible:border-line-strong focus-visible:ring-1 focus-visible:ring-primary/30',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
    />
  )
}
