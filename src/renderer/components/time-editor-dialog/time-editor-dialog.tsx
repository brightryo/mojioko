import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Play, SkipBack, SkipForward } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { TimeInput } from '@/components/time-input'
import { cn } from '@/lib/utils'

export type TimeEditorMode = 'add' | 'edit'

export interface TimeEditorDialogProps {
  open: boolean
  mode: TimeEditorMode
  initialStartSec: number
  initialEndSec: number
  /** Start time of the active row immediately BEFORE the focused/edited row. */
  prevEntryStartSec: number | null
  /** End time of the active row immediately BEFORE the focused/edited row. */
  prevEntryEndSec: number | null
  /** Start time of the active row immediately AFTER the focused/edited row. */
  nextEntryStartSec: number | null
  /** End time of the active row immediately AFTER the focused/edited row. */
  nextEntryEndSec: number | null
  /** Focused row's startSec — drives the "set from selected row start" button (add mode only). */
  selectedEntryStartSec: number | null
  /** Focused row's endSec — drives the "set from selected row end" button (add mode only). */
  selectedEntryEndSec: number | null
  videoDurationSec: number
  /** Current playback position. `null` when the video preview is disabled. */
  videoCurrentTimeSec: number | null
  onConfirm: (startSec: number, endSec: number) => void
  onCancel: () => void
}

/**
 * Round to 2 decimal places (centiseconds).  Required because successive
 * floating-point additions of 0.1 produce values like 4.700000000000001,
 * which would display as ".70" but compare unequal to an explicit 4.70.
 */
function roundCs(sec: number): number {
  return Math.round(sec * 100) / 100
}

/**
 * Press-and-hold stepper.  Single click → one step.  Hold → first step fires
 * immediately, then repeats every {@link REPEAT_INTERVAL_MS} after a brief
 * initial delay (so a quick click does not register as a hold).
 */
const HOLD_DELAY_MS = 350
const REPEAT_INTERVAL_MS = 200

interface StepperButtonProps {
  label: string
  onStep: () => void
  ariaLabel?: string
}

function StepperButton({ label, onStep, ariaLabel }: StepperButtonProps) {
  const repeatTimerRef = useRef<number | null>(null)
  const holdTimerRef = useRef<number | null>(null)

  const stop = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (repeatTimerRef.current !== null) {
      window.clearInterval(repeatTimerRef.current)
      repeatTimerRef.current = null
    }
  }, [])

  const start = useCallback(() => {
    onStep()
    holdTimerRef.current = window.setTimeout(() => {
      repeatTimerRef.current = window.setInterval(onStep, REPEAT_INTERVAL_MS)
    }, HOLD_DELAY_MS)
  }, [onStep])

  useEffect(() => stop, [stop])

  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      onMouseDown={(e) => { e.preventDefault(); start() }}
      onMouseUp={stop}
      onMouseLeave={stop}
      onTouchStart={(e) => { e.preventDefault(); start() }}
      onTouchEnd={stop}
      onTouchCancel={stop}
      className={cn(
        'inline-flex items-center justify-center',
        // REQ-071 Phase 3.7-B: stepper labels ('-1s', '-0.1s' etc.) lifted
        // text-body-sm (13) -> text-body (15) so the ±delta digits are at the
        // same scale as the TimeInput field they drive.  h-9 (36 px) with
        // body line-h 22 still leaves 14 px of vertical breathing room.
        'h-9 px-2.5 rounded-md text-body font-mono tabular-nums select-none',
        'bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-50',
        'active:bg-zinc-600 transition-colors duration-100',
        'border border-zinc-800'
      )}
    >
      {label}
    </button>
  )
}

/**
 * One quick-set action below the stepper row.  The icon is optional — the
 * "selected row start/end" buttons use a transparent placeholder so their
 * text aligns visually with the icon-prefixed playhead / prev / next buttons.
 */
interface SnapButtonProps {
  icon?: React.ReactNode
  label: string
  trailingLabel: string
  onClick: () => void
}

function SnapButton({ icon, label, trailingLabel, onClick }: SnapButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border border-zinc-800',
        'bg-zinc-950/40 px-3 py-1.5 text-left',
        'hover:bg-zinc-800/40 hover:border-zinc-700',
        'transition-colors duration-100'
      )}
    >
      <span className="flex h-3.5 w-3.5 items-center justify-center flex-shrink-0 text-zinc-400">
        {icon}
      </span>
      <span className="text-body-sm text-zinc-200">{label}</span>
      {/* REQ-071 Phase 3.7-B: trailing timecode lifted text-caption (12) ->
          text-body-sm (13) — these are time *values* the user reads to
          decide whether to snap, not chrome.  Same micro-to-readable
          stance the timeline ruler took in Phase 3.6. */}
      <span className="ml-auto text-body-sm font-mono tabular-nums text-zinc-400">
        {trailingLabel}
      </span>
    </button>
  )
}

