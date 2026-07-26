import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  resolveEmphasisSpans,
  spansFromSelection,
  selectionFromRanges,
  type EmphasisSpan,
} from '../../../shared/emphasis'

/**
 * REQ-0307 §1 — per-character emphasis picker.
 *
 * ## Why a dialog of character buttons
 *
 * REQ-0306 let the user name a *keyword* and emphasised every occurrence of it
 * in the cue.  The owner's objection: a cue that says the same word twice had
 * no way to emphasise just one of them.  Selecting characters directly removes
 * the ambiguity at the source — what you click is exactly what is emphasised,
 * and the stored span (offsets + anchor) preserves that choice through later
 * text edits.
 *
 * ## Cell model
 *
 * The cue text is walked by code point.  Every code point except the two-
 * character `\N` hard-break sentinel becomes one clickable CELL carrying its
 * code-unit offset into the cue text; `\N` becomes a row break instead, so the
 * dialog shows the same line layout the burn-in will produce, and a selection
 * can never straddle a line break (which would put a backslash in the anchor).
 *
 * Selection state is the set of selected cell offsets.  It is converted to
 * spans only on Apply (`spansFromSelection` merges physically adjacent cells
 * into one span), which keeps the whole edit a single undo entry.
 *
 * ## Range selection (REQ-0307 §1, "推奨")
 *
 * Both affordances the REQ suggested are implemented, because a long cue is
 * painful to click one character at a time:
 *   - **drag**: press on a cell and sweep.  The press decides the mode — start
 *     on an unselected cell and the sweep selects; start on a selected one and
 *     it deselects.  (Same convention as a spreadsheet's checkbox drag.)
 *   - **shift+click**: extends from the last-touched cell to the clicked one.
 */
interface EmphasisPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The cue text, `\N` sentinels included. */
  text: string
  /** Currently stored spans (may be undefined / legacy-migrated by the caller). */
  spans: readonly EmphasisSpan[] | undefined
  /** Emphasis colour, used to preview selected cells. */
  colorHex: string
  /** Emphasis size percent, used to preview selected cells. */
  scalePercent: number
  /** Commit — receives the new span list (possibly empty). */
  onCommit: (spans: EmphasisSpan[]) => void
}

export interface EmphasisPickerCell {
  /** Code-unit offset into the cue text. */
  start: number
  /** Code-unit length (2 for a surrogate pair). */
  length: number
  char: string
  /** Position in the flat cell list — the axis shift+click / drag work on. */
  index: number
}

/**
 * REQ-0307 §1 — split the cue text into the dialog's rows of character cells.
 *
 * Exported so the contract can be unit-tested without mounting React (the
 * repo's convention for logic that lives in a `.tsx`):
 *   - one cell per CODE POINT, so a surrogate pair is a single button and
 *     `start`/`length` stay valid code-unit slice offsets;
 *   - the two-character `\N` sentinel is NOT a cell — it starts a new row, so
 *     the dialog mirrors the burn-in's line structure and no selection can
 *     ever put a backslash inside a span anchor.
 */
export function buildEmphasisPickerLines(text: string): EmphasisPickerCell[][] {
  const lines: EmphasisPickerCell[][] = [[]]
  let i = 0
  let index = 0
  while (i < text.length) {
    if (text[i] === '\\' && text[i + 1] === 'N') {
      lines.push([])
      i += 2
      continue
    }
    const cp = text.codePointAt(i)!
    const length = cp > 0xffff ? 2 : 1
    lines[lines.length - 1].push({ start: i, length, char: text.substr(i, length), index })
    index++
    i += length
  }
  return lines
}

