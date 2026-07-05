import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { ColorPicker } from '@/components/color-picker/color-picker'
import { HelpIcon } from '@/components/help-icon'
import { OutlineThicknessSlider } from '@/components/subtitle-table/outline-thickness-slider'
import { NumberStepperInput } from '@/components/subtitle-table/number-stepper-input'
import { FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX } from '../../../shared/constants'

/**
 * REQ-088 #2 — font-size step for the ± chevron buttons.  10 px matches
 * the convention requested in REQ-088 and is the same magnitude the
 * inspector's per-row size stepper uses, so the two surfaces feel
 * consistent.
 */
const FONT_SIZE_STEP_PX = 10

interface DefaultStyleControlsProps {
  fontSizePx: number
  textColorHex: string
  outlineColorHex: string
  outlineThicknessPx: number
  autoLineBreak: boolean
  /**
   * Updates one or more of the 4 transcription-default style fields.
   * Implementations write these to whichever store owns the defaults
   * (SubtitleStyleDialog currently uses projectStore.defaults; the Settings
   * dialog uses settingsStore.transcriptionDefaults).
   *
   * REQ-20260615-050 — `fadeEnabled` was retired; the per-entry fade
   * duration default lives on `settingsStore.fadeDurationSec` (the
   * General-tab slider), separate from this style-defaults form.
   */
  onUpdateDefaults: (patch: {
    fontSizePx?: number
    textColorHex?: string
    outlineColorHex?: string
    outlineThicknessPx?: number
  }) => void
  /** autoLineBreak lives on settingsStore directly (not inside transcriptionDefaults). */
  onSetAutoLineBreak: (v: boolean) => void
}

/**
 * Six default-style controls — font size, text colour, outline colour,
 * outline thickness, fade toggle, auto line break.  Extracted from the
 * SubtitleStyleDialog form column so the same six controls can also be
 * rendered inside the Settings dialog's "Default style" tab without
 * duplicating markup or i18n keys.
 *
 * The component is purely presentational: it does not subscribe to any
 * store.  Both call sites pass current values + setters that target
 * whichever store they want to write to.  This keeps the "single source
 * of truth" wiring (REQ-016) explicit at each use site rather than baked
 * into the component.
 *
 * Visual output is byte-identical to the previous inline form in
 * `subtitle-style-dialog.tsx:93-206` (verified by code diff).
 */
export function DefaultStyleControls({
  fontSizePx,
  textColorHex,
  outlineColorHex,
  outlineThicknessPx,
  autoLineBreak,
  onUpdateDefaults,
  onSetAutoLineBreak
}: DefaultStyleControlsProps) {
  const { t } = useTranslation(['step1'])

  return (
    <div className="space-y-3">
      {/* Font size — REQ-088 #2: ± chevron stepper replaces the bare
          number input so the Settings dialog matches the inspector /
          bulk-edit field convention.  Step 10 px, clamped to
          [FONT_SIZE_MIN_PX, FONT_SIZE_MAX_PX] by the shared component. */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.size')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpSize')} />
        </div>
        <NumberStepperInput
          value={fontSizePx}
          min={FONT_SIZE_MIN_PX}
          max={FONT_SIZE_MAX_PX}
          step={FONT_SIZE_STEP_PX}
          onCommit={(v) => onUpdateDefaults({ fontSizePx: v })}
          ariaLabel={t('subtitleDefaults.size')}
          title={t('subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
        />
        {/* REQ-034 #3: surface the clamp range so users know typed values
            outside [min, max] will snap back. */}
        <p className="text-body-sm text-muted-foreground">
          {t('subtitleDefaults.sizeHint', { min: FONT_SIZE_MIN_PX, max: FONT_SIZE_MAX_PX })}
        </p>
      </div>

      {/* Text color */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.textColor')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpTextColor')} />
        </div>
        <ColorPicker
          value={textColorHex}
          onChange={(hex) => onUpdateDefaults({ textColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </div>

      {/* Outline color */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.outlineColor')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpOutlineColor')} />
        </div>
        <ColorPicker
          value={outlineColorHex}
          onChange={(hex) => onUpdateDefaults({ outlineColorHex: hex })}
          onPairApply={(text, outline) =>
            onUpdateDefaults({ textColorHex: text, outlineColorHex: outline })
          }
        />
      </div>

      {/* Outline thickness — shared slider component (same as Step 2
          per-row + bulk-edit, so the look and commit semantics stay
          aligned across surfaces). */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('subtitleDefaults.stroke')}</Label>
          <HelpIcon content={t('subtitleDefaults.helpStroke')} />
        </div>
        <OutlineThicknessSlider
          value={outlineThicknessPx}
          onCommit={(v) => onUpdateDefaults({ outlineThicknessPx: v })}
          ariaLabel={t('subtitleDefaults.stroke')}
        />
      </div>

      {/* REQ-20260615-050 — the legacy fade Switch was retired here.
          Fade duration default for new entries is now driven by the
          Settings dialog's General-tab `FadeDurationSlider`
          (`settingsStore.fadeDurationSec`), separate from this style
          defaults form. */}

      {/* Auto line break — subtitle-formatting decision (post-
          transcription), so it lives here rather than in the engine
          Advanced dialog.  Toggling immediately re-wraps the preview
          on the right. */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-1">
          <Label>{t('advanced.autoLineBreak')}</Label>
          <HelpIcon content={t('advanced.autoLineBreakHelp')} />
        </div>
        <div className="flex items-center gap-2 h-9">
          <Switch
            checked={autoLineBreak}
            onCheckedChange={(v) => onSetAutoLineBreak(v)}
          />
          <span className="text-body-sm text-muted-foreground">
            {autoLineBreak ? t('advanced.enabled') : t('advanced.disabled')}
          </span>
        </div>
      </div>
    </div>
  )
}
