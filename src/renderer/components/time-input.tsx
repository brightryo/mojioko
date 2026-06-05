import { useState, useRef, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { formatTimecode, parseTimecode } from '@/lib/time'

interface TimeInputProps {
  value: number
  onChange: (seconds: number) => void
  className?: string
  disabled?: boolean
  /** When true, renders the value in red to indicate a timing conflict. */
  error?: boolean
  /** When true (and no error), renders the value in amber to indicate a warning. */
  warning?: boolean
  /** Native tooltip text shown on hover. Used to explain error/warning states. */
  title?: string
}

export function TimeInput({ value, onChange, className, disabled, error, warning, title }: TimeInputProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  function handleFocus() {
    setDraft(formatTimecode(value))
    setEditing(true)
  }

  function handleBlur() {
    commit()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      commit()
      inputRef.current?.blur()
    } else if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  function commit() {
    const parsed = parseTimecode(draft)
    if (!isNaN(parsed) && parsed >= 0) onChange(parsed)
    setEditing(false)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      disabled={disabled}
      value={editing ? draft : formatTimecode(value)}
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
        'h-7 w-[110px] rounded border border-zinc-800 bg-zinc-950 px-2 text-center font-mono tabular-nums text-body-sm',
        error ? 'text-red-500' : warning ? 'text-amber-500' : 'text-zinc-100',
        'transition-colors duration-150',
        'focus:outline-none focus:border-zinc-700 focus:ring-1 focus:ring-green-500/30',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className
      )}
    />
  )
}