export function EmphasisPickerDialog({
  open,
  onOpenChange,
  text,
  spans,
  colorHex,
  scalePercent,
  onCommit,
}: EmphasisPickerDialogProps) {
  const { t } = useTranslation(['step2', 'common'])

  const lines = useMemo(() => buildEmphasisPickerLines(text), [text])
  const cells = useMemo(() => lines.flat(), [lines])

  const [selected, setSelected] = useState<Set<number>>(new Set())
  // Index into `cells` of the last cell the user touched — the anchor for
  // shift+click range extension.
  const lastTouchedRef = useRef<number | null>(null)
  // Non-null while a drag is in progress; `true` = the sweep selects.
  const dragModeRef = useRef<boolean | null>(null)

  // Seed the selection from the stored spans on each OPEN transition, using
  // React's "adjust state during render" pattern rather than an effect.
  // Resolution runs here too, so a span that no longer resolves (text edited
  // since it was made) simply doesn't come back pre-selected.
  //
  // The trigger is the false→true edge specifically, NOT the prop values:
  // `spans` is a freshly-resolved array on every parent render, so seeding
  // whenever it changes identity would wipe the user's clicks mid-edit.
  const [seeded, setSeeded] = useState(false)
  if (open && !seeded) {
    setSeeded(true)
    setSelected(selectionFromRanges(cells, resolveEmphasisSpans(text, spans).ranges))
    lastTouchedRef.current = null
  } else if (!open && seeded) {
    setSeeded(false)
  }

  // A drag that ends outside the grid still has to clear the mode, otherwise
  // the next hover would keep painting.
  useEffect(() => {
    if (!open) return
    const end = (): void => {
      dragModeRef.current = null
    }
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    return () => {
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
  }, [open])

  const applyTo = useCallback((indices: number[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const idx of indices) {
        const cell = cells[idx]
        if (!cell) continue
        if (on) next.add(cell.start)
        else next.delete(cell.start)
      }
      return next
    })
  }, [cells])

  function handlePointerDown(cellIndex: number, shiftKey: boolean): void {
    const cell = cells[cellIndex]
    if (!cell) return
    if (shiftKey && lastTouchedRef.current !== null) {
      // Range extend — the whole run takes the state the ANCHOR cell will
      // have, so shift-clicking twice in a row is idempotent rather than
      // flip-flopping the middle of the range.
      const from = Math.min(lastTouchedRef.current, cellIndex)
      const to = Math.max(lastTouchedRef.current, cellIndex)
      const on = !selected.has(cell.start)
      const run: number[] = []
      for (let i = from; i <= to; i++) run.push(i)
      applyTo(run, on)
      lastTouchedRef.current = cellIndex
      return
    }
    const on = !selected.has(cell.start)
    dragModeRef.current = on
    applyTo([cellIndex], on)
    lastTouchedRef.current = cellIndex
  }

  function handlePointerEnter(cellIndex: number): void {
    if (dragModeRef.current === null) return
    applyTo([cellIndex], dragModeRef.current)
    lastTouchedRef.current = cellIndex
  }

  function handleApply(): void {
    onCommit(spansFromSelection(text, cells, selected))
    onOpenChange(false)
  }

  // REQ-0308 §4-4 — no `Math.max(1, …)` floor any more: emphasis can shrink a
  // span (50–200 %), and the picker must show that faithfully or the user picks
  // characters against a preview that lies about the result.
  const emphasisEm = scalePercent / 100

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('step2:emphasisPicker.title')}</DialogTitle>
          <DialogDescription>{t('step2:emphasisPicker.description')}</DialogDescription>
        </DialogHeader>

        {/* The character grid.  `select-none` + `touch-none` so a sweep does
            not turn into a native text selection or a scroll gesture. */}
        <div
          className="max-h-[45vh] select-none touch-none overflow-y-auto rounded-lg border border-line-strong bg-surface-0 p-3"
          role="group"
          aria-label={t('step2:emphasisPicker.title')}
        >
          {cells.length === 0 ? (
            <p className="py-6 text-center text-caption text-fg-secondary">
              {t('step2:emphasisPicker.emptyText')}
            </p>
          ) : (
            lines.map((line, li) => (
              // One row per `\N`-delimited line, so the dialog mirrors the
              // burn-in's line structure.  `items-end` keeps the baseline
              // steady when a selected cell grows.
              <div key={li} className="flex flex-wrap items-end gap-0.5 py-1">
                {line.length === 0 ? (
                  <span className="text-caption text-fg-secondary/60">
                    {t('step2:emphasisPicker.emptyLine')}
                  </span>
                ) : (
                  line.map((cell) => {
                    const idx = cell.index
                    const on = selected.has(cell.start)
                    return (
                      <button
                        key={cell.start}
                        type="button"
                        aria-pressed={on}
                        aria-label={cell.char === ' ' ? t('step2:emphasisPicker.spaceChar') : cell.char}
                        onPointerDown={(e) => {
                          e.preventDefault()
                          handlePointerDown(idx, e.shiftKey)
                        }}
                        onPointerEnter={() => handlePointerEnter(idx)}
                        className={cn(
                          'min-w-[1.6rem] rounded-[3px] border px-1 py-1 text-center text-body leading-none transition-colors duration-150',
                          'focus:outline-none focus-visible:outline-none',
                          on
                            ? 'border-primary bg-primary/15 font-semibold'
                            : 'border-line-strong bg-surface-1 text-fg-primary hover:bg-surface-2',
                        )}
                        style={on ? { color: colorHex, fontSize: `${emphasisEm}em` } : undefined}
                      >
                        {/* A literal space would collapse to a zero-width
                            button, so render it as a visible middle dot. */}
                        {cell.char === ' ' ? '␣' : cell.char}
                      </button>
                    )
                  })
                )}
              </div>
            ))
          )}
        </div>

        {/* REQ-0308 §2 — tell the user what an edit does to their selection.
            The wording matches `resolveEmphasisSpans` exactly (verified against
            it): a span is re-anchored whenever its text is still uniquely
            findable, and dropped only when that text is gone, rewritten, or has
            become ambiguous.  Deliberately not phrased as "editing clears
            emphasis" — that would be wrong in the common case and would push
            users into avoiding edits they can safely make. */}
        <p className="text-caption leading-relaxed text-fg-secondary">
          <span className="font-medium text-fg-primary">
            {t('step2:emphasisPicker.editNoteLabel')}
          </span>
          {' — '}
          {t('step2:emphasisPicker.editNote')}
        </p>

        <div className="flex items-center justify-between gap-2">
          <span className="text-caption text-fg-secondary">
            {t('step2:emphasisPicker.selectedCount', { count: selected.size })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            {t('step2:emphasisPicker.clear')}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="lg" onClick={() => onOpenChange(false)}>
            {t('common:action.cancel')}
          </Button>
          <Button type="button" variant="primary" size="lg" onClick={handleApply}>
            {t('common:action.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
