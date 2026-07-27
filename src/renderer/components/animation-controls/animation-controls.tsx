import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { StyleRow, type StyleRowLabelClass } from '@/components/subtitle-table/style-row'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  ANIMATION_DURATION_MAX_SEC,
  ANIMATION_DURATION_MIN_SEC,
  ANIMATION_DURATION_STEP_SEC,
  SELECTABLE_ANIMATION_TYPES,
  coerceAnimationType,
  type AnimationType,
} from '../../../shared/cue-animation'

/**
 * REQ-0324 §1 — the animation controls, shared verbatim by the inspector
 * (per-cue) and the bulk-edit bar (applies to the selection).
 *
 * One component rather than two copies because the two surfaces have
 * drifted before: REQ-0292 §2 found the bulk rotation stepper hardcoded to
 * `value={0}` while the inspector's was wired, and REQ-0308 §3 had to
 * remove a bulk emphasis row that never did anything.  A shared component
 * cannot develop that class of asymmetry.
 *
 * Layout is the two-row form the REQ specifies:
 *
 *   アニメーション …  [種類 ▼]  [入] [出]
 *                     [ ───●─── ] 0.4s
 *
 * The second row is deliberately a SEPARATE `StyleRow` with an empty
 * label rather than a wrapped cell, so the slider lands in the same
 * control column as every other row and the labels stay aligned.
 */
export interface AnimationControlsValue {
  type: AnimationType
  inEnabled: boolean
  outEnabled: boolean
  durationSec: number
}

export interface AnimationControlsProps {
  value: AnimationControlsValue
  /** Commits a partial change (one history op per gesture). */
  onChange: (patch: Partial<AnimationControlsValue>) => void
  disabled?: boolean
  /**
   * REQ-0324 §2 — whether `blur` appears in the type list.  Passed in
   * rather than read from a constant so the decision lives at one place
   * in the app and this component stays dumb.
   */
  includeBlur: boolean
  labelVariant?: StyleRowLabelClass
}

const STEP_COUNT = Math.round(
  (ANIMATION_DURATION_MAX_SEC - ANIMATION_DURATION_MIN_SEC) / ANIMATION_DURATION_STEP_SEC,
)

export function AnimationControls({
  value, onChange, disabled, includeBlur, labelVariant = 'inspector',
}: AnimationControlsProps) {
  const { t } = useTranslation('step2')

  // Draft held as an integer step index for the same reason
  // `FadeDurationSlider` does it: floating-point seconds make the native
  // range thumb drift off the step boundaries mid-drag.
  const secondsToStep = (s: number) =>
    Math.round((s - ANIMATION_DURATION_MIN_SEC) / ANIMATION_DURATION_STEP_SEC)
  const stepToSeconds = (n: number) =>
    +(ANIMATION_DURATION_MIN_SEC + n * ANIMATION_DURATION_STEP_SEC).toFixed(1)

  const [draft, setDraft] = useState(() => secondsToStep(value.durationSec))
  useEffect(() => {
    const incoming = secondsToStep(value.durationSec)
    setDraft((d) => (d === incoming ? d : incoming))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.durationSec])

  // `none` disables the rest of the row: there is nothing for the
  // switches or the duration to act on.
  const inert = value.type === 'none'
  const rowDisabled = disabled || inert

  const types = includeBlur
    ? SELECTABLE_ANIMATION_TYPES
    : SELECTABLE_ANIMATION_TYPES.filter((ty) => ty !== 'blur')

  const commitDuration = () => {
    const next = stepToSeconds(draft)
    if (next !== value.durationSec) onChange({ durationSec: next })
  }

  return (
    <>
      <StyleRow
        label={t('styleCell.animationRowLabel')}
        labelVariant={labelVariant}
        stopControlClickPropagation
      >
        <div className="flex items-center gap-2 min-w-0">
          <Select
            value={value.type}
            onValueChange={(v) => onChange({ type: coerceAnimationType(v) })}
            disabled={disabled}
          >
            <SelectTrigger className="h-8 flex-1 min-w-0" aria-label={t('styleCell.animationRowLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {types.map((ty) => (
                <SelectItem key={ty} value={ty}>{t(`styleCell.animationType.${ty}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 入 / 出 — which ends of the cue animate.  Labelled with short
              text rather than icons because "in/out" has no established
              glyph and the column is narrow. */}
          <label className={cn('flex items-center gap-1 shrink-0', rowDisabled && 'opacity-50')}>
            <span className="text-caption2 text-fg-tertiary">{t('styleCell.animationIn')}</span>
            <Switch
              checked={value.inEnabled}
              onCheckedChange={(v) => onChange({ inEnabled: v })}
              disabled={rowDisabled}
              aria-label={t('styleCell.animationIn')}
            />
          </label>
          <label className={cn('flex items-center gap-1 shrink-0', rowDisabled && 'opacity-50')}>
            <span className="text-caption2 text-fg-tertiary">{t('styleCell.animationOut')}</span>
            <Switch
              checked={value.outEnabled}
              onCheckedChange={(v) => onChange({ outEnabled: v })}
              disabled={rowDisabled}
              aria-label={t('styleCell.animationOut')}
            />
          </label>
        </div>
      </StyleRow>
      {/* Second row: duration.  Empty label keeps the control column
          aligned with every other row in the section. */}
      <StyleRow label="" labelVariant={labelVariant} stopControlClickPropagation>
        <div className={cn('flex items-center gap-2 flex-1 min-w-0', rowDisabled && 'opacity-50')}>
          <input
            type="range"
            min={0}
            max={STEP_COUNT}
            step={1}
            value={draft}
            disabled={rowDisabled}
            aria-label={t('styleCell.animationDuration')}
            onChange={(e) => setDraft(Number(e.target.value))}
            onMouseUp={commitDuration}
            onKeyUp={commitDuration}
            onTouchEnd={commitDuration}
            className="flex-1 min-w-0 accent-accent"
          />
          {/* `min-w-0` + tabular numerals so the readout never clips and
              never reflows as the value changes (REQ-0311 §1). */}
          <span className="text-caption1 tabular-nums text-fg-secondary w-10 shrink-0 text-right">
            {stepToSeconds(draft).toFixed(1)}s
          </span>
        </div>
      </StyleRow>
    </>
  )
}
