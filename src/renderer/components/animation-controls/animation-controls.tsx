import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { StyleRow, styleRowColumns, type StyleRowSurface } from '@/components/subtitle-table/style-row'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  ANIMATION_BLUR_MAX_PX,
  ANIMATION_BLUR_MIN_PX,
  ANIMATION_BLUR_STEP_PX,
  ANIMATION_DURATION_MAX_SEC,
  ANIMATION_DURATION_MIN_SEC,
  ANIMATION_DURATION_STEP_SEC,
  ANIMATION_START_SCALE_MAX_PCT,
  ANIMATION_START_SCALE_MIN_PCT,
  ANIMATION_START_SCALE_STEP_PCT,
  BLUR_MAX_PX,
  SELECTABLE_ANIMATION_TYPES,
  coerceAnimationType,
  defaultStartScalePercent,
  type AnimationType,
} from '../../../shared/cue-animation'

/**
 * REQ-0324 §1 / REQ-0331 §1 — the animation controls, shared verbatim by
 * the inspector (per-cue), the bulk-edit bar (applies to the selection)
 * and the settings 「字幕スタイル」 tab (defaults for new cues).
 *
 * One component rather than three copies because the surfaces have
 * drifted before: REQ-0292 §2 found the bulk rotation stepper hardcoded to
 * `value={0}` while the inspector's was wired, and REQ-0308 §3 had to
 * remove a bulk emphasis row that never did anything.  A shared component
 * cannot develop that class of asymmetry.
 *
 * REQ-0331 §1-1 restructured the two cramped rows into four labelled ones.
 * The old layout put the type `Select` and both switches on ONE row inside
 * the ~150–224 px control column, which squeezed the trigger down to about
 * 60 px — the selected value rendered as "ス…".  A control whose current
 * value cannot be read is not a control:
 *
 *   種類        [ アニメーション種類            ▼ ]
 *   タイミング   開始時 [ ]  終了時 [ ]
 *   再生時間     [ ────●──── ]  0.4s
 *   強さ        [ ────●──── ]   70%
 *
 * Each row is its own `StyleRow`, so every control lands in the same
 * column as every other row in the section at every pane width.
 */
export interface AnimationControlsValue {
  type: AnimationType
  inEnabled: boolean
  outEnabled: boolean
  durationSec: number
  /** REQ-0331 §1-3 — 強さ for `scale` / `pop` (percent of natural size). */
  startScalePercent: number
  /** REQ-0331 §1-3 — 強さ for `blur` (peak radius, ASS px). */
  blurPx: number
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
  /**
   * REQ-0333 §3 — which surface is rendering these rows.  This used to be
   * `labelVariant`, which only carried the label TYPOGRAPHY; the column
   * WIDTHS silently stayed at the inspector defaults.  In the settings
   * dialog, where every neighbouring row goes through `SettingsStyleRow`'s
   * 288-px column, that left the four animation rows on a different
   * vertical from the rows above and below them.  Taking the surface (and
   * running it through `styleRowColumns`) means these rows go through the
   * same width calculation as their neighbours, by construction.
   */
  surface?: StyleRowSurface
}

const STEP_COUNT = Math.round(
  (ANIMATION_DURATION_MAX_SEC - ANIMATION_DURATION_MIN_SEC) / ANIMATION_DURATION_STEP_SEC,
)

/**
 * REQ-0331 §1-2 — the shared `<input type=range>` shell.
 *
 * The duration slider used to carry the Tailwind class `accent-accent`,
 * which resolves to the *`--accent`* design token — the muted hover
 * surface colour, near-black in this theme — so the bar rendered dark
 * while every other slider in the app is green.  `OutlineThicknessSlider`,
 * `ShadowDepthSlider` and `FadeDurationSlider` all use the inline
 * `accentColor: hsl(var(--primary))` instead; this matches them exactly,
 * including the readout cell's width / font, so the bars line up.
 */
function AnimationSlider({
  min, max, step, value, onDraft, onCommit, disabled, ariaLabel, readout,
}: {
  min: number
  max: number
  step: number
  value: number
  onDraft: (n: number) => void
  onCommit: () => void
  disabled?: boolean
  ariaLabel: string
  readout: string
}) {
  return (
    <div className={cn('flex items-center gap-1.5 w-full', disabled && 'opacity-40')}>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => onDraft(Number(e.target.value))}
        onMouseUp={onCommit}
        onKeyUp={onCommit}
        onTouchEnd={onCommit}
        className="flex-1 min-w-0"
        style={{ accentColor: 'hsl(var(--primary))' }}
      />
      <span className="w-10 text-caption text-muted-foreground font-mono tabular-nums text-right shrink-0">
        {readout}
      </span>
    </div>
  )
}