/** Tagged union describing every snap target a TimeField may render. */
type SnapItem =
  | { kind: 'prevStart'; sec: number }
  | { kind: 'prevEnd'; sec: number }
  | { kind: 'nextStart'; sec: number }
  | { kind: 'nextEnd'; sec: number }
  | { kind: 'selectedStart'; sec: number }
  | { kind: 'selectedEnd'; sec: number }

interface TimeFieldProps {
  labelKey: string
  valueSec: number
  onDelta: (deltaSec: number) => void
  /** Live playhead value — `null` to hide the "set from playhead" action. */
  playheadSec: number | null
  /** Set the field directly to a fixed seconds value (from TimeInput edits or snap clicks). */
  onSetSec: (sec: number) => void
  /** Snap buttons rendered below the playhead row, in array order. */
  snapItems: SnapItem[]
}

function TimeField({ labelKey, valueSec, onDelta, playheadSec, onSetSec, snapItems }: TimeFieldProps) {
  const { t } = useTranslation(['step2'])

  function formatHHMMSSCC(sec: number): string {
    const total = Math.max(0, sec)
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = Math.floor(total % 60)
    const cs = Math.floor((total - Math.floor(total)) * 100 + 1e-6)
    return (
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0') + '.' +
      String(cs).padStart(2, '0')
    )
  }

  return (
    <div className="space-y-2">
      {/* REQ-071 Phase 3.7-B: section label ('開始時間' / '終了時間') is the
          structural divider between the two TimeFields inside the dialog —
          promote from body-sm/medium to body/semibold so it reads as a
          real section heading, not a sub-row label. */}
      <div className="text-body font-semibold text-zinc-300">
        {t(labelKey)}
      </div>

      {/* Stepper row: -1s -0.1s  [INPUT]  +0.1s +1s */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <StepperButton label="-1s"   onStep={() => onDelta(-1)} />
          <StepperButton label="-0.1s" onStep={() => onDelta(-0.1)} />
        </div>
        <div className="flex-1 flex justify-center">
          {/* Reuses Step2's row TimeInput so format / parse / Enter-commit
              behaviour stays identical between the inline cell editor and
              this dialog field. */}
          <TimeInput
            value={roundCs(valueSec)}
            onChange={(sec) => onSetSec(roundCs(sec))}
            className="h-9 w-[140px] text-body"
          />
        </div>
        <div className="flex items-center gap-1">
          <StepperButton label="+0.1s" onStep={() => onDelta(0.1)} />
          <StepperButton label="+1s"   onStep={() => onDelta(1)} />
        </div>
      </div>

      {/* Quick-set actions: playhead + ordered snap items */}
      {(playheadSec !== null || snapItems.length > 0) && (
        <div className="space-y-1.5">
          {playheadSec !== null && (
            <SnapButton
              icon={<Play className="h-3.5 w-3.5" />}
              label={t('dialog.timeEditor.setFromPlayhead')}
              trailingLabel={`${t('dialog.timeEditor.currentPlayhead')}: ${formatHHMMSSCC(playheadSec)}`}
              onClick={() => onSetSec(roundCs(playheadSec))}
            />
          )}

          {snapItems.map((item) => {
            const time = formatHHMMSSCC(item.sec)
            const handler = () => onSetSec(roundCs(item.sec))
            switch (item.kind) {
              case 'prevStart':
                return (
                  <SnapButton
                    key="prevStart"
                    icon={<SkipBack className="h-3.5 w-3.5" />}
                    label={t('dialog.timeEditor.setFromPrevStart')}
                    trailingLabel={time}
                    onClick={handler}
                  />
                )
              case 'prevEnd':
                return (
                  <SnapButton
                    key="prevEnd"
                    icon={<SkipBack className="h-3.5 w-3.5" />}
                    label={t('dialog.timeEditor.setFromPrevEnd')}
                    trailingLabel={time}
                    onClick={handler}
                  />
                )
              case 'nextStart':
                return (
                  <SnapButton
                    key="nextStart"
                    icon={<SkipForward className="h-3.5 w-3.5" />}
                    label={t('dialog.timeEditor.setFromNextStart')}
                    trailingLabel={time}
                    onClick={handler}
                  />
                )
              case 'nextEnd':
                return (
                  <SnapButton
                    key="nextEnd"
                    icon={<SkipForward className="h-3.5 w-3.5" />}
                    label={t('dialog.timeEditor.setFromNextEnd')}
                    trailingLabel={time}
                    onClick={handler}
                  />
                )
              case 'selectedStart':
                return (
                  <SnapButton
                    key="selectedStart"
                    label={t('dialog.timeEditor.setFromSelectedStart')}
                    trailingLabel={time}
                    onClick={handler}
                  />
                )
              case 'selectedEnd':
                return (
                  <SnapButton
                    key="selectedEnd"
                    label={t('dialog.timeEditor.setFromSelectedEnd')}
                    trailingLabel={time}
                    onClick={handler}
                  />
                )
            }
          })}
        </div>
      )}
    </div>
  )
}

export function TimeEditorDialog({
  open,
  mode,
  initialStartSec,
  initialEndSec,
  prevEntryStartSec,
  prevEntryEndSec,
  nextEntryStartSec,
  nextEntryEndSec,
  selectedEntryStartSec,
  selectedEntryEndSec,
  videoCurrentTimeSec,
  onConfirm,
  onCancel
}: TimeEditorDialogProps) {
  const { t } = useTranslation(['step2', 'common'])

  // Local working copy.  Reset every time the dialog opens so re-opening
  // for a different entry shows the fresh values, not stale state.
  const [startSec, setStartSec] = useState(initialStartSec)
  const [endSec, setEndSec] = useState(initialEndSec)

  useEffect(() => {
    if (open) {
      setStartSec(initialStartSec)
      setEndSec(initialEndSec)
    }
    // initialStartSec / initialEndSec deliberately excluded — we only want
    // the reset on the open transition, not on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const updateStart = (delta: number) => {
    setStartSec((s) => Math.max(0, roundCs(s + delta)))
  }
  const updateEnd = (delta: number) => {
    setEndSec((s) => Math.max(0, roundCs(s + delta)))
  }
  const setStartTo = (sec: number) => setStartSec(Math.max(0, sec))
  const setEndTo = (sec: number) => setEndSec(Math.max(0, sec))

  // Per-field snap-target list — FIXED order, not time-sorted.
  //
  // Rationale: button positions must not move depending on the underlying
  // times.  A user who learns "selected row start is the 4th button" should
  // be able to rely on that position regardless of how the times compare.
  //
  // Start section: prevStart → prevEnd → selectedStart → selectedEnd
  // End section:   selectedStart → selectedEnd → nextStart → nextEnd
  //
  // The "selected row" targets only appear in add mode — in edit mode they
  // would be the entry being edited, making the action a no-op.
  const startSnapItems: SnapItem[] = useMemo(() => {
    const items: SnapItem[] = []
    if (prevEntryStartSec !== null) items.push({ kind: 'prevStart', sec: prevEntryStartSec })
    if (prevEntryEndSec !== null) items.push({ kind: 'prevEnd', sec: prevEntryEndSec })
    if (mode === 'add' && selectedEntryStartSec !== null) items.push({ kind: 'selectedStart', sec: selectedEntryStartSec })
    if (mode === 'add' && selectedEntryEndSec !== null) items.push({ kind: 'selectedEnd', sec: selectedEntryEndSec })
    return items
  }, [mode, prevEntryStartSec, prevEntryEndSec, selectedEntryStartSec, selectedEntryEndSec])

  const endSnapItems: SnapItem[] = useMemo(() => {
    const items: SnapItem[] = []
    if (mode === 'add' && selectedEntryStartSec !== null) items.push({ kind: 'selectedStart', sec: selectedEntryStartSec })
    if (mode === 'add' && selectedEntryEndSec !== null) items.push({ kind: 'selectedEnd', sec: selectedEntryEndSec })
    if (nextEntryStartSec !== null) items.push({ kind: 'nextStart', sec: nextEntryStartSec })
    if (nextEntryEndSec !== null) items.push({ kind: 'nextEnd', sec: nextEntryEndSec })
    return items
  }, [mode, nextEntryStartSec, nextEntryEndSec, selectedEntryStartSec, selectedEntryEndSec])

  const titleKey = mode === 'add'
    ? 'dialog.timeEditor.title.add'
    : 'dialog.timeEditor.title.edit'
  const confirmKey = mode === 'add'
    ? 'dialog.timeEditor.add'
    : 'dialog.timeEditor.apply'

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => { if (!o) onCancel() }}
    >
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t(titleKey)}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <TimeField
            labelKey="dialog.timeEditor.startTime"
            valueSec={startSec}
            onDelta={updateStart}
            playheadSec={videoCurrentTimeSec}
            onSetSec={setStartTo}
            snapItems={startSnapItems}
          />
          <TimeField
            labelKey="dialog.timeEditor.endTime"
            valueSec={endSec}
            onDelta={updateEnd}
            playheadSec={videoCurrentTimeSec}
            onSetSec={setEndTo}
            snapItems={endSnapItems}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" size="md" onClick={onCancel}>
            {t('dialog.timeEditor.cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => onConfirm(roundCs(startSec), roundCs(endSec))}
          >
            {t(confirmKey)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
