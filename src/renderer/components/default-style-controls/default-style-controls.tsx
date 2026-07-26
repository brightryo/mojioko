import { useTranslation } from 'react-i18next'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { ShadowDepthSlider } from '@/components/subtitle-table/shadow-depth-slider'
import { FadeDurationSlider } from '@/components/subtitle-table/fade-duration-slider'
import { NumberStepperInput } from '@/components/subtitle-table/number-stepper-input'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX, MARGIN_V_MIN_PX, MARGIN_V_MAX_PX } from '../../../shared/constants'
import { canUseKaraokeInTier, KARAOKE_DEFAULT_HIGHLIGHT_COLOR } from '../../../shared/karaoke-gate'
import type { TranscriptionDefaults } from '../../../shared/types'

/**
 * REQ-088 #2 — font-size step for the ± chevron buttons.  10 px matches
 * the convention requested in REQ-088 and is the same magnitude the
 * inspector's per-row size stepper uses, so the two surfaces feel
 * consistent.
 */
const FONT_SIZE_STEP_PX = 10

/**
 * REQ-0296 §1 — right-column width for every row's control.  A single
 * class shared across every row keeps slider bars and stepper widths
 * visually aligned (previous layout let each control size itself,
 * which made the shadow / fade sliders look ~2× wider than outline
 * width).  `w-48` (=12rem, 192px) is the same footprint as the
 * inspector's `w-[50%]` when the inspector column is ~380px, so
 * inspector and settings surfaces read as siblings.
 */
const CONTROL_COL_CLASS = 'w-48 shrink-0'

/**
 * REQ-0296 §1 — shared row shape for the "字幕スタイル" tab, cloned
 * from `AdvancedParamRow` in `whisper-advanced-controls.tsx` (the
 * "Whisper設定" tab the owner referenced as the canonical layout).
 * Label on the left, dashed filler in the middle, control on the
 * right — same visual rhythm across both settings tabs so switching
 * between them doesn't require the user to relearn the grid.
 */