export function AnimationControls({
  value, onChange, disabled, includeBlur, surface = 'inspector',
}: AnimationControlsProps) {
  const { t } = useTranslation('step2')
  // REQ-0333 §3 — one lookup, spread onto all four rows, so the rows
  // cannot individually drift from the surface they are rendered into.
  const columns = styleRowColumns(surface)

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

  // Strength drafts.  Two separate fields (not one polymorphic number)
  // because the unit differs per type — see `cue-animation.ts`.
  const [scaleDraft, setScaleDraft] = useState(value.startScalePercent)
  const [blurDraft, setBlurDraft] = useState(value.blurPx)
  const scaleInteracting = useRef(false)
  const blurInteracting = useRef(false)
  useEffect(() => {
    if (!scaleInteracting.current) setScaleDraft(value.startScalePercent)
  }, [value.startScalePercent])
  useEffect(() => {
    if (!blurInteracting.current) setBlurDraft(value.blurPx)
  }, [value.blurPx])

  // `none` disables the rest of the rows: there is nothing for the
  // switches or the duration to act on.
  const inert = value.type === 'none'
  const rowDisabled = disabled || inert
  // REQ-0331 §1-3 — `fade` has no strength: it is fully described by its
  // duration.  Greyed out rather than removed so the four rows keep the
  // same height whichever type is picked (no layout jump on change).
  const isBlurStrength = value.type === 'blur'
  const strengthDisabled = rowDisabled || (value.type !== 'blur' && value.type !== 'scale' && value.type !== 'pop')

  const types = includeBlur
    ? SELECTABLE_ANIMATION_TYPES
    : SELECTABLE_ANIMATION_TYPES.filter((ty) => ty !== 'blur')

  const commitDuration = () => {
    const next = stepToSeconds(draft)
    if (next !== value.durationSec) onChange({ durationSec: next })
  }
  const commitScale = () => {
    scaleInteracting.current = false
    if (scaleDraft !== value.startScalePercent) onChange({ startScalePercent: scaleDraft })
  }
  const commitBlur = () => {
    blurInteracting.current = false
    if (blurDraft !== value.blurPx) onChange({ blurPx: blurDraft })
  }

  /**
   * Changing the type re-seeds the strength to that type's own default.
   * Without this, picking `pop` on a cue that had been a `scale` would
   * inherit start-scale 70 % and produce a "pop" that starts nearly full
   * size — i.e. not a pop at all.  The defaults come from
   * `defaultStartScalePercent`, the same function `resolveAnimation` uses
   * for an absent field, so the seeded value and the implicit value agree.
   */
  const handleTypeChange = (raw: string) => {
    const type = coerceAnimationType(raw)
    if (type === value.type) return
    const nextScale = defaultStartScalePercent(type)
    setScaleDraft(nextScale)
    setBlurDraft(BLUR_MAX_PX)
    onChange({ type, startScalePercent: nextScale, blurPx: BLUR_MAX_PX })
  }

  return (
    <>
      {/* 種類 — full-width trigger so the selected value is never elided. */}
      <StyleRow
        label={t('styleCell.animationTypeLabel')}
        {...columns}
        stopControlClickPropagation
      >
        <Select value={value.type} onValueChange={handleTypeChange} disabled={disabled}>
          <SelectTrigger className="h-8 w-full min-w-0" aria-label={t('styleCell.animationTypeLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {types.map((ty) => (
              <SelectItem key={ty} value={ty}>{t(`styleCell.animationType.${ty}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </StyleRow>

      {/* タイミング — which ends of the cue animate. */}
      <StyleRow
        label={t('styleCell.animationTimingLabel')}
        {...columns}
        stopControlClickPropagation
      >
        <div className={cn('flex items-center gap-4 min-w-0', rowDisabled && 'opacity-50')}>
          <label className="flex items-center gap-1.5 min-w-0">
            <span className="text-caption2 text-fg-tertiary truncate">{t('styleCell.animationIn')}</span>
            <Switch
              checked={value.inEnabled}
              onCheckedChange={(v) => onChange({ inEnabled: v })}
              disabled={rowDisabled}
              aria-label={t('styleCell.animationIn')}
            />
          </label>
          <label className="flex items-center gap-1.5 min-w-0">
            <span className="text-caption2 text-fg-tertiary truncate">{t('styleCell.animationOut')}</span>
            <Switch
              checked={value.outEnabled}
              onCheckedChange={(v) => onChange({ outEnabled: v })}
              disabled={rowDisabled}
              aria-label={t('styleCell.animationOut')}
            />
          </label>
        </div>
      </StyleRow>

      {/* 再生時間 */}
      <StyleRow
        label={t('styleCell.animationDurationLabel')}
        {...columns}
        stopControlClickPropagation
      >
        <AnimationSlider
          min={0}
          max={STEP_COUNT}
          step={1}
          value={draft}
          onDraft={setDraft}
          onCommit={commitDuration}
          disabled={rowDisabled}
          ariaLabel={t('styleCell.animationDuration')}
          readout={`${stepToSeconds(draft).toFixed(1)}s`}
        />
      </StyleRow>

      {/* 強さ — meaning depends on the type (REQ-0331 §1-3). */}
      <StyleRow
        label={t('styleCell.animationStrengthLabel')}
        {...columns}
        stopControlClickPropagation
      >
        {isBlurStrength ? (
          <AnimationSlider
            min={ANIMATION_BLUR_MIN_PX}
            max={ANIMATION_BLUR_MAX_PX}
            step={ANIMATION_BLUR_STEP_PX}
            value={blurDraft}
            onDraft={(n) => { blurInteracting.current = true; setBlurDraft(n) }}
            onCommit={commitBlur}
            disabled={strengthDisabled}
            ariaLabel={t('styleCell.animationStrengthBlur')}
            readout={`${blurDraft}px`}
          />
        ) : (
          <AnimationSlider
            min={ANIMATION_START_SCALE_MIN_PCT}
            max={ANIMATION_START_SCALE_MAX_PCT}
            step={ANIMATION_START_SCALE_STEP_PCT}
            value={scaleDraft}
            onDraft={(n) => { scaleInteracting.current = true; setScaleDraft(n) }}
            onCommit={commitScale}
            disabled={strengthDisabled}
            ariaLabel={t('styleCell.animationStrengthScale')}
            readout={`${scaleDraft}%`}
          />
        )}
      </StyleRow>
    </>
  )
}