function StyleRow({
  label,
  help,
  children,
}: {
  label: string
  help?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 -mx-2 hover:bg-accent/40 transition-colors duration-150">
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="text-body text-muted-foreground">{label}</span>
        {help !== undefined && (
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <span className="inline-flex cursor-help text-muted-foreground/60 hover:text-muted-foreground transition-colors duration-150">
                <HelpCircle className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[280px] text-left">
              {help}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="flex-1 border-t border-dashed border-border min-w-[16px]" />
      <div className={CONTROL_COL_CLASS}>{children}</div>
    </div>
  )
}

interface DefaultStyleControlsProps {
  /**
   * REQ-0295 — consolidated TranscriptionDefaults object.  Both call
   * sites already hold this object (SubtitleStyleDialog reads
   * projectStore.defaults; Settings dialog reads
   * settingsStore.transcriptionDefaults), so passing it whole avoids
   * the discrete-prop explosion that adding every REQ-0295 field
   * individually would cause.
   */
  defaults: TranscriptionDefaults
  /**
   * Updates one or more TranscriptionDefaults fields.  Same shape at
   * both call sites: `projectStore.setDefaults` /
   * `settingsStore.updateTranscriptionDefaults` both accept
   * `Partial<TranscriptionDefaults>`.
   */
  onUpdateDefaults: (patch: Partial<TranscriptionDefaults>) => void
  /**
   * `autoLineBreak` lives on `settingsStore` directly (not inside
   * `TranscriptionDefaults`) because it drives Step 1's post-
   * transcription line-wrap pass rather than a per-cue style field.
   */
  autoLineBreak: boolean
  onSetAutoLineBreak: (v: boolean) => void
  /**
   * REQ-0295 §1 「フェード」— fade duration default for new cues.
   * Lives on `settingsStore.fadeDurationSec` (single source of
   * truth); the General tab exposes the same slider.  Exposed here
   * too so the user can set every "style" default from a single
   * screen.
   */
  fadeDurationSec: number
  onSetFadeDurationSec: (v: number) => void
  /**
   * REQ-0295 — tier gate for the karaoke default row.  Karaoke is
   * paid-only (`canUseKaraokeInTier(isMsix)`); hiding the row on
   * free tier keeps the "no free-tier state can be created" invariant
   * from REQ-0286 §0.
   */
  isMsix: boolean
}

/**
 * Default-style controls shared by Step 1's SubtitleStyleDialog and the
 * Settings dialog's "字幕スタイル" tab.  REQ-0295 grew this from the
 * original 4 fields into the full inspector-parity list minus
 * font/weight/text (owned by the Fonts tab) and background (owner
 * declined 2026-07-26).  REQ-0296 §1 rewrote the layout from stacked
 * `[label above / control below]` to `[label | control]` rows so it
 * matches the "Whisper設定" tab; every slider now sits in the same
 * `CONTROL_COL_CLASS` right column so bar widths are visually equal.
 *
 * The component stays presentational: no store subscription, no local
 * draft.  Every control commits through `onUpdateDefaults` (or the
 * paired autoLineBreak / fadeDurationSec setters) so the callers own
 * where the value goes.
 *
 * REQ-0293 final shape enforced:
 *   - Shadow: single 0–50 slider, 0=OFF (no separate Switch).
 *   - Karaoke: Switch + highlight ColorPicker on ONE row, both
 *     always visible (REQ-0296 §2 unification).  Base = textColor
 *     always, no per-cue base override.
 */
export function DefaultStyleControls({
  defaults,
  onUpdateDefaults,
  autoLineBreak,
  onSetAutoLineBreak,
  fadeDurationSec,
  onSetFadeDurationSec,
  isMsix,
}: DefaultStyleControlsProps) {
  const { t } = useTranslation(['step1', 'step2', 'common'])
  const showKaraokeUi = canUseKaraokeInTier(isMsix)

  const segButton = (selected: boolean) => cn(
    'px-2 h-7 rounded border text-body-sm transition-colors duration-150',
    selected
      ? 'border-primary text-fg-primary bg-primary/10'
      : 'border-line-strong text-fg-secondary hover:text-fg-primary hover:bg-surface-2',
  )

  return (
    <div className="space-y-0.5">
      <StyleRow label={t('subtitleDefaults.size')} help={t('subtitleDefaults.helpSize')}>
        <NumberStepperInput
          value={defaults.fontSizePx}
          min={FONT_SIZE_MIN_PX}
          max={FONT_SIZE_MAX_PX}
          step={FONT_SIZE_STEP_PX}
          onCommit={(v) => onUpdateDefaults({ fontSizePx: v })}
          ariaLabel={t('subtitleDefaults.size')}
          title={t('subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
        />
      </StyleRow>

      <StyleRow label={t('subtitleDefaults.textColor')} help={t('subtitleDefaults.helpTextColor')}>
        <ColorPicker
          value={defaults.textColorHex}
          onChange={(hex) => onUpdateDefaults({ textColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </StyleRow>

      <StyleRow label={t('subtitleDefaults.outlineColor')} help={t('subtitleDefaults.helpOutlineColor')}>
        <ColorPicker
          value={defaults.outlineColorHex}
          onChange={(hex) => onUpdateDefaults({ outlineColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </StyleRow>

      <StyleRow label={t('subtitleDefaults.stroke')} help={t('subtitleDefaults.helpStroke')}>
        <OutlineThicknessSlider
          value={defaults.outlineThicknessPx}
          onCommit={(v) => onUpdateDefaults({ outlineThicknessPx: v })}
          ariaLabel={t('subtitleDefaults.stroke')}
          fullWidth
        />
      </StyleRow>

      {/* Shadow (REQ-0293 final: 0–50 slider, 0=OFF). */}
      <StyleRow label={t('step2:styleCell.shadow')}>
        <ShadowDepthSlider
          value={defaults.shadowDepth ?? 0}
          onCommit={(v) => onUpdateDefaults({
            shadowDepth: v,
            ...(v > 0 && defaults.shadowColor === undefined ? { shadowColor: '#000000' } : {}),
            ...(v > 0 && defaults.shadowAlpha === undefined ? { shadowAlpha: 100 } : {}),
          })}
          ariaLabel={t('step2:styleCell.shadowDepth')}
          fullWidth
        />
      </StyleRow>

      {/* Karaoke (REQ-0293 final + REQ-0296 §2: single row, Switch +
          highlight picker always visible). */}
      {showKaraokeUi && (
        <StyleRow label={t('step2:styleCell.karaokeRowLabel')}>
          <div className="flex items-center gap-2">
            <Switch
              checked={defaults.karaokeEnabled === true}
              onCheckedChange={(v) => onUpdateDefaults({
                karaokeEnabled: v,
                ...(v && defaults.karaokeHighlightColor === undefined
                  ? { karaokeHighlightColor: KARAOKE_DEFAULT_HIGHLIGHT_COLOR }
                  : {}),
              })}
              aria-label={t('step2:styleCell.karaoke')}
            />
            <span className="text-body-sm text-muted-foreground flex-1 min-w-0 truncate">
              {defaults.karaokeEnabled === true ? t('step2:styleCell.karaokeOn') : t('step2:styleCell.karaokeOff')}
            </span>
            <ColorPicker
              value={defaults.karaokeHighlightColor ?? KARAOKE_DEFAULT_HIGHLIGHT_COLOR}
              onChange={(hex) => onUpdateDefaults({ karaokeHighlightColor: hex })}
              swatchOnly
              heading={t('step2:styleCell.karaokeHighlightColor')}
            />
          </div>
        </StyleRow>
      )}

      <StyleRow label={t('step2:styleCell.casing')}>
        <div className="flex items-center gap-2">
          <Switch
            checked={defaults.casing === 'uppercase'}
            onCheckedChange={(v) => onUpdateDefaults({ casing: v ? 'uppercase' : 'none' })}
            aria-label={t('step2:styleCell.casing')}
          />
          <span className="text-body-sm text-muted-foreground truncate">
            {defaults.casing === 'uppercase' ? t('step2:styleCell.casingUppercase') : t('step2:styleCell.casingNone')}
          </span>
        </div>
      </StyleRow>

      <StyleRow label={t('step2:styleCell.rotation')}>
        <NumberStepperInput
          value={defaults.rotation ?? 0}
          min={0}
          max={359}
          step={15}
          onCommit={(v) => onUpdateDefaults({ rotation: ((v % 360) + 360) % 360 })}
          ariaLabel={t('step2:styleCell.rotation')}
        />
      </StyleRow>

      <StyleRow label={t('step2:styleCell.fade')}>
        <FadeDurationSlider
          value={fadeDurationSec}
          onCommit={onSetFadeDurationSec}
          ariaLabel={t('step2:styleCell.fade')}
          fullWidth
        />
      </StyleRow>

      {/* ── Layout section header ── */}
      <div className="pt-2 mt-2 border-t border-border/60">
        <p className="text-label font-medium uppercase tracking-wider text-foreground mb-1 px-2">
          {t('step2:timeline.inspector.layoutSection')}
        </p>

        <StyleRow label={t('step2:styleCell.layoutH')}>
          <div className="flex items-center gap-1">
            {(['left', 'center', 'right'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onUpdateDefaults({ horizontalPosition: v })}
                className={segButton((defaults.horizontalPosition ?? 'center') === v)}
              >
                {t(`step2:subtitlePosition.${v}`)}
              </button>
            ))}
          </div>
        </StyleRow>

        <StyleRow label={t('step2:styleCell.layoutV')}>
          <div className="flex items-center gap-1">
            {(['top', 'center', 'bottom'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => onUpdateDefaults({ verticalPosition: v })}
                className={segButton((defaults.verticalPosition ?? 'bottom') === v)}
              >
                {t(`step2:subtitlePosition.${v}`)}
              </button>
            ))}
          </div>
        </StyleRow>

        <StyleRow label={t('step2:styleCell.marginV')}>
          <NumberStepperInput
            value={defaults.verticalMarginPx ?? 40}
            min={MARGIN_V_MIN_PX}
            max={MARGIN_V_MAX_PX}
            step={10}
            onCommit={(v) => onUpdateDefaults({ verticalMarginPx: v })}
            ariaLabel={t('step2:styleCell.marginV')}
            widthClass="w-16"
          />
        </StyleRow>

        <StyleRow label={t('step2:styleCell.offset')}>
          <div className="flex items-center gap-2">
            <span className="text-body-sm text-fg-tertiary">X</span>
            <NumberStepperInput
              value={defaults.posOffsetX ?? 0}
              min={-9999}
              max={9999}
              step={10}
              onCommit={(v) => onUpdateDefaults({ posOffsetX: v })}
              ariaLabel={t('step2:styleCell.offsetX')}
              widthClass="w-16"
            />
            <span className="text-body-sm text-fg-tertiary">Y</span>
            <NumberStepperInput
              value={defaults.posOffsetY ?? 0}
              min={-9999}
              max={9999}
              step={10}
              onCommit={(v) => onUpdateDefaults({ posOffsetY: v })}
              ariaLabel={t('step2:styleCell.offsetY')}
              widthClass="w-16"
            />
          </div>
        </StyleRow>
      </div>

      {/* Auto line break — separate section per the pre-REQ-0295
          convention (subtitle-formatting flag, not a per-cue style). */}
      <div className="pt-2 mt-2 border-t border-border/60">
        <StyleRow label={t('advanced.autoLineBreak')} help={t('advanced.autoLineBreakHelp')}>
          <div className="flex items-center gap-2">
            <Switch
              checked={autoLineBreak}
              onCheckedChange={(v) => onSetAutoLineBreak(v)}
            />
            <span className="text-body-sm text-muted-foreground">
              {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
            </span>
          </div>
        </StyleRow>
      </div>
    </div>
  )
}
